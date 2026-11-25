const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  PaymentTerm,
  Phase,
  Custody,
  DocType,
  CID,
  LC,
  UNIT,
  deployTradeChain,
  futureDeadline,
  createOrderAndShipment,
  toPresentable,
  present,
  honor,
} = require("./helpers/fixture");

describe("Neutrality & timeout safeguards", function () {
  const fixture = deployTradeChain;

  describe("reclaimExpiredLC", function () {
    async function applyAndIssue(env, opts = {}) {
      const deadline = opts.deadline || (await futureDeadline());
      await env.core
        .connect(env.importer)
        .createOrder(
          env.exporter.address,
          opts.term ?? Incoterm.FOB,
          opts.lcAmount ?? LC,
          deadline,
          opts.paymentTerm ?? PaymentTerm.Sight,
          opts.deferredDays ?? 0n
        );
      const orderId = await env.core.orderCount();
      await env.core.connect(env.bank).issueLetterOfCredit(orderId);
      return orderId;
    }

    it("reverts before the deadline", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env);
      await expect(env.core.connect(env.importer).reclaimExpiredLC(orderId)).to.be.revertedWithCustomError(
        env.loc,
        "DeadlineNotReached"
      );
    });

    it("only the importer, bank or admin may reclaim", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env);

      await expect(env.core.connect(env.outsider).reclaimExpiredLC(orderId)).to.be.revertedWithCustomError(
        env.core,
        "NotReclaimAuthority"
      );
      await expect(env.core.connect(env.verifier).reclaimExpiredLC(orderId)).to.be.revertedWithCustomError(
        env.core,
        "NotReclaimAuthority"
      );
    });

    it("returns the unused expired funds to the issuing bank — not to the importer", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env);

      const locAddr = await env.loc.getAddress();
      expect(await env.token.balanceOf(locAddr)).to.equal(LC);

      const { deadline } = await env.core.getShipment(orderId);
      await time.increaseTo(Number(deadline) + 1);
      const bankBefore = await env.token.balanceOf(env.bank.address);
      const importerBefore = await env.token.balanceOf(env.importer.address);

      await expect(env.core.connect(env.bank).reclaimExpiredLC(orderId))
        .to.emit(env.core, "LCReclaimed")
        .withArgs(orderId, env.bank.address, LC, 0n);

      expect(await env.token.balanceOf(env.bank.address)).to.equal(bankBefore + LC);
      expect(await env.token.balanceOf(env.importer.address)).to.equal(importerBefore); // untouched
      expect((await env.core.getShipment(orderId)).phase).to.equal(Phase.Reclaimed);
      expect((await env.core.getLC(orderId)).reclaimed).to.equal(true);
    });

    it("lets the admin reclaim on the bank's behalf", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env);
      await time.increaseTo(Number((await env.core.getShipment(orderId)).deadline) + 1);
      await expect(env.core.connect(env.admin).reclaimExpiredLC(orderId)).to.not.be.reverted;
    });

    it("a presented credit was used: it cannot be reclaimed, only honored", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env);
      await env.core.connect(env.exporter).createShipment(orderId, CID.invoice, CID.packing);
      await toPresentable(env, orderId);
      await present(env, orderId);

      await time.increaseTo(Number((await env.core.getShipment(orderId)).deadline) + 1);
      await expect(env.core.connect(env.importer).reclaimExpiredLC(orderId)).to.be.revertedWithCustomError(
        env.loc,
        "CreditPresented"
      );
    });

    it("an honored credit cannot be reclaimed (deferred proceeds are owed to the beneficiary)", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env, { paymentTerm: PaymentTerm.Deferred, deferredDays: 1n });
      await env.core.connect(env.exporter).createShipment(orderId, CID.invoice, CID.packing);
      await toPresentable(env, orderId);
      await present(env, orderId);
      await honor(env, orderId);

      await time.increaseTo(Number((await env.core.getShipment(orderId)).deadline) + 1);
      await expect(env.core.connect(env.bank).reclaimExpiredLC(orderId)).to.be.revertedWithCustomError(
        env.loc,
        "AlreadyHonored"
      );
    });

    it("shipped but never presented: the credit is reclaimed to the bank and the title returns to the exporter", async function () {
      const env = await loadFixture(fixture);
      const orderId = await applyAndIssue(env);
      await env.core.connect(env.exporter).createShipment(orderId, CID.invoice, CID.packing);
      expect(await env.nft.ownerOf(orderId)).to.equal(await env.core.getAddress());

      await time.increaseTo(Number((await env.core.getShipment(orderId)).deadline) + 1);
      await expect(env.core.connect(env.bank).reclaimExpiredLC(orderId)).to.emit(env.core, "TitleTransferred");

      const s = await env.core.getShipment(orderId);
      expect(s.phase).to.equal(Phase.Reclaimed);
      expect(s.custody).to.equal(Custody.AtExporter);
      expect(s.riskHolder).to.equal(env.exporter.address);
      expect(await env.nft.ownerOf(orderId)).to.equal(env.exporter.address);
      expect(await env.token.balanceOf(await env.loc.getAddress())).to.equal(0n);
    });

    it("refunds escrowed duty to its payer when an unused credit is reclaimed", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      const duty = 120n * UNIT;
      await env.core.connect(env.exporter).payCustomsDuty(shipmentId, duty); // shipped, never presented

      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      const bankBefore = await env.token.balanceOf(env.bank.address);
      const payerBefore = await env.token.balanceOf(env.exporter.address);

      await expect(env.core.connect(env.importer).reclaimExpiredLC(shipmentId))
        .to.emit(env.core, "LCReclaimed")
        .withArgs(shipmentId, env.bank.address, LC, duty);

      expect(await env.token.balanceOf(env.bank.address)).to.equal(bankBefore + LC);
      expect(await env.token.balanceOf(env.exporter.address)).to.equal(payerBefore + duty);
      expect(await env.token.balanceOf(await env.loc.getAddress())).to.equal(0n);
    });

    it("cannot reclaim once the beneficiary has presented (even with custody complete)", async function () {
      const env = await loadFixture(fixture);
      const { orderId, shipmentId } = await (async () => {
        const r = await createOrderAndShipment(env, { term: Incoterm.FOB });
        return { orderId: r.orderId, shipmentId: r.shipmentId };
      })();
      await toPresentable(env, shipmentId);
      await present(env, shipmentId);

      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      await expect(env.core.connect(env.importer).reclaimExpiredLC(orderId)).to.be.revertedWithCustomError(
        env.loc,
        "CreditPresented"
      );
    });
  });

  describe("forceFinalizeDelivery", function () {
    it("rejects non-bank callers", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await expect(env.core.connect(env.outsider).forceFinalizeDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts until the shipment is on the vessel", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await expect(env.core.connect(env.bank).forceFinalizeDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidCustody"
      );
    });

    it("lets the bank finalize a stalled DDP shipment once the documentary gates are met", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await toPresentable(env, shipmentId);
      await env.core.connect(env.exporter).payCustomsDuty(shipmentId, 0);
      await present(env, shipmentId);
      await honor(env, shipmentId); // paid at sight

      await expect(env.core.connect(env.bank).forceFinalizeDelivery(shipmentId))
        .to.emit(env.core, "DeliveryForceFinalized")
        .and.to.emit(env.core, "TitleTransferred");

      const s = await env.core.getShipment(shipmentId);
      expect(s.phase).to.equal(Phase.Settled);
      expect(await env.nft.ownerOf(shipmentId)).to.equal(env.importer.address);
    });

    it("finalizes an unpaid presented credit to Delivered (payment still follows the credit)", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await toPresentable(env, shipmentId);
      await present(env, shipmentId);

      await env.core.connect(env.bank).forceFinalizeDelivery(shipmentId);
      const s = await env.core.getShipment(shipmentId);
      expect(s.phase).to.equal(Phase.Delivered); // not paid yet — honor is a separate bank action
      expect(await env.nft.ownerOf(shipmentId)).to.equal(env.importer.address);
    });
  });

  describe("drawDeferredPayment", function () {
    it("reverts before the credit is honored", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, {
        term: Incoterm.FOB,
        paymentTerm: PaymentTerm.Deferred,
        deferredDays: 2n,
      });
      await toPresentable(env, shipmentId);
      await expect(env.core.connect(env.bank).drawDeferredPayment(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
    });

    it("reverts for an unknown shipment", async function () {
      const env = await loadFixture(fixture);
      await expect(env.core.connect(env.bank).drawDeferredPayment(1234n)).to.be.revertedWithCustomError(
        env.core,
        "ShipmentNotFound"
      );
    });
  });
});
