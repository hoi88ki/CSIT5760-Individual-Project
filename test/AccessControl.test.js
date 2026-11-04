const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
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

describe("Access control & state-machine guards", function () {
  const fixture = deployTradeChain;

  describe("milestone roles", function () {
    it("only the carrier may confirm pickup and loading", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);

      await expect(env.core.connect(env.seller).confirmPickup(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.carrier).confirmPickup(shipmentId);
      await expect(env.core.connect(env.buyer).confirmVesselLoading(shipmentId, CID.bl)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("only the shipment buyer may confirm final delivery", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });
      await fundLC(env, shipmentId);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InsuranceCertificate, CID.insurance);
      await env.core.connect(env.carrier).confirmPickup(shipmentId);
      await env.core.connect(env.carrier).confirmVesselLoading(shipmentId, CID.bl);

      await expect(env.core.connect(env.seller).confirmFinalDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "AccessControlUnauthorizedAccount"
      );

      // A different buyer-role account is not this shipment's buyer.
      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_BUYER()], [env.outsider.address]);
      await expect(env.core.connect(env.outsider).confirmFinalDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
    });
  });

  describe("customs duty roles", function () {
    it("non-DDP duty is paid by the buyer; DDP duty by the seller", async function () {
      const env = await loadFixture(fixture);

      const a = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, a.shipmentId);
      await expect(env.core.connect(env.seller).payCustomsDuty(a.shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
      await env.core.connect(env.buyer).payCustomsDuty(a.shipmentId, 1n);

      const b = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, b.shipmentId);
      await expect(env.core.connect(env.buyer).payCustomsDuty(b.shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "Unauthorized"
      );
      await env.core.connect(env.seller).payCustomsDuty(b.shipmentId, 1n);
    });

    it("cannot pay duty twice", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.buyer).payCustomsDuty(shipmentId, 1n);
      await expect(env.core.connect(env.buyer).payCustomsDuty(shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "DutyAlreadyPaid"
      );
    });

    it("cannot pay duty before the L/C is funded", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await expect(env.core.connect(env.buyer).payCustomsDuty(shipmentId, 1n)).to.be.revertedWithCustomError(
        env.core,
        "InvalidStateRange"
      );
    });
  });

  describe("state-machine order", function () {
    it("rejects out-of-order transitions", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });

      // Not funded yet.
      await expect(env.core.connect(env.carrier).confirmPickup(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );

      await fundLC(env, shipmentId);
      // Cannot fund twice.
      await expect(env.core.connect(env.buyer).openLetterOfCredit(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
      // Cannot load before pickup.
      await expect(env.core.connect(env.carrier).confirmVesselLoading(shipmentId, CID.bl)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
    });

    it("reverts for unknown shipments", async function () {
      const env = await loadFixture(fixture);
      await expect(env.core.connect(env.carrier).confirmPickup(1234n)).to.be.revertedWithCustomError(
        env.core,
        "ShipmentNotFound"
      );
    });
  });

  describe("admin", function () {
    it("grantRoles is admin-only and length-checked", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.outsider).grantRoles([await env.core.ROLE_SELLER()], [env.outsider.address])
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");

      await expect(
        env.core.connect(env.admin).grantRoles([await env.core.ROLE_SELLER()], [])
      ).to.be.revertedWithCustomError(env.core, "ArrayLengthMismatch");
    });
  });
});
