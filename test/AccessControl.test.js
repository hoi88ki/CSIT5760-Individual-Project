const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  DocType,
  CID,
  LC,
  deployTradeChain,
  createOrderAndShipment,
  fundLC,
  futureDeadline,
} = require("./helpers/fixture");

describe("Access control & state-machine guards", function () {
  const fixture = deployTradeChain;

  describe("milestone roles", function () {
    it("only logistics may confirm pickup and loading", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);

      await expect(env.core.connect(env.exporter).confirmPickup(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.logistics).confirmPickup(shipmentId);
      await expect(
        env.core.connect(env.importer).confirmVesselLoading(shipmentId, CID.bl)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("only the shipment importer may confirm final delivery", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });
      await fundLC(env, shipmentId);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InsuranceCertificate, CID.insurance);
      await env.core.connect(env.logistics).confirmPickup(shipmentId);
      await env.core.connect(env.logistics).confirmVesselLoading(shipmentId, CID.bl);

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

  describe("customs duty roles", function () {
    it("non-DDP duty is paid by the importer; DDP duty by the exporter", async function () {
      const env = await loadFixture(fixture);

      const a = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, a.shipmentId);
      await expect(env.core.connect(env.exporter).payCustomsDuty(a.shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
      await env.core.connect(env.importer).payCustomsDuty(a.shipmentId, 1n);

      const b = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, b.shipmentId);
      await expect(env.core.connect(env.importer).payCustomsDuty(b.shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
      await env.core.connect(env.exporter).payCustomsDuty(b.shipmentId, 1n);
    });

    it("cannot pay duty twice", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.importer).payCustomsDuty(shipmentId, 1n);
      await expect(
        env.core.connect(env.importer).payCustomsDuty(shipmentId, 1n)
      ).to.be.revertedWithCustomError(env.loc, "DutyAlreadyPaid");
    });

    it("cannot pay duty before the L/C is funded", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await expect(
        env.core.connect(env.importer).payCustomsDuty(shipmentId, 1n)
      ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
    });
  });

  describe("state-machine order", function () {
    it("rejects out-of-order transitions", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });

      await expect(env.core.connect(env.logistics).confirmPickup(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );

      await fundLC(env, shipmentId);
      await expect(env.core.connect(env.importer).openLetterOfCredit(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
      await expect(
        env.core.connect(env.logistics).confirmVesselLoading(shipmentId, CID.bl)
      ).to.be.revertedWithCustomError(env.core, "InvalidState");
    });

    it("reverts for unknown shipments", async function () {
      const env = await loadFixture(fixture);
      await expect(env.core.connect(env.logistics).confirmPickup(1234n)).to.be.revertedWithCustomError(
        env.core,
        "ShipmentNotFound"
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
  });

  describe("creation & funding guards", function () {
    it("createShipment requires the exporter role", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline());
      await expect(
        env.core.connect(env.outsider).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("createShipment rejects an order whose deadline has elapsed", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline(1);
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, deadline);
      await time.increaseTo(Number(deadline) + 1);
      await expect(
        env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeadline");
    });

    it("openLetterOfCredit requires the importer role", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await expect(
        env.core.connect(env.outsider).openLetterOfCredit(shipmentId)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });
  });
});
