const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
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

describe("Incoterm end-to-end flows", function () {
  const fixture = deployTradeChain;

  async function setup(env, term, opts = {}) {
    const { shipmentId } = await createOrderAndShipment(env, { term, ...opts });
    return shipmentId;
  }

  it("EXW — the bank honors a complying presentation at sight; milestones no longer pay", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.EXW);

    // Custody moves risk, never funds: no payout at pickup.
    const atPickup = await env.token.balanceOf(env.exporter.address);
    await env.core.connect(env.logistics).confirmPickup(id);
    expect(await env.token.balanceOf(env.exporter.address)).to.equal(atPickup);
    let s = await env.core.getShipment(id);
    expect(s.custody).to.equal(Custody.PickedUp);
    expect(s.riskHolder).to.equal(env.importer.address);
    expect(s.phase).to.equal(Phase.Shipped);

    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
    s = await env.core.getShipment(id);
    expect(await env.token.balanceOf(env.exporter.address)).to.equal(atPickup);

    await present(env, id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Presented);

    const before = await env.token.balanceOf(env.exporter.address);
    await expect(honor(env, id)).to.emit(env.core, "AtomicLCPayoutExecuted").withArgs(id, env.exporter.address, LC);

    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect((await env.core.getLC(id)).paid).to.equal(true);

    await env.core.connect(env.importer).confirmFinalDelivery(id);
    s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect(s.riskHolder).to.equal(env.importer.address);
    expect(await env.nft.ownerOf(id)).to.equal(env.importer.address);
  });

  it("FOB — risk passes on the vessel, but payment waits for presentation + honor", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);
    await toPresentable(env, id);

    let s = await env.core.getShipment(id);
    expect(s.riskHolder).to.equal(env.importer.address);
    expect((await env.core.getLC(id)).paid).to.equal(false);
    expect(await env.token.balanceOf(await env.loc.getAddress())).to.equal(LC);

    await present(env, id);
    const before = await env.token.balanceOf(env.exporter.address);
    await honor(env, id);
    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);

    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("CIF — insurance gates vessel loading and the stipulated presentation", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.CIF);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.logistics).confirmPickup(id);

    // Missing insurance certificate at loading: the custody gate blocks.
    await expect(env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)).to.be.revertedWithCustomError(
      env.compliance,
      "MissingMandatoryDocument"
    );

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);
    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);

    const before = await env.token.balanceOf(env.exporter.address);
    await present(env, id);
    await honor(env, id);
    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Honored);

    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("CIF — a certificate revoked after presentation makes the bank refuse (cannot honor)", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.CIF);
    await toPresentable(env, id);
    await present(env, id);

    await env.core.connect(env.verifier).revokeDocument(id, DocType.InsuranceCertificate);

    await expect(honor(env, id)).to.be.revertedWithCustomError(env.compliance, "MissingMandatoryDocument");
    expect((await env.core.getLC(id)).honored).to.equal(false);
  });

  it("DDP — honor is gated by clearance (presentation) and duty (examination)", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await env.core.connect(env.exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.logistics).confirmPickup(id);
    await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);

    // Clearance anchored but duty not yet paid: presentation records, examination refuses.
    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);
    await present(env, id);
    await expect(honor(env, id)).to.be.revertedWithCustomError(env.loc, "DutyNotPaid");

    // Exporter (DDP) pays duty; the bank then honors at sight.
    const duty = 500n * UNIT;
    await expect(env.core.connect(env.exporter).payCustomsDuty(id, duty)).to.emit(env.core, "DutyPaid");

    const before = await env.token.balanceOf(env.exporter.address);
    await expect(honor(env, id)).to.emit(env.core, "AtomicLCPayoutExecuted").withArgs(id, env.exporter.address, LC);

    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    const s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Honored);
    expect((await env.core.getLC(id)).dutyAmount).to.equal(duty);

    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
    expect(await env.nft.ownerOf(id)).to.equal(env.importer.address);
  });

  it("DDP — accepts zero customs duty for duty-free destinations", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.DDP);
    await toPresentable(env, id);

    await env.core.connect(env.exporter).payCustomsDuty(id, 0);
    await present(env, id);
    await honor(env, id);
    await env.core.connect(env.importer).confirmFinalDelivery(id);

    const s = await env.core.getShipment(id);
    expect(s.phase).to.equal(Phase.Settled);
    expect((await env.core.getLC(id)).dutyAmount).to.equal(0n);
  });

  it("deferred payment — the bank schedules honor and the proceeds are drawn at maturity", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId: id } = await createOrderAndShipment(env, {
      term: Incoterm.DDP,
      paymentTerm: PaymentTerm.Deferred,
      deferredDays: 3n,
    });
    await toPresentable(env, id);
    await env.core.connect(env.exporter).payCustomsDuty(id, 0);
    await present(env, id);

    await expect(honor(env, id))
      .to.emit(env.loc, "LCHonored")
      .withArgs(id, env.exporter.address, anyValue, true);
    const lc = await env.core.getLC(id);
    expect(lc.honored).to.equal(true);
    expect(lc.paid).to.equal(false);
    expect(Number(lc.maturityAt)).to.equal(Number(lc.honoredAt) + 3 * 24 * 60 * 60);

    // The importer may take delivery while payment matures; the trade is not settled yet.
    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Delivered);
    expect(await env.nft.ownerOf(id)).to.equal(env.importer.address);

    // Before maturity nobody — not even the bank — can draw.
    await expect(env.core.connect(env.bank).drawDeferredPayment(id)).to.be.revertedWithCustomError(
      env.loc,
      "MaturityNotReached"
    );

    await time.increaseTo(Number(lc.maturityAt) + 1);
    const before = await env.token.balanceOf(env.exporter.address);
    // Permissionless at maturity: a stalled bank cannot withhold the proceeds.
    await expect(env.core.connect(env.outsider).drawDeferredPayment(id))
      .to.emit(env.core, "AtomicLCPayoutExecuted")
      .withArgs(id, env.exporter.address, LC);

    expect(await env.token.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("deferred payment — the duty is forwarded to the treasury when the proceeds are drawn", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId: id } = await createOrderAndShipment(env, {
      term: Incoterm.DDP,
      paymentTerm: PaymentTerm.Deferred,
      deferredDays: 1n,
    });
    await toPresentable(env, id);
    const duty = 25n * UNIT;
    await env.core.connect(env.exporter).payCustomsDuty(id, duty);
    await present(env, id);
    await honor(env, id);

    const treasuryBefore = await env.token.balanceOf((await env.loc.treasury()));
    await time.increaseTo(Number((await env.core.getLC(id)).maturityAt) + 1);
    await env.core.connect(env.bank).drawDeferredPayment(id);

    expect(await env.token.balanceOf(await env.loc.treasury())).to.equal(treasuryBefore + duty);
    expect((await env.core.getLC(id)).paid).to.equal(true);
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
    await toPresentable(env, id);
    await env.core.connect(env.exporter).payCustomsDuty(id, 0);
    expect((await env.core.getShipment(id)).riskHolder).to.equal(env.exporter.address);

    await present(env, id);
    await honor(env, id);
    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).riskHolder).to.equal(env.importer.address);
  });

  it("payment and delivery may happen in either order", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.EXW);
    await toPresentable(env, id);

    // Delivery first (documents complete, credit presented later).
    await present(env, id);
    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Delivered);

    await honor(env, id); // sight payment after delivery settles the trade
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);
  });

  it("rejects loading before pickup", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await expect(
      env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)
    ).to.be.revertedWithCustomError(env.core, "InvalidCustody");
  });

  it("the beneficiary cannot present after the credit has expired", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.FOB, { deadline: await futureDeadline(2) });
    await toPresentable(env, id);

    const { deadline } = await env.core.getShipment(id);
    await time.increaseTo(Number(deadline) + 1);

    await expect(env.core.connect(env.exporter).presentDocuments(id)).to.be.revertedWithCustomError(
      env.core,
      "CreditExpired"
    );
  });

  it("terminal trades refuse further duty, milestones and re-delivery", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.EXW);
    await toPresentable(env, id);
    await present(env, id);
    await honor(env, id);
    await env.core.connect(env.importer).confirmFinalDelivery(id);
    expect((await env.core.getShipment(id)).phase).to.equal(Phase.Settled);

    await expect(env.core.connect(env.importer).payCustomsDuty(id, 1n)).to.be.revertedWithCustomError(
      env.core,
      "InvalidStateRange"
    );
    await expect(env.core.connect(env.bank).forceFinalizeDelivery(id)).to.be.revertedWithCustomError(
      env.core,
      "InvalidStateRange"
    );
    await expect(env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)).to.be.revertedWithCustomError(
      env.core,
      "InvalidStateRange"
    );
  });

  it("double pickup and loading out of custody order are refused", async function () {
    const env = await loadFixture(fixture);
    const id = await setup(env, Incoterm.EXW);
    await env.core.connect(env.logistics).confirmPickup(id);

    await expect(env.core.connect(env.logistics).confirmPickup(id)).to.be.revertedWithCustomError(
      env.core,
      "InvalidCustody"
    );
  });

  it("loading is refused while the goods have not shipped (credit issued only)", async function () {
    const env = await loadFixture(fixture);
    await env.core
      .connect(env.importer)
      .createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
    await env.core.connect(env.bank).issueLetterOfCredit(1n);

    await expect(env.core.connect(env.logistics).confirmVesselLoading(1n, CID.bl)).to.be.revertedWithCustomError(
      env.core,
      "InvalidState"
    );
  });
});
