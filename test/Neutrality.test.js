const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  Phase,
  DocType,
  CID,
  LC,
  deployTradeChain,
  createOrderAndShipment,
  fundLC,
  futureDeadline,
} = require("./helpers/fixture");

describe("Neutrality & timeout safeguards", function () {
  const fixture = deployTradeChain;

  describe("reclaimExpiredLC", function () {
    it("reverts before the deadline", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await expect(env.core.connect(env.buyer).reclaimExpiredLC(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "DeadlineNotReached"
      );
    });

    it("only the buyer, issuing bank or admin may reclaim", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);

      await expect(env.core.connect(env.outsider).reclaimExpiredLC(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "NotReclaimAuthority"
      );
      await expect(env.core.connect(env.verifier).reclaimExpiredLC(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "NotReclaimAuthority"
      );
    });

    it("refunds the buyer after expiry when the seller never shipped", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);

      const coreAddr = await env.core.getAddress();
      expect(await env.token.balanceOf(coreAddr)).to.equal(LC);

      const { deadline } = await env.core.getShipment(shipmentId);
      await time.increaseTo(Number(deadline) + 1);
      const before = await env.token.balanceOf(env.buyer.address);
      await expect(env.core.connect(env.buyer).reclaimExpiredLC(shipmentId)).to.emit(env.core, "LCReclaimed");

      expect(await env.token.balanceOf(env.buyer.address)).to.equal(before + LC);
      expect((await env.core.getShipment(shipmentId)).phase).to.equal(Phase.Reclaimed);
    });

    it("lets the issuing bank reclaim on the buyer's behalf", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      await expect(env.core.connect(env.issuingBank).reclaimExpiredLC(shipmentId)).to.not.be.reverted;
    });

    it("refunds duty to its payer on reclaim", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.buyer).payCustomsDuty(shipmentId, 10n);
      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      const before = await env.token.balanceOf(env.buyer.address);
      await env.core.connect(env.buyer).reclaimExpiredLC(shipmentId);
      // L/C (LC) + duty (10) returned to the buyer (payer).
      expect(await env.token.balanceOf(env.buyer.address)).to.equal(before + LC + 10n);
    });

    it("cannot reclaim once the seller has shipped (risk has moved)", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.carrier).confirmPickup(shipmentId);

      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      await expect(env.core.connect(env.buyer).reclaimExpiredLC(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "NothingToReclaim"
      );
    });
  });

  describe("forceFinalizeDelivery", function () {
    it("rejects non-bank callers", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, shipmentId);
      await expect(env.core.connect(env.outsider).forceFinalizeDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
    });

    it("reverts until the shipment is on the vessel", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, shipmentId);
      await expect(env.core.connect(env.issuingBank).forceFinalizeDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
    });

    it("lets either bank finalize a stalled DDP shipment once docs + duty are complete", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, shipmentId);

      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.seller).anchorDocument(shipmentId, DocType.CertificateOfOrigin, CID.coo);
      await env.core.connect(env.carrier).confirmPickup(shipmentId);
      await env.core.connect(env.carrier).confirmVesselLoading(shipmentId, CID.bl);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.CustomsClearance, CID.clearance);
      await env.core.connect(env.seller).payCustomsDuty(shipmentId, 0);

      // The Buyer refuses to confirm: the advising bank finalizes instead.
      const before = await env.token.balanceOf(env.seller.address);
      await expect(env.core.connect(env.advisingBank).forceFinalizeDelivery(shipmentId))
        .to.emit(env.core, "DeliveryForceFinalized")
        .and.to.emit(env.core, "AtomicLCPayoutExecuted");

      expect(await env.token.balanceOf(env.seller.address)).to.equal(before + LC);
      expect((await env.core.getShipment(shipmentId)).phase).to.equal(Phase.Settled);
      expect(await env.ebl.ownerOf(shipmentId)).to.equal(env.buyer.address);
    });

    it("releases the title for an already-paid term if the buyer stalls", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.carrier).confirmPickup(shipmentId);
      await env.core.connect(env.carrier).confirmVesselLoading(shipmentId, CID.bl); // pays out (FOB)

      await env.core.connect(env.issuingBank).forceFinalizeDelivery(shipmentId);
      const s = await env.core.getShipment(shipmentId);
      expect(s.phase).to.equal(Phase.Settled);
      expect(await env.ebl.ownerOf(shipmentId)).to.equal(env.buyer.address);
    });
  });
});
