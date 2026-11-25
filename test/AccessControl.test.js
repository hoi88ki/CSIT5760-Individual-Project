const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  PaymentTerm,
  Phase,
  DocType,
  CID,
  LC,
  deployTradeChain,
  futureDeadline,
  createOrderAndShipment,
  toPresentable,
  present,
  honor,
} = require("./helpers/fixture");

describe("Access control & state-machine guards", function () {
  const fixture = deployTradeChain;

  describe("milestone roles", function () {
    it("only logistics may confirm pickup and loading", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);

      await expect(env.core.connect(env.exporter).confirmPickup(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await env.core.connect(env.logistics).confirmPickup(shipmentId);
      await expect(
        env.core.connect(env.importer).confirmVesselLoading(shipmentId, CID.bl)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("only the shipment importer may confirm final delivery", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });
      await toPresentable(env, shipmentId);

      await expect(env.core.connect(env.exporter).confirmFinalDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );

      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_IMPORTER()], [env.outsider.address]);
      await expect(env.core.connect(env.outsider).confirmFinalDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
    });
  });

  describe("examination roles", function () {
    it("only the bank may honor a presentation", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await toPresentable(env, shipmentId);
      await present(env, shipmentId);

      await expect(env.core.connect(env.importer).honorPresentation(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await expect(env.core.connect(env.outsider).honorPresentation(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await expect(honor(env, shipmentId)).to.not.be.reverted;
    });
  });

  describe("customs duty roles", function () {
    it("non-DDP duty is paid by the importer; DDP duty by the exporter", async function () {
      const env = await loadFixture(fixture);

      const a = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await expect(env.core.connect(env.exporter).payCustomsDuty(a.shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
      await env.core.connect(env.importer).payCustomsDuty(a.shipmentId, 1n);

      const b = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await expect(env.core.connect(env.importer).payCustomsDuty(b.shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
      await env.core.connect(env.exporter).payCustomsDuty(b.shipmentId, 1n);
    });

    it("cannot pay duty twice", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await env.core.connect(env.importer).payCustomsDuty(shipmentId, 1n);
      await expect(
        env.core.connect(env.importer).payCustomsDuty(shipmentId, 1n)
      ).to.be.revertedWithCustomError(env.loc, "DutyAlreadyPaid");
    });

    it("cannot pay duty before the goods are shipped", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);
      await expect(env.core.connect(env.importer).payCustomsDuty(1n, 1n)).to.be.revertedWithCustomError(
        env.core,
        "InvalidStateRange"
      );
    });

    it("cannot escrow duty once the credit has paid (sight honor releases the proceeds)", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.EXW });
      await toPresentable(env, shipmentId);
      await present(env, shipmentId);
      await honor(env, shipmentId);

      await expect(env.core.connect(env.importer).payCustomsDuty(shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "LCAlreadySettled"
      );
    });
  });

  describe("state-machine order", function () {
    it("rejects out-of-order transitions", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });

      // Pickup before the goods are handed over is impossible (the record exists but custody has
      // not started); the goods must ship first.
      await expect(
        env.core.connect(env.logistics).confirmPickup(999n)
      ).to.be.revertedWithCustomError(env.core, "ShipmentNotFound");

      await expect(
        env.core.connect(env.logistics).confirmVesselLoading(shipmentId, CID.bl)
      ).to.be.revertedWithCustomError(env.core, "InvalidCustody");
    });

    it("custody cannot start before the exporter ships", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);

      // Phase is LCIssued (credit issued) but the goods have not shipped.
      await expect(env.core.connect(env.logistics).confirmPickup(1n)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
    });

    it("honor requires a recorded presentation", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await toPresentable(env, shipmentId);

      await expect(honor(env, shipmentId)).to.be.revertedWithCustomError(env.core, "InvalidState");
    });

    it("an already-honored presentation cannot be honored again", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await toPresentable(env, shipmentId);
      await present(env, shipmentId);
      await honor(env, shipmentId);

      // The sight credit already paid: the settled guard fires before the honored guard.
      await expect(honor(env, shipmentId)).to.be.revertedWithCustomError(env.loc, "AlreadySettled");
    });

    it("reverts for unknown trades", async function () {
      const env = await loadFixture(fixture);
      await expect(env.core.connect(env.logistics).confirmPickup(1234n)).to.be.revertedWithCustomError(
        env.core,
        "ShipmentNotFound"
      );
      await expect(env.core.connect(env.bank).honorPresentation(4321n)).to.be.revertedWithCustomError(
        env.core,
        "ShipmentNotFound"
      );
    });

    it("advancing a reclaimed trade reverts", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);
      await time.increaseTo(Number((await env.core.getShipment(1n)).deadline) + 1);
      await env.core.connect(env.importer).reclaimExpiredLC(1n);
      await expect(env.core.connect(env.logistics).confirmPickup(1n)).to.be.revertedWithCustomError(
        env.core,
        "InvalidStateRange"
      );
    });
  });

  describe("admin", function () {
    it("grantRoles is admin-only and length-checked", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.outsider).grantRoles([await env.core.ROLE_EXPORTER()], [env.outsider.address])
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");

      await expect(
        env.core.connect(env.admin).grantRoles([await env.core.ROLE_EXPORTER()], [])
      ).to.be.revertedWithCustomError(env.core, "ArrayLengthMismatch");
    });

    it("admin can re-point the duty treasury", async function () {
      const env = await loadFixture(fixture);
      await expect(env.core.connect(env.outsider).setTreasury(env.outsider.address)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await env.core.connect(env.admin).setTreasury(env.outsider.address);
      expect(await env.loc.treasury()).to.equal(env.outsider.address);
    });
  });

  describe("creation & issuance guards", function () {
    it("createShipment requires the exporter role", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);
      await expect(
        env.core.connect(env.outsider).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("createShipment rejects an order whose deadline has elapsed", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline(1);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, deadline, PaymentTerm.Sight, 0n);
      await env.core.connect(env.bank).issueLetterOfCredit(1n);
      await time.increaseTo(Number(deadline) + 1);
      await expect(
        env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeadline");
    });

    it("issueLetterOfCredit requires the bank role", async function () {
      const env = await loadFixture(fixture);
      await env.core
        .connect(env.importer)
        .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
      await expect(env.core.connect(env.outsider).issueLetterOfCredit(1n)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("presentDocuments requires the exporter role", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await toPresentable(env, shipmentId);
      await expect(env.core.connect(env.outsider).presentDocuments(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
    });
  });
});
