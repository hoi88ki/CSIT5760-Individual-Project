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
} = require("./helpers/fixture");

describe("Neutrality & timeout safeguards", function () {
  const fixture = deployTradeChain;

  describe("reclaimExpiredLC", function () {
    it("reverts before the deadline", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await expect(env.core.connect(env.importer).reclaimExpiredLC(shipmentId)).to.be.revertedWithCustomError(
        env.loc,
        "DeadlineNotReached"
      );
    });

    it("only the importer, bank or admin may reclaim", async function () {
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

    it("refunds the importer after expiry when the exporter never shipped", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);

      const locAddr = await env.loc.getAddress();
      expect(await env.token.balanceOf(locAddr)).to.equal(LC);

      const { deadline } = await env.core.getShipment(shipmentId);
      await time.increaseTo(Number(deadline) + 1);
      const before = await env.token.balanceOf(env.importer.address);
      await expect(env.core.connect(env.importer).reclaimExpiredLC(shipmentId)).to.emit(env.core, "LCReclaimed");

      expect(await env.token.balanceOf(env.importer.address)).to.equal(before + LC);
      expect((await env.core.getShipment(shipmentId)).phase).to.equal(Phase.Reclaimed);
    });

    it("lets the bank reclaim on the importer's behalf", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      await expect(env.core.connect(env.bank).reclaimExpiredLC(shipmentId)).to.not.be.reverted;
    });

    it("refunds duty to its payer on reclaim", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.importer).payCustomsDuty(shipmentId, 10n);
      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      const before = await env.token.balanceOf(env.importer.address);
      await env.core.connect(env.importer).reclaimExpiredLC(shipmentId);
      expect(await env.token.balanceOf(env.importer.address)).to.equal(before + LC + 10n);
    });

    it("cannot reclaim once the exporter has shipped (risk has moved)", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.logistics).confirmPickup(shipmentId);

      await time.increaseTo(Number((await env.core.getShipment(shipmentId)).deadline) + 1);
      await expect(env.core.connect(env.importer).reclaimExpiredLC(shipmentId)).to.be.revertedWithCustomError(
        env.loc,
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
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts until the shipment is on the vessel", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, shipmentId);
      await expect(env.core.connect(env.bank).forceFinalizeDelivery(shipmentId)).to.be.revertedWithCustomError(
        env.core,
        "InvalidState"
      );
    });

    it("lets the bank finalize a stalled DDP shipment once docs + duty are complete", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
      await fundLC(env, shipmentId);

      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.exporter).anchorDocument(shipmentId, DocType.CertificateOfOrigin, CID.coo);
      await env.core.connect(env.logistics).confirmPickup(shipmentId);
      await env.core.connect(env.logistics).confirmVesselLoading(shipmentId, CID.bl);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.CustomsClearance, CID.clearance);
      await env.core.connect(env.exporter).payCustomsDuty(shipmentId, 0);

      const before = await env.token.balanceOf(env.exporter.address);
      await expect(env.core.connect(env.bank).forceFinalizeDelivery(shipmentId))
        .to.emit(env.core, "DeliveryForceFinalized")
        .and.to.emit(env.core, "AtomicLCPayoutExecuted");

      expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
      expect((await env.core.getShipment(shipmentId)).phase).to.equal(Phase.Settled);
      expect(await env.nft.ownerOf(shipmentId)).to.equal(env.importer.address);
    });

    it("releases the title for an already-paid term if the importer stalls", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await fundLC(env, shipmentId);
      await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.logistics).confirmPickup(shipmentId);
      await env.core.connect(env.logistics).confirmVesselLoading(shipmentId, CID.bl); // pays out (FOB)

      await env.core.connect(env.bank).forceFinalizeDelivery(shipmentId);
      const s = await env.core.getShipment(shipmentId);
      expect(s.phase).to.equal(Phase.Settled);
      expect(await env.nft.ownerOf(shipmentId)).to.equal(env.importer.address);
    });
  });
});
