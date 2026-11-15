const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  Phase,
  DocType,
  CID,
  LC,
  UNIT,
  deployTradeChain,
  createOrderAndShipment,
  fundLC,
} = require("./helpers/fixture");

describe("Incoterm end-to-end flows", function () {
  const fixture = deployTradeChain;

  async function setup(env, term) {
    const { shipmentId } = await createOrderAndShipment(env, { term });
    await fundLC(env, shipmentId);
    return shipmentId;
  }

  it("EXW — pays out at pickup", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.EXW);

    expect((await env.core.getLC(id)).paid).to.equal(false);

    const before = await env.token.balanceOf(env.exporter.address);
    await expect(env.core.connect(env.logistics).confirmPickup(id))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.exporter.address, LC, Phase.PickedUp);

    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    let s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.PickedUp);
    expect(s.riskHolder).to.equal(env.importer.address);
    expect((await env.core.getLC(id)).paid).to.equal(true);

    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
    s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.LoadedOnVessel);

    await env.core.connect(env.importer).confirmFinalDelivery(id);
    s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect(await env.nft.ownerOf(id)).to.equal(env.importer.address);
  });

  it("FOB — pays out at vessel loading (not before)", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);

    await env.core.connect(env.logistics).confirmPickup(id);
    expect((await env.core.getLC(id)).paid).to.equal(false);

    const before = await env.token.balanceOf(env.exporter.address);
    await expect(env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.exporter.address, LC, Phase.LoadedOnVessel);

    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("CIF — requires an insurance certificate and pays out at loading", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.CIF);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.logistics).confirmPickup(id);

    // Missing insurance certificate at loading.
    await expect(
      env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)
    ).to.be.revertedWithCustomError(env.compliance, "MissingMandatoryDocument");

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);

    const before = await env.token.balanceOf(env.exporter.address);
    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.LoadedOnVessel);

    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("CIF — a revoked insurance certificate blocks payout", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.CIF);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);
    await env.core.connect(env.logistics).confirmPickup(id);
    await env.core.connect(env.verifier).revokeDocument(id, DocType.InsuranceCertificate);

    await expect(
      env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)
    ).to.be.revertedWithCustomError(env.compliance, "MissingMandatoryDocument");
  });

  it("DDP — pays out only at final delivery, gated by clearance + duty", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.logistics).confirmPickup(id);
    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);

    expect((await env.core.getLC(id)).paid).to.equal(false);

    // Clearance anchored but duty not yet paid → delivery reverts.
    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);
    await expect(
      env.core.connect(env.importer).confirmFinalDelivery(id)
    ).to.be.revertedWithCustomError(env.loc, "DutyNotPaid");

    // Exporter (DDP) pays duty.
    const duty = 500n * UNIT;
    await expect(env.core.connect(env.exporter).payCustomsDuty(id, duty)).to.emit(env.core, "DutyPaid");

    const before = await env.token.balanceOf(env.exporter.address);
    await expect(env.core.connect(env.importer).confirmFinalDelivery(id))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.exporter.address, LC, Phase.Delivered);

    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    const s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect((await env.core.getLC(id)).dutyAmount).to.equal(duty);
    expect(await env.nft.ownerOf(id)).to.equal(env.importer.address);
  });

  it("DDP — accepts zero customs duty for duty-free destinations", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.logistics).confirmPickup(id);
    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);

    await env.core.connect(env.exporter).payCustomsDuty(id, 0);
    await env.core.connect(env.importer).confirmFinalDelivery(id);

    const s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect((await env.core.getLC(id)).dutyAmount).to.equal(0n);
  });

  it("FOB — risk passes to the importer on the vessel, not at pickup", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);

    await env.core.connect(env.logistics).confirmPickup(id);
    expect((await env.core.getShipment(id)).riskHolder).to.equal(env.exporter.address);

    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
    expect((await env.core.getShipment(id)).riskHolder).to.equal(env.importer.address);
  });

  it("DDP — risk passes only at final delivery", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.logistics).confirmPickup(id);
    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
    expect((await env.core.getShipment(id)).riskHolder).to.equal(env.exporter.address);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);
    await env.core.connect(env.exporter).payCustomsDuty(id, 0);
    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).riskHolder).to.equal(env.importer.address);
  });

  it("rejects loading before pickup", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);
    await expect(
      env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)
    ).to.be.revertedWithCustomError(env.core, "InvalidState");
  });
});
