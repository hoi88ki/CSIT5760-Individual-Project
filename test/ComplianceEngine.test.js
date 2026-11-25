const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  Phase,
  Custody,
  DocType,
  CID,
  deployTradeChain,
  createOrderAndShipment,
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

  it("requiredMask varies by Incoterm and custody checkpoint", async function () {
    const env = await loadFixture(fixture);
    const c = env.compliance;
    // Pickup: only invoice + packing list.
    for (const t of [Incoterm.EXW, Incoterm.FOB, Incoterm.CIF, Incoterm.DDP]) {
      expect(await c.requiredMask(t, Custody.PickedUp)).to.equal(BigInt(base));
    }
    // Vessel loading.
    expect(await c.requiredMask(Incoterm.EXW, Custody.OnVessel)).to.equal(BigInt(base | bl));
    expect(await c.requiredMask(Incoterm.FOB, Custody.OnVessel)).to.equal(BigInt(base | inspection | bl));
    expect(await c.requiredMask(Incoterm.DDP, Custody.OnVessel)).to.equal(BigInt(base | inspection | bl));
    expect(await c.requiredMask(Incoterm.CIF, Custody.OnVessel)).to.equal(
      BigInt(base | inspection | bl | insurance)
    );
    // Delivery.
    expect(await c.requiredMask(Incoterm.DDP, Custody.Delivered)).to.equal(
      BigInt(base | inspection | bl | coo | clearance)
    );
    expect(await c.requiredMask(Incoterm.CIF, Custody.Delivered)).to.equal(
      BigInt(base | inspection | bl | insurance)
    );
    expect(await c.requiredMask(Incoterm.FOB, Custody.Delivered)).to.equal(BigInt(base | inspection | bl));
    expect(await c.requiredMask(Incoterm.EXW, Custody.Delivered)).to.equal(BigInt(base | bl));
    // Before pickup nothing is gate-checked.
    expect(await c.requiredMask(Incoterm.CIF, Custody.AtExporter)).to.equal(0n);
  });

  it("the stipulated presentation set is the Incoterm's full documentary requirement", async function () {
    const env = await loadFixture(fixture);
    const c = env.compliance;
    expect(await c.presentationMask(Incoterm.EXW)).to.equal(BigInt(base | bl));
    expect(await c.presentationMask(Incoterm.FOB)).to.equal(BigInt(base | inspection | bl));
    expect(await c.presentationMask(Incoterm.CIF)).to.equal(BigInt(base | inspection | bl | insurance));
    expect(await c.presentationMask(Incoterm.DDP)).to.equal(
      BigInt(base | inspection | bl | coo | clearance)
    );
    // The presentation set equals the delivery gate for the same Incoterm.
    for (const t of [Incoterm.EXW, Incoterm.FOB, Incoterm.CIF, Incoterm.DDP]) {
      expect(await c.presentationMask(t)).to.equal(await c.requiredMask(t, Custody.Delivered));
    }
  });

  it("presentation compliance flips once every stipulated document is valid", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });

    expect(await env.compliance.isPresentationCompliant(shipmentId, Incoterm.CIF)).to.equal(false);
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
    expect(await env.compliance.isPresentationCompliant(shipmentId, Incoterm.CIF)).to.equal(false);
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InsuranceCertificate, CID.insurance);
    // B/L is still missing until loading.
    expect(await env.compliance.isPresentationCompliant(shipmentId, Incoterm.CIF)).to.equal(false);
    expect(await env.core.isCompliant(shipmentId, Custody.PickedUp)).to.equal(true);

    await env.core.connect(env.logistics).confirmPickup(shipmentId);
    await env.core.connect(env.logistics).confirmVesselLoading(shipmentId, CID.bl);
    expect(await env.compliance.isPresentationCompliant(shipmentId, Incoterm.CIF)).to.equal(true);
  });

  it("firstMissing reports the first custody gap; firstMissingPresentation the presentation gap", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });

    let [ok, missing] = await env.compliance.firstMissing(shipmentId, Incoterm.FOB, Custody.OnVessel);
    expect(ok).to.equal(false);
    expect(missing).to.equal(DocType.InspectionCertificate);

    [ok, missing] = await env.compliance.firstMissingPresentation(shipmentId, Incoterm.FOB);
    expect(ok).to.equal(false);
    expect(missing).to.equal(DocType.InspectionCertificate);

    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);
    [ok, missing] = await env.compliance.firstMissingPresentation(shipmentId, Incoterm.FOB);
    expect(ok).to.equal(false);
    expect(missing).to.equal(DocType.BillOfLadingOrAWB);
  });

  it("requiredDocumentsAt and presentationDocuments delegate to the shipment's term", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.EXW });
    expect(await env.core.requiredDocumentsAt(shipmentId, Custody.PickedUp)).to.equal(BigInt(base));
    expect(await env.core.requiredDocumentsAt(shipmentId, Custody.OnVessel)).to.equal(BigInt(base | bl));
    expect(await env.core.presentationDocuments(shipmentId)).to.equal(BigInt(base | bl));
  });

  it("reverts for an unknown shipment", async function () {
    const env = await loadFixture(fixture);
    await expect(env.core.requiredDocumentsAt(777n, Custody.PickedUp)).to.be.revertedWithCustomError(
      env.core,
      "ShipmentNotFound"
    );
    await expect(env.core.presentationDocuments(777n)).to.be.revertedWithCustomError(
      env.core,
      "ShipmentNotFound"
    );
  });

  it("keeps the lifecycle phases intact for the record", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    const s = await env.core.getShipment(shipmentId);
    expect(Number(s.phase)).to.equal(Phase.Shipped);
    expect(Number(s.custody)).to.equal(Custody.AtExporter);
  });
});
