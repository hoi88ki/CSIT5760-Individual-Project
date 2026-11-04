const { expect } = require("chai");
const { ethers } = require("hardhat");
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

describe("Views & convenience getters", function () {
  const fixture = deployTradeChain;

  it("payoutPhaseOf maps each Incoterm to its risk-transfer milestone", async function () {
    const env = await loadFixture(fixture);
    expect(await env.core.payoutPhaseOf(Incoterm.EXW)).to.equal(Phase.PickedUp);
    expect(await env.core.payoutPhaseOf(Incoterm.FOB)).to.equal(Phase.LoadedOnVessel);
    expect(await env.core.payoutPhaseOf(Incoterm.CIF)).to.equal(Phase.LoadedOnVessel);
    expect(await env.core.payoutPhaseOf(Incoterm.DDP)).to.equal(Phase.Delivered);
  });

  it("requiredDocumentsAt returns the per-phase bitmask (0 for non-milestone phases)", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });

    const bit = (d) => 1 << d;
    const base = bit(DocType.CommercialInvoice) | bit(DocType.PackingList);
    const loading =
      base | bit(DocType.InspectionCertificate) | bit(DocType.BillOfLadingOrAWB) | bit(DocType.InsuranceCertificate);

    expect(await env.core.requiredDocumentsAt(shipmentId, Phase.PickedUp)).to.equal(BigInt(base));
    expect(await env.core.requiredDocumentsAt(shipmentId, Phase.LoadedOnVessel)).to.equal(BigInt(loading));
    // Created is not a milestone phase → empty mask.
    expect(await env.core.requiredDocumentsAt(shipmentId, Phase.Created)).to.equal(0n);
  });

  it("exposes order/shipment/document getters", async function () {
    const env = await loadFixture(fixture);
    const { orderId, shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    await fundLC(env, shipmentId);
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);

    expect(await env.core.orderCount()).to.equal(1n);
    expect(await env.core.shipmentCount()).to.equal(1n);

    const order = await env.core.getOrder(orderId);
    expect(order.fulfilled).to.equal(true);
    expect(order.shipmentId).to.equal(shipmentId);

    const doc = await env.core.getDocument(shipmentId, DocType.InspectionCertificate);
    expect(doc.cid).to.equal(CID.inspection);
    expect(doc.certId).to.equal(1n);
    expect(await env.core.hasValidDocument(shipmentId, DocType.InspectionCertificate)).to.equal(true);

    // Unknown shipment/document reads return empty values (no revert).
    const empty = await env.core.getDocument(999n, DocType.CommercialInvoice);
    expect(empty.cid).to.equal("");
    expect(await env.core.hasValidDocument(999n, DocType.CommercialInvoice)).to.equal(false);
  });

  it("reverts payoutPhaseOf/requiredDocumentsAt for an unknown shipment", async function () {
    const env = await loadFixture(fixture);
    await expect(env.core.requiredDocumentsAt(777n, Phase.PickedUp)).to.be.revertedWithCustomError(
      env.core,
      "ShipmentNotFound"
    );
  });

  it("rejects deploying the core with a zero settlement token", async function () {
    const Core = await ethers.getContractFactory("TradeChainCore");
    await expect(Core.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Core, "ZeroAddress");
  });

  it("covers every Incoterm x phase required-document combination", async function () {
    const env = await loadFixture(fixture);
    const phases = [
      Phase.Created,
      Phase.LCFunded,
      Phase.PickedUp,
      Phase.LoadedOnVessel,
      Phase.Delivered,
      Phase.Settled,
      Phase.Reclaimed,
    ];
    for (const term of [Incoterm.EXW, Incoterm.FOB, Incoterm.CIF, Incoterm.DDP]) {
      const { shipmentId } = await createOrderAndShipment(env, { term });
      for (const phase of phases) {
        await env.core.requiredDocumentsAt(shipmentId, phase);
      }
    }
  });

  it("exercises the token helper views through the deployed core", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    await fundLC(env, shipmentId);
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);

    expect(await env.ebl.exists(shipmentId)).to.equal(true);
    expect(await env.ebl.nextTokenId()).to.equal(shipmentId + 1n);
    expect(await env.ebl.supportsInterface("0x80ac58cd")).to.equal(true);

    expect(await env.cert.exists(1n)).to.equal(true);
    expect(await env.cert.nextTokenId()).to.equal(2n);
    expect(await env.cert.supportsInterface("0x7965db0b")).to.equal(true);
  });
});
