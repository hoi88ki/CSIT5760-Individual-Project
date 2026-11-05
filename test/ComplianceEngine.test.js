const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  Phase,
  DocType,
  CID,
  deployTradeChain,
  createOrderAndShipment,
  fundLC,
} = require("./helpers/fixture");

const bit = (d) => 1 << d;
const base = bit(DocType.CommercialInvoice) | bit(DocType.PackingList);
const inspection = bit(DocType.InspectionCertificate);
const insurance = bit(DocType.InsuranceCertificate);
const bl = bit(DocType.BillOfLadingOrAWB);
const coo = bit(DocType.CertificateOfOrigin);
const clearance = bit(DocType.CustomsClearance);

describe("ComplianceEngine — Incoterm-aware rules", function () {
  const fixture = deployTradeChain;

  it("requiredMask varies by Incoterm and phase", async function () {
    const env = await loadFixture(fixture);
    const c = env.compliance;
    // Pickup: only invoice + packing list.
    for (const t of [Incoterm.EXW, Incoterm.FOB, Incoterm.CIF, Incoterm.DDP]) {
      expect(await c.requiredMask(t, Phase.PickedUp)).to.equal(BigInt(base));
    }
    // Loading.
    expect(await c.requiredMask(Incoterm.EXW, Phase.LoadedOnVessel)).to.equal(BigInt(base | bl));
    expect(await c.requiredMask(Incoterm.FOB, Phase.LoadedOnVessel)).to.equal(BigInt(base | inspection | bl));
    expect(await c.requiredMask(Incoterm.DDP, Phase.LoadedOnVessel)).to.equal(BigInt(base | inspection | bl));
    expect(await c.requiredMask(Incoterm.CIF, Phase.LoadedOnVessel)).to.equal(
      BigInt(base | inspection | bl | insurance)
    );
    // Delivered.
    expect(await c.requiredMask(Incoterm.DDP, Phase.Delivered)).to.equal(
      BigInt(base | inspection | bl | coo | clearance)
    );
    expect(await c.requiredMask(Incoterm.CIF, Phase.Delivered)).to.equal(BigInt(base | inspection | bl | insurance));
    expect(await c.requiredMask(Incoterm.FOB, Phase.Delivered)).to.equal(BigInt(base | inspection | bl));
    expect(await c.requiredMask(Incoterm.EXW, Phase.Delivered)).to.equal(BigInt(base | bl));
    // Non-milestone phases → no documents.
    expect(await c.requiredMask(Incoterm.CIF, Phase.Created)).to.equal(0n);
    expect(await c.requiredMask(Incoterm.CIF, Phase.Settled)).to.equal(0n);
  });

  it("payoutPhase maps each Incoterm to its risk-transfer milestone", async function () {
    const env = await loadFixture(fixture);
    expect(await env.core.payoutPhaseOf(Incoterm.EXW)).to.equal(Phase.PickedUp);
    expect(await env.core.payoutPhaseOf(Incoterm.FOB)).to.equal(Phase.LoadedOnVessel);
    expect(await env.core.payoutPhaseOf(Incoterm.CIF)).to.equal(Phase.LoadedOnVessel);
    expect(await env.core.payoutPhaseOf(Incoterm.DDP)).to.equal(Phase.Delivered);
  });

  it("isCompliant flips once every required document is valid", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });
    await fundLC(env, shipmentId);

    expect(await env.core.isCompliant(shipmentId, Phase.LoadedOnVessel)).to.equal(false);
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
    expect(await env.core.isCompliant(shipmentId, Phase.LoadedOnVessel)).to.equal(false);
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InsuranceCertificate, CID.insurance);
    // B/L is still missing until loading.
    expect(await env.core.isCompliant(shipmentId, Phase.LoadedOnVessel)).to.equal(false);
    expect(await env.core.isCompliant(shipmentId, Phase.PickedUp)).to.equal(true);
  });

  it("firstMissing reports the first gap", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    await fundLC(env, shipmentId);
    const [ok, missing] = await env.compliance.firstMissing(shipmentId, Incoterm.FOB, Phase.LoadedOnVessel);
    expect(ok).to.equal(false);
    expect(missing).to.equal(DocType.InspectionCertificate);
  });

  it("requiredDocumentsAt delegates to the shipment's term", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.EXW });
    expect(await env.core.requiredDocumentsAt(shipmentId, Phase.PickedUp)).to.equal(BigInt(base));
    expect(await env.core.requiredDocumentsAt(shipmentId, Phase.LoadedOnVessel)).to.equal(BigInt(base | bl));
  });

  it("reverts for an unknown shipment", async function () {
    const env = await loadFixture(fixture);
    await expect(env.core.requiredDocumentsAt(777n, Phase.PickedUp)).to.be.revertedWithCustomError(
      env.core,
      "ShipmentNotFound"
    );
  });
});
