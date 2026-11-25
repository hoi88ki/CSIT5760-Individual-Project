const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  PaymentTerm,
  Phase,
  DocType,
  CID,
  LC,
  UNIT,
  deployTradeChain,
  futureDeadline,
} = require("./helpers/fixture");

describe("Orders, L/C issuance & shipment creation", function () {
  const fixture = deployTradeChain;

  describe("createOrder (L/C application)", function () {
    it("lets an importer apply for a credit naming the beneficiary and payment terms", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();

      await expect(
        env.core
          .connect(env.importer)
          .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Deferred, 10n)
      )
        .to.emit(env.core, "OrderCreated")
        .withArgs(
          1n,
          env.importer.address,
          env.exporter.address,
          Incoterm.FOB,
          PaymentTerm.Deferred,
          10n,
          LC,
          deadline
        );

      expect(await env.core.orderCount()).to.equal(1n);
      const order = await env.core.getOrder(1n);
      expect(order.importer).to.equal(env.importer.address);
      expect(order.exporter).to.equal(env.exporter.address);
      expect(order.term).to.equal(Incoterm.FOB);
      expect(order.paymentTerm).to.equal(PaymentTerm.Deferred);
      expect(order.deferredDays).to.equal(10n);
      expect(order.lcAmount).to.equal(LC);
      expect(order.deadline).to.equal(deadline);

      // The trade record is opened in OrderPlaced: nothing funded, nothing shipped.
      const s = await env.core.getShipment(1n);
      expect(s.phase).to.equal(Phase.OrderPlaced);
      expect(s.custody).to.equal(0); // AtExporter
      expect(s.riskHolder).to.equal(env.exporter.address);
    });

    it("rejects non-importer callers", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core
          .connect(env.exporter)
          .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("rejects zero exporter, zero amount and non-future deadlines", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core
          .connect(env.importer)
          .createOrder(ethers.ZeroAddress, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n)
      ).to.be.revertedWithCustomError(env.tracker, "ZeroAddress");

      await expect(
        env.core
          .connect(env.importer)
          .createOrder(env.exporter.address, Incoterm.FOB, 0, await futureDeadline(), PaymentTerm.Sight, 0n)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidAmount");

      const past = BigInt(await time.latest()) - 1n;
      await expect(
        env.core
          .connect(env.importer)
          .createOrder(env.exporter.address, Incoterm.FOB, LC, past, PaymentTerm.Sight, 0n)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeadline");
    });

    it("sight credits must request no deferral; deferred credits need a deferral window", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();

      await expect(
        env.core
          .connect(env.importer)
          .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Sight, 5n)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeferral");

      await expect(
        env.core
          .connect(env.importer)
          .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Deferred, 0n)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeferral");

      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Deferred, 5n);
      expect((await env.core.getOrder(1n)).deferredDays).to.equal(5n);
    });
  });

  describe("issueLetterOfCredit (issuing bank)", function () {
    async function apply(env, opts = {}) {
      const deadline = opts.deadline || (await futureDeadline());
      await env.core
        .connect(env.importer)
        .createOrder(
          env.exporter.address,
          opts.term ?? Incoterm.CIF,
          opts.lcAmount ?? LC,
          deadline,
          opts.paymentTerm ?? PaymentTerm.Sight,
          opts.deferredDays ?? 0n
        );
      return await env.core.orderCount();
    }

    it("the issuing bank — not the importer — funds the escrow", async function () {
      const env = await loadFixture(fixture);
      const orderId = await apply(env);

      const locAddr = await env.loc.getAddress();
      const importerBefore = await env.token.balanceOf(env.importer.address);
      const bankBefore = await env.token.balanceOf(env.bank.address);
      const escrowBefore = await env.token.balanceOf(locAddr);

      await expect(env.core.connect(env.bank).issueLetterOfCredit(orderId))
        .to.emit(env.core, "LetterOfCreditIssued")
        .withArgs(orderId, env.bank.address, env.exporter.address, LC, PaymentTerm.Sight, 0n, 0b111011);

      expect(await env.token.balanceOf(locAddr)).to.equal(escrowBefore + LC);
      expect(await env.token.balanceOf(env.bank.address)).to.equal(bankBefore - LC);
      expect(await env.token.balanceOf(env.importer.address)).to.equal(importerBefore); // untouched

      const lc = await env.core.getLC(orderId);
      expect(lc.issued).to.equal(true);
      expect(lc.issuingBank).to.equal(env.bank.address);
      expect(lc.beneficiary).to.equal(env.exporter.address);
      expect(lc.amount).to.equal(LC);
      expect(lc.requiredDocs).to.equal(0b111011); // CIF stipulated set

      const s = await env.core.getShipment(orderId);
      expect(s.phase).to.equal(Phase.LCIssued);
    });

    it("only a bank may issue", async function () {
      const env = await loadFixture(fixture);
      const orderId = await apply(env);
      await expect(env.core.connect(env.importer).issueLetterOfCredit(orderId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await expect(env.core.connect(env.outsider).issueLetterOfCredit(orderId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts on an unknown application, a second issuance and an expired application", async function () {
      const env = await loadFixture(fixture);
      await expect(env.core.connect(env.bank).issueLetterOfCredit(999n)).to.be.revertedWithCustomError(
        env.core,
        "ShipmentNotFound"
      );

      const orderId = await apply(env);
      await env.core.connect(env.bank).issueLetterOfCredit(orderId);
      await expect(env.core.connect(env.bank).issueLetterOfCredit(orderId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );

      const shortDeadline = BigInt(await time.latest()) + 2n;
      const expired = await apply(env, { deadline: shortDeadline });
      await time.increaseTo(shortDeadline + 1n);
      await expect(env.core.connect(env.bank).issueLetterOfCredit(expired)).to.be.revertedWithCustomError(
        env.core,
        "CreditExpired"
      );
    });

    it("reverts when the bank has not approved the core", async function () {
      const env = await loadFixture(fixture);
      const orderId = await apply(env);
      await env.token.connect(env.bank).approve(await env.core.getAddress(), 0);
      await expect(env.core.connect(env.bank).issueLetterOfCredit(orderId)).to.be.revertedWithCustomError(
        env.token,
        "ERC20InsufficientAllowance"
      );
    });
  });

  describe("createShipment", function () {
    it("the named exporter may ship only after the credit is issued and operative", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Sight, 0n);

      // Application recorded but the bank has not issued: shipping must revert.
      await expect(
        env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "InvalidState");

      await env.core.connect(env.bank).issueLetterOfCredit(1n);

      await expect(env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing))
        .to.emit(env.core, "ShipmentCreated")
        .withArgs(1n, 1n, env.exporter.address, env.importer.address, Incoterm.FOB, LC, deadline)
        .and.to.emit(env.registry, "DocumentAnchored");

      const shipment = await env.core.getShipment(1n);
      expect(shipment.phase).to.equal(Phase.Shipped);
      expect(shipment.importer).to.equal(env.importer.address);
      expect(shipment.exporter).to.equal(env.exporter.address);
      expect(shipment.riskHolder).to.equal(env.exporter.address);

      expect(await env.core.hasValidDocument(1n, DocType.CommercialInvoice)).to.equal(true);
      expect(await env.core.hasValidDocument(1n, DocType.PackingList)).to.equal(true);

      // Title NFT minted to the core (escrow).
      expect(await env.nft.ownerOf(1n)).to.equal(await env.core.getAddress());
    });

    it("rejects an exporter other than the named beneficiary", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);

      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_EXPORTER()], [env.outsider.address]);
      await expect(
        env.core.connect(env.outsider).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "NotBeneficiary");
    });

    it("rejects an empty invoice CID and a second shipment for the same credit", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);

      await expect(
        env.core.connect(env.exporter).createShipment(1n, "", CID.packing)
      ).to.be.revertedWithCustomError(env.registry, "EmptyCID");

      await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);
      await expect(
        env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "InvalidState");
    });

    it("rejects an unknown order and shipping after the credit expired", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.exporter).createShipment(999n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "ShipmentNotFound");

      const deadline = BigInt(await time.latest()) + 3n;
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);
      await time.increaseTo(deadline + 1n);
      await expect(
        env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeadline");
    });
  });

  describe("presentDocuments", function () {
    it("only the beneficiary may present, and only once the goods are shipped", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);

      await expect(env.core.connect(env.exporter).presentDocuments(1n)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );

      await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);
      await env.core.connect(env.verifier).anchorDocument(1n, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.logistics).confirmPickup(1n);
      await env.core.connect(env.logistics).confirmVesselLoading(1n, CID.bl);

      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_EXPORTER()], [env.outsider.address]);
      await expect(env.core.connect(env.outsider).presentDocuments(1n)).to.be.revertedWithCustomError(
        env.core,
        "NotBeneficiary"
      );

      await expect(env.core.connect(env.exporter).presentDocuments(1n))
        .to.emit(env.core, "DocumentsPresented")
        .withArgs(1n, env.exporter.address);
      expect((await env.core.getShipment(1n)).phase).to.equal(Phase.Presented);
      expect((await env.core.getLC(1n)).presented).to.equal(true);

      // A second presentation reverts (the phase has moved on).
      await expect(env.core.connect(env.exporter).presentDocuments(1n)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
    });
  });
});
