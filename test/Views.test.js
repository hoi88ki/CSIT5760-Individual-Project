const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  PaymentTerm,
  Phase,
  Custody,
  DocType,
  CID,
  LC,
  deployTradeChain,
  createOrderAndShipment,
  toPresentable,
  present,
} = require("./helpers/fixture");

describe("Views & convenience getters", function () {
  const fixture = deployTradeChain;

  it("exposes order/shipment/document/LC getters", async function () {
    const env = await loadFixture(fixture);
    const { orderId, shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    await env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection);

    expect(await env.core.orderCount()).to.equal(1n);
    expect(await env.core.shipmentCount()).to.equal(1n);

    const order = await env.core.getOrder(orderId);
    expect(order.exporter).to.equal(env.exporter.address);
    expect(order.importer).to.equal(env.importer.address);
    expect(order.paymentTerm).to.equal(PaymentTerm.Sight);

    const doc = await env.core.getDocument(shipmentId, DocType.InspectionCertificate);
    expect(doc.cid).to.equal(CID.inspection);
    expect(doc.verified).to.equal(true);
    expect(await env.core.hasValidDocument(shipmentId, DocType.InspectionCertificate)).to.equal(true);

    const lc = await env.core.getLC(shipmentId);
    expect(lc.issued).to.equal(true);
    expect(lc.issuingBank).to.equal(env.bank.address);
    expect(lc.beneficiary).to.equal(env.exporter.address);
    expect(lc.paid).to.equal(false);

    // Unknown reads return empty values (no revert).
    const empty = await env.core.getDocument(999n, DocType.CommercialInvoice);
    expect(empty.cid).to.equal("");
    expect(await env.core.hasValidDocument(999n, DocType.CommercialInvoice)).to.equal(false);
  });

  it("exposes the companion contract addresses", async function () {
    const env = await loadFixture(fixture);
    expect(await env.core.settlementToken()).to.not.equal(ethers.ZeroAddress);
    expect(await env.core.shipmentTracker()).to.not.equal(ethers.ZeroAddress);
    expect(await env.tracker.name()).to.equal("TradeChain Shipment Title");
    expect(await env.core.documentRegistry()).to.not.equal(ethers.ZeroAddress);
    expect(await env.core.complianceEngine()).to.not.equal(ethers.ZeroAddress);
    expect(await env.core.letterOfCredit()).to.not.equal(ethers.ZeroAddress);
  });

  it("supports an injected settlement token", async function () {
    const [admin] = await ethers.getSigners();
    const USD = await ethers.getContractFactory("TradeUSD");
    const usd = await USD.deploy(admin.address, "External USD", "xUSD", 6);
    await usd.waitForDeployment();

    const Core = await ethers.getContractFactory("TradeChainCore");
    const core = await Core.deploy(await usd.getAddress());
    await core.waitForDeployment();

    expect(await core.settlementToken()).to.equal(await usd.getAddress());

    await expect(Core.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Core, "ZeroAddress");
  });

  it("covers every Incoterm x custody required-document combination", async function () {
    const env = await loadFixture(fixture);
    const custodies = [
      Custody.AtExporter,
      Custody.PickedUp,
      Custody.OnVessel,
      Custody.Delivered,
    ];
    for (const term of [Incoterm.EXW, Incoterm.FOB, Incoterm.CIF, Incoterm.DDP]) {
      const { shipmentId } = await createOrderAndShipment(env, { term });
      for (const custody of custodies) {
        await env.core.requiredDocumentsAt(shipmentId, custody);
      }
      await env.core.presentationDocuments(shipmentId);
    }
  });

  it("exposes the examination preview and presentation compliance", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.CIF });

    let [ok, missing] = await env.core.examinePresentation(shipmentId);
    expect(ok).to.equal(false);
    expect(missing).to.equal(DocType.InspectionCertificate); // invoice+packing already anchored

    await toPresentable(env, shipmentId);
    [ok, missing] = await env.core.examinePresentation(shipmentId);
    expect(ok).to.equal(true);

    await present(env, shipmentId);
    expect(await env.compliance.isPresentationCompliant(shipmentId, Incoterm.CIF)).to.equal(true);
  });

  it("exposes token helper views through the deployed core", async function () {
    const env = await loadFixture(fixture);
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    expect(await env.nft.exists(shipmentId)).to.equal(true);
    expect(await env.nft.supportsInterface("0x80ac58cd")).to.equal(true);
    expect(await env.token.decimals()).to.equal(6);
  });

  it("tracks the credit phases on the shared record", async function () {
    const env = await loadFixture(fixture);
    const { orderId, shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    expect(Number((await env.core.getShipment(orderId)).phase)).to.equal(Phase.Shipped);

    await toPresentable(env, shipmentId);
    await present(env, shipmentId);
    expect(Number((await env.core.getShipment(shipmentId)).phase)).to.equal(Phase.Presented);
  });
});
