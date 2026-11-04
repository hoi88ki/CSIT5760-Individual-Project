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

    expect((await env.core.getShipment(id)).lcPaid).to.equal(false);

    const before = await env.token.balanceOf(env.seller.address);
    await expect(env.core.connect(env.carrier).confirmPickup(id))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.seller.address, LC, Phase.PickedUp);

    expect(await env.token.balanceOf(env.seller.address)).to.equal(before + LC);
    let s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.PickedUp);
    expect(s.lcPaid).to.equal(true);
    expect(s.riskHolder).to.equal(env.buyer.address);

    await env.core.connect(env.carrier).confirmVesselLoading(id, CID.bl);
    s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.LoadedOnVessel);

    await env.core.connect(env.buyer).confirmFinalDelivery(id);
    s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect(s.titleTransferred).to.equal(true);
    expect(await env.ebl.ownerOf(id)).to.equal(env.buyer.address);
  });

  it("FOB — pays out at vessel loading (not before)", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);

    await env.core.connect(env.carrier).confirmPickup(id);
    expect((await env.core.getShipment(id)).lcPaid).to.equal(false);

    const before = await env.token.balanceOf(env.seller.address);
    await expect(env.core.connect(env.carrier).confirmVesselLoading(id, CID.bl))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.seller.address, LC, Phase.LoadedOnVessel);

    expect(await env.token.balanceOf(env.seller.address)).to.equal(before + LC);
    await env.core.connect(env.buyer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("CIF — requires an insurance certificate and pays out at loading", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.CIF);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.carrier).confirmPickup(id);

    // Missing insurance certificate at loading.
    await expect(
      env.core.connect(env.carrier).confirmVesselLoading(id, CID.bl)
    ).to.be.revertedWithCustomError(env.core, "MissingMandatoryDocument");

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);

    const before = await env.token.balanceOf(env.seller.address);
    await env.core.connect(env.carrier).confirmVesselLoading(id, CID.bl);
    expect(await env.token.balanceOf(env.seller.address)).to.equal(before + LC);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.LoadedOnVessel);

    await env.core.connect(env.buyer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("DDP — pays out only at final delivery, gated by clearance + duty", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.seller).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.carrier).confirmPickup(id);
    await env.core.connect(env.carrier).confirmVesselLoading(id, CID.bl);

    // Payout must not happen before delivery.
    expect((await env.core.getShipment(id)).lcPaid).to.equal(false);

    // Clearance anchored but duty not yet paid → delivery reverts.
    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);
    await expect(
      env.core.connect(env.buyer).confirmFinalDelivery(id)
    ).to.be.revertedWithCustomError(env.core, "CustomsDutyNotPaid");

    // Seller (DDP) pays duty.
    const duty = 500n * UNIT;
    await expect(env.core.connect(env.seller).payCustomsDuty(id, duty)).to.emit(env.core, "DutyPaid");

    const before = await env.token.balanceOf(env.seller.address);
    await expect(env.core.connect(env.buyer).confirmFinalDelivery(id))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.seller.address, LC, Phase.Delivered);

    expect(await env.token.balanceOf(env.seller.address)).to.equal(before + LC);
    const s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect(s.dutyPaid).to.equal(true);
    expect(s.dutyAmount).to.equal(duty);
    expect(await env.ebl.ownerOf(id)).to.equal(env.buyer.address);
  });

  it("DDP — accepts zero customs duty for duty-free destinations", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.seller).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.carrier).confirmPickup(id);
    await env.core.connect(env.carrier).confirmVesselLoading(id, CID.bl);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);

    await env.core.connect(env.seller).payCustomsDuty(id, 0);
    await env.core.connect(env.buyer).confirmFinalDelivery(id);

    const s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect(s.dutyAmount).to.equal(0n);
  });

  it("requires the invoice and packing list (anchored at shipment creation)", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);
    // Invoice + packing list are present, so pickup is allowed; loading needs the rest.
    await expect(env.core.connect(env.carrier).confirmPickup(id)).to.not.be.reverted;
  });
});
