// Direct unit tests for the companion contracts. The modules accept calls only from their
// `core`, so here we deploy them with the test admin *as* the core; this reaches the internal
// guards that the facade cannot (e.g. `AlreadySettled`, `NotPayoutPhase`, `OnlyCore`).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { Incoterm, Phase, DocType, CID, LC, futureDeadline } = require("./helpers/fixture");

describe("Companion contract internals", function () {
  let admin, exporter, importer, outsider;

  before(async function () {
    [admin, exporter, importer, , , , outsider] = await ethers.getSigners();
  });

  describe("ShipmentTracker", function () {
    async function deploy() {
      const T = await ethers.getContractFactory("ShipmentTracker");
      const tracker = await T.deploy(admin.address);
      await tracker.waitForDeployment();
      return tracker;
    }

    it("guards the constructor and onlyCore", async function () {
      const T = await ethers.getContractFactory("ShipmentTracker");
      await expect(T.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(T, "ZeroAddress");

      const tracker = await deploy();
      await expect(
        tracker.connect(outsider).createOrder(importer.address, exporter.address, Incoterm.FOB, LC, await futureDeadline())
      ).to.be.revertedWithCustomError(tracker, "OnlyCore");
    });

    it("validates orders and fulfilment", async function () {
      const tracker = await deploy();
      await expect(
        tracker.createOrder(importer.address, ethers.ZeroAddress, Incoterm.FOB, LC, await futureDeadline())
      ).to.be.revertedWithCustomError(tracker, "ZeroAddress");
      await expect(
        tracker.createOrder(importer.address, exporter.address, Incoterm.FOB, 0, await futureDeadline())
      ).to.be.revertedWithCustomError(tracker, "InvalidAmount");
      await expect(
        tracker.createOrder(importer.address, exporter.address, Incoterm.FOB, LC, 1)
      ).to.be.revertedWithCustomError(tracker, "InvalidDeadline");

      await tracker.createOrder(importer.address, exporter.address, Incoterm.FOB, LC, await futureDeadline());
      await expect(tracker.fulfilOrder(9n, exporter.address)).to.be.revertedWithCustomError(tracker, "OrderNotFound");
      await expect(tracker.fulfilOrder(1n, outsider.address)).to.be.revertedWithCustomError(
        tracker,
        "NotOrderedExporter"
      );

      await tracker.fulfilOrder(1n, exporter.address);
      await expect(tracker.fulfilOrder(1n, exporter.address)).to.be.revertedWithCustomError(
        tracker,
        "OrderAlreadyFulfilled"
      );

      await expect(tracker.setRiskHolder(1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(tracker, "ZeroAddress");
      await expect(tracker.setPhase(99n, Phase.PickedUp)).to.be.revertedWithCustomError(tracker, "ShipmentNotFound");

      const s = await tracker.getShipment(1n);
      expect(s.exporter).to.equal(exporter.address);
      expect(s.importer).to.equal(importer.address);
      expect(await tracker.orderCount()).to.equal(1n);
      expect(await tracker.shipmentCount()).to.equal(1n);
    });
  });

  describe("DocumentRegistry", function () {
    async function deploy() {
      const R = await ethers.getContractFactory("DocumentRegistry");
      const registry = await R.deploy(admin.address);
      await registry.waitForDeployment();
      return registry;
    }

    it("guards the constructor and onlyCore", async function () {
      const R = await ethers.getContractFactory("DocumentRegistry");
      await expect(R.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(R, "ZeroAddress");

      const registry = await deploy();
      await expect(
        registry.connect(outsider).anchor(1n, DocType.CommercialInvoice, CID.invoice, outsider.address)
      ).to.be.revertedWithCustomError(registry, "OnlyCore");
    });

    it("anchors once and revokes once", async function () {
      const registry = await deploy();
      await expect(
        registry.anchor(1n, DocType.CommercialInvoice, "", importer.address)
      ).to.be.revertedWithCustomError(registry, "EmptyCID");

      await registry.anchor(1n, DocType.CommercialInvoice, CID.invoice, exporter.address);
      await expect(
        registry.anchor(1n, DocType.CommercialInvoice, CID.extra, exporter.address)
      ).to.be.revertedWithCustomError(registry, "DocumentLocked");

      expect(await registry.isPresent(1n, DocType.CommercialInvoice)).to.equal(true);
      expect(await registry.isValid(1n, DocType.CommercialInvoice)).to.equal(true);
      expect(await registry.issuerOf(1n, DocType.CommercialInvoice)).to.equal(exporter.address);

      await expect(registry.revoke(1n, DocType.PackingList)).to.be.revertedWithCustomError(
        registry,
        "DocumentNotFound"
      );
      await registry.revoke(1n, DocType.CommercialInvoice);
      expect(await registry.isValid(1n, DocType.CommercialInvoice)).to.equal(false);
      await expect(registry.revoke(1n, DocType.CommercialInvoice)).to.be.revertedWithCustomError(
        registry,
        "AlreadyRevoked"
      );
    });
  });

  describe("ComplianceEngine", function () {
    it("guards the constructor", async function () {
      const C = await ethers.getContractFactory("ComplianceEngine");
      await expect(C.deploy(ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(C, "ZeroAddress");
      await expect(C.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(C, "ZeroAddress");
    });
  });

  describe("LetterOfCredit", function () {
    async function deploy() {
      const USD = await ethers.getContractFactory("TradeUSD");
      const usd = await USD.deploy(admin.address, "TradeChain USD", "tUSD", 6);
      await usd.waitForDeployment();

      const T = await ethers.getContractFactory("ShipmentTracker");
      const tracker = await T.deploy(admin.address);
      await tracker.waitForDeployment();

      const R = await ethers.getContractFactory("DocumentRegistry");
      const registry = await R.deploy(admin.address);
      await registry.waitForDeployment();

      const C = await ethers.getContractFactory("ComplianceEngine");
      const compliance = await C.deploy(await registry.getAddress(), await tracker.getAddress());
      await compliance.waitForDeployment();

      const L = await ethers.getContractFactory("LetterOfCredit");
      const loc = await L.deploy(
        admin.address,
        await usd.getAddress(),
        await tracker.getAddress(),
        await compliance.getAddress(),
        admin.address
      );
      await loc.waitForDeployment();

      return { usd, tracker, registry, compliance, loc };
    }

    async function makeShipment(tracker, term = Incoterm.FOB) {
      await tracker.createOrder(importer.address, exporter.address, term, LC, await futureDeadline());
      await tracker.fulfilOrder(1n, exporter.address);
      return 1n;
    }

    it("guards the constructor and onlyCore", async function () {
      const L = await ethers.getContractFactory("LetterOfCredit");
      await expect(
        L.deploy(ethers.ZeroAddress, admin.address, admin.address, admin.address, admin.address)
      ).to.be.revertedWithCustomError(L, "ZeroAddress");

      const { loc } = await deploy();
      await expect(loc.connect(outsider).fund(1n, importer.address, LC)).to.be.revertedWithCustomError(
        loc,
        "OnlyCore"
      );
      await expect(loc.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(loc, "ZeroAddress");
    });

    it("enforces funding, duty and settlement ordering", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker);

      await expect(loc.settle(id, exporter.address)).to.be.revertedWithCustomError(loc, "NotFunded");
      await expect(loc.refund(id)).to.be.revertedWithCustomError(loc, "NotFunded");
      await expect(loc.payDuty(id, importer.address, 0)).to.be.revertedWithCustomError(loc, "NotFunded");

      await usd.mint(await loc.getAddress(), LC);
      await loc.fund(id, importer.address, LC);
      await expect(loc.fund(id, importer.address, LC)).to.be.revertedWithCustomError(loc, "AlreadyFunded");

      await loc.payDuty(id, importer.address, 0); // duty tokens are moved by the core in production
      await expect(loc.payDuty(id, importer.address, 0)).to.be.revertedWithCustomError(loc, "DutyAlreadyPaid");

      // FOB pays at LoadedOnVessel, but the shipment is still Created → wrong phase.
      await expect(loc.settle(id, exporter.address)).to.be.revertedWithCustomError(loc, "NotPayoutPhase");

      // Move to the payout phase and anchor the required documents.
      await tracker.setPhase(id, Phase.LoadedOnVessel);
      await registry.anchor(id, DocType.CommercialInvoice, CID.invoice, exporter.address);
      await registry.anchor(id, DocType.PackingList, CID.packing, exporter.address);
      await registry.anchor(id, DocType.InspectionCertificate, CID.inspection, admin.address);
      await registry.anchor(id, DocType.BillOfLadingOrAWB, CID.bl, admin.address);

      const before = await usd.balanceOf(exporter.address);
      await loc.settle(id, exporter.address);
      expect(await usd.balanceOf(exporter.address)).to.equal(before + LC);
      expect(await loc.isPaid(id)).to.equal(true);
      await expect(loc.settle(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadySettled");
      await expect(loc.refund(id)).to.be.revertedWithCustomError(loc, "AlreadySettled");
    });

    it("enforces the refund (reclaim) window", async function () {
      const { usd, tracker, loc } = await deploy();
      const id = await makeShipment(tracker);
      await usd.mint(await loc.getAddress(), LC);
      await loc.fund(id, importer.address, LC);

      // Before the deadline.
      await expect(loc.refund(id)).to.be.revertedWithCustomError(loc, "DeadlineNotReached");

      // Past the deadline but the exporter has shipped → nothing to reclaim.
      await tracker.setPhase(id, Phase.PickedUp);
      await time.increaseTo(Number((await tracker.getShipment(id)).deadline) + 1);
      await expect(loc.refund(id)).to.be.revertedWithCustomError(loc, "NothingToReclaim");

      // Fresh shipment: never shipped → refund succeeds.
      await tracker.createOrder(importer.address, exporter.address, Incoterm.FOB, LC, await futureDeadline());
      await tracker.fulfilOrder(2n, exporter.address);
      await usd.mint(await loc.getAddress(), LC);
      await loc.fund(2n, importer.address, LC);
      await tracker.setPhase(2n, Phase.LCFunded);
      await time.increaseTo(Number((await tracker.getShipment(2n)).deadline) + 1);
      const before = await usd.balanceOf(importer.address);
      await loc.refund(2n);
      expect(await usd.balanceOf(importer.address)).to.equal(before + LC);
      expect(await loc.escrowBalance()).to.equal(LC); // shipment #1's escrow remains stuck at PickedUp
    });

    it("exposes the LC and treasury setters", async function () {
      const { loc } = await deploy();
      await loc.setTreasury(outsider.address);
      expect(await loc.treasury()).to.equal(outsider.address);
      expect(await loc.getLC(1n)).to.not.equal(undefined);
      expect(await loc.isPaid(1n)).to.equal(false);
    });
  });
});
