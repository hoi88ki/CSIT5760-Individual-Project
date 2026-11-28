// Direct unit tests for the companion contracts. The modules accept calls only from their
// `core`, so here we deploy them with the test admin *as* the core; this reaches the internal
// guards that the facade cannot (e.g. `AlreadySettled`, `NotPresented`, `OnlyCore`).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  PaymentTerm,
  Phase,
  Custody,
  DocType,
  CID,
  LC,
  futureDeadline,
} = require("./helpers/fixture");

const bit = (d) => 1 << d;

/** Test-only `IDocumentDirectory` that always resolves to `registryAddress`. */
async function staticDirectory(registryAddress) {
  const D = await ethers.getContractFactory("StaticDocumentDirectory");
  const dir = await D.deploy(registryAddress);
  await dir.waitForDeployment();
  return dir;
}

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
        tracker
          .connect(outsider)
          .createOrder(
            importer.address,
            exporter.address,
            Incoterm.FOB,
            PaymentTerm.Sight,
            0n,
            LC,
            await futureDeadline()
          )
      ).to.be.revertedWithCustomError(tracker, "OnlyCore");
    });

    it("validates applications and deferral terms", async function () {
      const tracker = await deploy();
      await expect(
        tracker.createOrder(
          importer.address,
          ethers.ZeroAddress,
          Incoterm.FOB,
          PaymentTerm.Sight,
          0n,
          LC,
          await futureDeadline()
        )
      ).to.be.revertedWithCustomError(tracker, "ZeroAddress");
      await expect(
        tracker.createOrder(
          ethers.ZeroAddress,
          exporter.address,
          Incoterm.FOB,
          PaymentTerm.Sight,
          0n,
          LC,
          await futureDeadline()
        )
      ).to.be.revertedWithCustomError(tracker, "ZeroAddress");
      await expect(
        tracker.createOrder(
          importer.address,
          exporter.address,
          Incoterm.FOB,
          PaymentTerm.Sight,
          0n,
          0,
          await futureDeadline()
        )
      ).to.be.revertedWithCustomError(tracker, "InvalidAmount");
      await expect(
        tracker.createOrder(importer.address, exporter.address, Incoterm.FOB, PaymentTerm.Sight, 0n, LC, 1)
      ).to.be.revertedWithCustomError(tracker, "InvalidDeadline");
      await expect(
        tracker.createOrder(
          importer.address,
          exporter.address,
          Incoterm.FOB,
          PaymentTerm.Sight,
          3n,
          LC,
          await futureDeadline()
        )
      ).to.be.revertedWithCustomError(tracker, "InvalidDeferral");
      await expect(
        tracker.createOrder(
          importer.address,
          exporter.address,
          Incoterm.FOB,
          PaymentTerm.Deferred,
          0n,
          LC,
          await futureDeadline()
        )
      ).to.be.revertedWithCustomError(tracker, "InvalidDeferral");

      await tracker.createOrder(
        importer.address,
        exporter.address,
        Incoterm.FOB,
        PaymentTerm.Deferred,
        7n,
        LC,
        await futureDeadline()
      );

      const s = await tracker.getShipment(1n);
      expect(s.exporter).to.equal(exporter.address);
      expect(s.importer).to.equal(importer.address);
      expect(s.paymentTerm).to.equal(PaymentTerm.Deferred);
      expect(s.deferredDays).to.equal(7n);
      expect(s.phase).to.equal(Phase.OrderPlaced);
      expect(s.custody).to.equal(Custody.AtExporter);
      expect(await tracker.orderCount()).to.equal(1n);
      expect(await tracker.shipmentCount()).to.equal(1n);
      expect((await tracker.getOrder(1n)).deferredDays).to.equal(7n);
    });

    it("gates ship on the issued credit and the named exporter", async function () {
      const tracker = await deploy();
      await tracker.createOrder(
        importer.address,
        exporter.address,
        Incoterm.FOB,
        PaymentTerm.Sight,
        0n,
        LC,
        await futureDeadline()
      );

      await expect(tracker.ship(9n, exporter.address)).to.be.revertedWithCustomError(tracker, "OrderNotFound");
      await expect(tracker.ship(1n, outsider.address)).to.be.revertedWithCustomError(
        tracker,
        "NotOrderedExporter"
      );
      // The credit is not issued yet (still OrderPlaced).
      await expect(tracker.ship(1n, exporter.address)).to.be.revertedWithCustomError(tracker, "CreditNotIssued");

      await tracker.setPhase(1n, Phase.LCIssued);
      await tracker.ship(1n, exporter.address);
      expect((await tracker.getShipment(1n)).phase).to.equal(Phase.Shipped);
      await expect(tracker.ship(1n, exporter.address)).to.be.revertedWithCustomError(
        tracker,
        "CreditNotIssued"
      );

      await expect(tracker.setRiskHolder(1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(tracker, "ZeroAddress");
      await expect(tracker.setRiskHolder(99n, exporter.address)).to.be.revertedWithCustomError(
        tracker,
        "ShipmentNotFound"
      );
      await expect(tracker.setPhase(99n, Phase.Shipped)).to.be.revertedWithCustomError(tracker, "ShipmentNotFound");
      await expect(tracker.setCustody(99n, Custody.OnVessel)).to.be.revertedWithCustomError(
        tracker,
        "ShipmentNotFound"
      );
    });

    it("reverts for a non-core caller on every mutator", async function () {
      const tracker = await deploy();
      await tracker.createOrder(
        importer.address,
        exporter.address,
        Incoterm.FOB,
        PaymentTerm.Sight,
        0n,
        LC,
        await futureDeadline()
      );
      const out = tracker.connect(outsider);
      await expect(out.ship(1n, exporter.address)).to.be.revertedWithCustomError(tracker, "OnlyCore");
      await expect(out.setPhase(1n, Phase.LCIssued)).to.be.revertedWithCustomError(tracker, "OnlyCore");
      await expect(out.setCustody(1n, Custody.PickedUp)).to.be.revertedWithCustomError(tracker, "OnlyCore");
      await expect(out.setRiskHolder(1n, exporter.address)).to.be.revertedWithCustomError(tracker, "OnlyCore");
      await expect(out.setTokenURI(1n, "ipfs://x")).to.be.revertedWithCustomError(tracker, "OnlyCore");
    });

    it("refuses shipping after the application deadline", async function () {
      const tracker = await deploy();
      const deadline = await futureDeadline(1);
      await tracker.createOrder(
        importer.address,
        exporter.address,
        Incoterm.FOB,
        PaymentTerm.Sight,
        0n,
        LC,
        deadline
      );
      await tracker.setPhase(1n, Phase.LCIssued);
      await time.increaseTo(Number(deadline) + 1);
      await expect(tracker.ship(1n, exporter.address)).to.be.revertedWithCustomError(tracker, "InvalidDeadline");
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
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
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

      // A revoked slot is re-opened for a replacement anchor; the live anchor stays locked.
      await registry.anchor(1n, DocType.CommercialInvoice, CID.extra, exporter.address);
      expect((await registry.getDocument(1n, DocType.CommercialInvoice)).cid).to.equal(CID.extra);
      expect(await registry.isValid(1n, DocType.CommercialInvoice)).to.equal(true);
    });

    it("replaces an existing anchor (valid or revoked) and re-verifies it", async function () {
      const registry = await deploy();
      await registry.anchor(1n, DocType.CommercialInvoice, CID.invoice, exporter.address);

      await expect(registry.replace(1n, DocType.PackingList, CID.packing, exporter.address)).to.be.revertedWithCustomError(
        registry,
        "DocumentNotFound"
      );
      await expect(
        registry.replace(1n, DocType.CommercialInvoice, "", exporter.address)
      ).to.be.revertedWithCustomError(registry, "EmptyCID");
      await expect(
        registry.connect(outsider).replace(1n, DocType.CommercialInvoice, CID.extra, outsider.address)
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");

      // A live anchor may be replaced; the old CID is reported in the event.
      await expect(registry.replace(1n, DocType.CommercialInvoice, CID.extra, exporter.address))
        .to.emit(registry, "DocumentReplaced")
        .withArgs(1n, DocType.CommercialInvoice, exporter.address, CID.invoice, CID.extra);
      expect((await registry.getDocument(1n, DocType.CommercialInvoice)).cid).to.equal(CID.extra);

      // And so may a revoked one: the replacement re-verifies the slot.
      await registry.revoke(1n, DocType.CommercialInvoice);
      await registry.replace(1n, DocType.CommercialInvoice, CID.invoice, importer.address);
      expect(await registry.isValid(1n, DocType.CommercialInvoice)).to.equal(true);
      expect((await registry.getDocument(1n, DocType.CommercialInvoice)).issuer).to.equal(importer.address);
    });
  });

  describe("ComplianceEngine", function () {
    it("guards the constructor", async function () {
      const C = await ethers.getContractFactory("ComplianceEngine");
      await expect(C.deploy(ethers.ZeroAddress, admin.address, admin.address)).to.be.revertedWithCustomError(
        C,
        "ZeroAddress"
      );
      await expect(C.deploy(admin.address, ethers.ZeroAddress, admin.address)).to.be.revertedWithCustomError(
        C,
        "ZeroAddress"
      );
      await expect(C.deploy(admin.address, admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        C,
        "ZeroAddress"
      );
    });

    it("mounts its access control on the directory (core)", async function () {
      const T = await ethers.getContractFactory("ShipmentTracker");
      const tracker = await T.deploy(admin.address);
      await tracker.waitForDeployment();
      const R = await ethers.getContractFactory("DocumentRegistry");
      const registry = await R.deploy(admin.address);
      await registry.waitForDeployment();
      const D = await ethers.getContractFactory("StaticDocumentDirectory");
      const directory = await D.deploy(await registry.getAddress());
      await directory.waitForDeployment();
      const C = await ethers.getContractFactory("ComplianceEngine");
      const compliance = await C.deploy(
        await directory.getAddress(),
        await registry.getAddress(),
        await tracker.getAddress()
      );
      await compliance.waitForDeployment();

      // The directory (the core in production) is the module's role authority.
      expect(await compliance.hasRole(await compliance.DEFAULT_ADMIN_ROLE(), await directory.getAddress())).to.equal(
        true
      );
      expect(await compliance.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
    });

    it("requiredForShipment returns the custody mask for the shipment's Incoterm", async function () {
      const T = await ethers.getContractFactory("ShipmentTracker");
      const tracker = await T.deploy(admin.address);
      await tracker.waitForDeployment();
      const R = await ethers.getContractFactory("DocumentRegistry");
      const registry = await R.deploy(admin.address);
      await registry.waitForDeployment();
      const D = await ethers.getContractFactory("StaticDocumentDirectory");
      const directory = await D.deploy(await registry.getAddress());
      await directory.waitForDeployment();
      const C = await ethers.getContractFactory("ComplianceEngine");
      const compliance = await C.deploy(
        await directory.getAddress(),
        await registry.getAddress(),
        await tracker.getAddress()
      );
      await compliance.waitForDeployment();

      await tracker.createOrder(
        importer.address,
        exporter.address,
        Incoterm.CIF,
        PaymentTerm.Sight,
        0n,
        LC,
        await futureDeadline()
      );
      const base = bit(DocType.CommercialInvoice) | bit(DocType.PackingList);
      expect(await compliance.requiredForShipment(1n, Custody.PickedUp)).to.equal(BigInt(base));
      expect(await compliance.presentationForShipment(1n)).to.equal(
        BigInt(base | bit(DocType.InspectionCertificate) | bit(DocType.BillOfLadingOrAWB) | bit(DocType.InsuranceCertificate))
      );
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
      const compliance = await C.deploy(
        await (await staticDirectory(await registry.getAddress())).getAddress(),
        await registry.getAddress(),
        await tracker.getAddress()
      );
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

    async function makeShipment(tracker, term = Incoterm.FOB, paymentTerm = PaymentTerm.Sight, deferredDays = 0n) {
      await tracker.createOrder(
        importer.address,
        exporter.address,
        term,
        paymentTerm,
        deferredDays,
        LC,
        await futureDeadline()
      );
      await tracker.setPhase(1n, Phase.Shipped);
      return 1n;
    }

    const CIF_PRESENTATION =
      bit(DocType.CommercialInvoice) |
      bit(DocType.PackingList) |
      bit(DocType.InspectionCertificate) |
      bit(DocType.BillOfLadingOrAWB) |
      bit(DocType.InsuranceCertificate);

    async function anchorPresentationSet(registry, id, term) {
      await registry.anchor(id, DocType.CommercialInvoice, CID.invoice, exporter.address);
      await registry.anchor(id, DocType.PackingList, CID.packing, exporter.address);
      if (term !== Incoterm.EXW) {
        await registry.anchor(id, DocType.InspectionCertificate, CID.inspection, admin.address);
      }
      if (term === Incoterm.CIF) {
        await registry.anchor(id, DocType.InsuranceCertificate, CID.insurance, admin.address);
      }
      if (term === Incoterm.DDP) {
        await registry.anchor(id, DocType.CertificateOfOrigin, CID.coo, exporter.address);
        await registry.anchor(id, DocType.CustomsClearance, CID.clearance, admin.address);
      }
      await registry.anchor(id, DocType.BillOfLadingOrAWB, CID.bl, admin.address);
    }

    it("guards the constructor and onlyCore", async function () {
      const L = await ethers.getContractFactory("LetterOfCredit");
      await expect(
        L.deploy(ethers.ZeroAddress, admin.address, admin.address, admin.address, admin.address)
      ).to.be.revertedWithCustomError(L, "ZeroAddress");
      await expect(
        L.deploy(admin.address, ethers.ZeroAddress, admin.address, admin.address, admin.address)
      ).to.be.revertedWithCustomError(L, "ZeroAddress");
      await expect(
        L.deploy(admin.address, admin.address, ethers.ZeroAddress, admin.address, admin.address)
      ).to.be.revertedWithCustomError(L, "ZeroAddress");
      await expect(
        L.deploy(admin.address, admin.address, admin.address, ethers.ZeroAddress, admin.address)
      ).to.be.revertedWithCustomError(L, "ZeroAddress");
      await expect(
        L.deploy(admin.address, admin.address, admin.address, admin.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(L, "ZeroAddress");

      const { loc } = await deploy();
      await expect(loc.connect(outsider).issue(1n, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0))
        .to.be.revertedWithCustomError(loc, "AccessControlUnauthorizedAccount");
      await expect(loc.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(loc, "ZeroAddress");
    });

    it("reverts for a non-controller caller on every mutator", async function () {
      const { loc } = await deploy();
      const acc = await loc.connect(outsider);
      await expect(acc.recordPresentation(1n)).to.be.revertedWithCustomError(
        loc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(acc.honor(1n, exporter.address)).to.be.revertedWithCustomError(
        loc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(acc.drawDeferred(1n, exporter.address)).to.be.revertedWithCustomError(
        loc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(acc.payDuty(1n, outsider.address, 0n)).to.be.revertedWithCustomError(
        loc,
        "AccessControlUnauthorizedAccount"
      );
      await expect(acc.reclaim(1n)).to.be.revertedWithCustomError(loc, "AccessControlUnauthorizedAccount");
      await expect(acc.setTreasury(outsider.address)).to.be.revertedWithCustomError(
        loc,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("enforces issuance, presentation, examination and drawing ordering", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker);

      // Nothing issued yet: every credit action reverts.
      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(loc, "NotIssued");
      await expect(loc.drawDeferred(id, exporter.address)).to.be.revertedWithCustomError(loc, "NotHonored");
      await expect(loc.recordPresentation(id)).to.be.revertedWithCustomError(loc, "NotIssued");
      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "NotIssued");
      await expect(loc.payDuty(id, importer.address, 0)).to.be.revertedWithCustomError(loc, "NotIssued");
      await expect(loc.issue(id, admin.address, exporter.address, 0, PaymentTerm.Sight, 0n, 0)).to.be.revertedWithCustomError(
        loc,
        "InvalidAmount"
      );

      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, CIF_PRESENTATION);
      await expect(loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, CIF_PRESENTATION)).to.be
        .revertedWithCustomError(loc, "AlreadyIssued");
      expect((await loc.getLC(id)).issued).to.equal(true);

      await loc.payDuty(id, importer.address, 0); // duty tokens are moved by the core in production
      await expect(loc.payDuty(id, importer.address, 0)).to.be.revertedWithCustomError(loc, "DutyAlreadyPaid");

      // Honor before presentation is refused.
      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(loc, "NotPresented");

      // Present (the stipulated set must be anchored first for the module's examination).
      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);
      await expect(loc.recordPresentation(id)).to.be.revertedWithCustomError(loc, "AlreadyPresented");
      expect((await loc.getLC(id)).presented).to.equal(true);

      const before = await usd.balanceOf(exporter.address);
      expect(await loc.connect(admin).honor.staticCall(id, exporter.address)).to.equal(true); // sight: pays now
      await loc.connect(admin).honor(id, exporter.address);
      expect(await usd.balanceOf(exporter.address)).to.equal(before + LC);
      expect((await loc.getLC(id)).honored).to.equal(true);
      expect(await loc.isPaid(id)).to.equal(true);

      // The sight credit already paid: the settled guard fires before the honored guard.
      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadySettled");
      await expect(loc.drawDeferred(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadySettled");
      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "AlreadySettled");
    });

    it("refuses to honor a discrepant presentation (missing stipulated document)", async function () {
      const { usd, tracker, registry, loc, compliance } = await deploy();
      const id = await makeShipment(tracker, Incoterm.FOB);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);

      await registry.anchor(id, DocType.CommercialInvoice, CID.invoice, exporter.address);
      await registry.anchor(id, DocType.PackingList, CID.packing, exporter.address);
      await loc.recordPresentation(id);

      // The inspection certificate and B/L are missing from the stipulated FOB set.
      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(
        compliance,
        "MissingMandatoryDocument"
      );
    });

    it("refuses to honor a DDP credit whose duty has not been paid", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker, Incoterm.DDP);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);

      await anchorPresentationSet(registry, id, Incoterm.DDP);
      await loc.recordPresentation(id);

      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(loc, "DutyNotPaid");
      await loc.payDuty(id, exporter.address, 0);
      expect(await loc.connect(admin).honor.staticCall(id, exporter.address)).to.equal(true);
      await loc.connect(admin).honor(id, exporter.address);
      expect(await loc.isPaid(id)).to.equal(true);
    });

    it("defers the proceeds to maturity and refuses an early draw", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker, Incoterm.FOB, PaymentTerm.Deferred, 3n);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Deferred, 3n, 0);

      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);

      expect(await loc.connect(admin).honor.staticCall(id, exporter.address)).to.equal(false); // scheduled
      await loc.connect(admin).honor(id, exporter.address);
      expect((await loc.getLC(id)).honored).to.equal(true);
      expect(await loc.isPaid(id)).to.equal(false);

      // An honored-but-unpaid (deferred) credit cannot be honored a second time.
      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadyHonored");

      await expect(loc.drawDeferred(id, exporter.address)).to.be.revertedWithCustomError(
        loc,
        "MaturityNotReached"
      );

      const maturity = Number((await loc.getLC(id)).maturityAt);
      expect(maturity).to.be.closeTo(Number(await time.latest()) + 3 * 24 * 3600, 5);

      await time.increaseTo(maturity + 1);
      const before = await usd.balanceOf(exporter.address);
      await loc.drawDeferred(id, exporter.address);
      expect(await usd.balanceOf(exporter.address)).to.equal(before + LC);
      await expect(loc.drawDeferred(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadySettled");
    });

    it("returns the funds of an expired unused credit to the issuing bank", async function () {
      const { usd, tracker, loc } = await deploy();
      const id = await makeShipment(tracker);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);

      // Before the deadline.
      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "DeadlineNotReached");

      await time.increaseTo(Number((await tracker.getShipment(id)).deadline) + 1);
      const bankBefore = await usd.balanceOf(admin.address);
      await loc.reclaim(id);
      expect(await usd.balanceOf(admin.address)).to.equal(bankBefore + LC);
      expect((await loc.getLC(id)).reclaimed).to.equal(true);
      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "AlreadySettled");
      await expect(loc.honor(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadySettled");
    });

    it("refuses to reclaim a presented credit", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);
      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);

      await time.increaseTo(Number((await tracker.getShipment(id)).deadline) + 1);
      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "CreditPresented");
    });

    it("refunds escrowed duty to its payer when an unused credit is reclaimed", async function () {
      const { usd, tracker, loc } = await deploy();
      const id = await makeShipment(tracker, Incoterm.DDP);
      await usd.mint(await loc.getAddress(), LC + 7n);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);
      await loc.payDuty(id, exporter.address, 7n);

      await time.increaseTo(Number((await tracker.getShipment(id)).deadline) + 1);
      const bankBefore = await usd.balanceOf(admin.address);
      const payerBefore = await usd.balanceOf(exporter.address);
      await expect(loc.reclaim(id)).to.emit(loc, "LCReclaimed").withArgs(id, admin.address, LC, 7n);

      expect(await usd.balanceOf(admin.address)).to.equal(bankBefore + LC);
      expect(await usd.balanceOf(exporter.address)).to.equal(payerBefore + 7n);
      expect(await usd.balanceOf(await loc.getAddress())).to.equal(0n);
    });

    it("refuses to reclaim or draw once the proceeds have been paid", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker, Incoterm.FOB, PaymentTerm.Deferred, 1n);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Deferred, 1n, 0);
      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);
      await loc.connect(admin).honor(id, exporter.address);
      await time.increaseTo(Number((await loc.getLC(id)).maturityAt) + 1);
      await loc.drawDeferred(id, exporter.address);

      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "AlreadySettled");
      await expect(loc.drawDeferred(id, exporter.address)).to.be.revertedWithCustomError(loc, "AlreadySettled");
    });

    it("settles the applicant's reimbursement on-chain once the proceeds are released", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker, Incoterm.FOB, PaymentTerm.Deferred, 1n);
      await usd.mint(await loc.getAddress(), LC);
      await usd.mint(importer.address, LC);
      await usd.connect(importer).approve(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Deferred, 1n, 0);
      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);
      await loc.connect(admin).honor(id, exporter.address);

      // Honored (deferred) but not yet drawn: the bank is not out of pocket yet.
      await expect(loc.reimburse(id)).to.be.revertedWithCustomError(loc, "NotPaid");

      await time.increaseTo(Number((await loc.getLC(id)).maturityAt) + 1);
      await loc.drawDeferred(id, exporter.address);

      // Proceeds released: TradeUSD is pulled from the trade's importer to the issuing bank.
      const bankBefore = await usd.balanceOf(admin.address);
      const importerBefore = await usd.balanceOf(importer.address);
      await expect(loc.reimburse(id))
        .to.emit(loc, "LCReimbursed")
        .withArgs(id, importer.address, admin.address, LC);
      expect(await usd.balanceOf(admin.address)).to.equal(bankBefore + LC);
      expect(await usd.balanceOf(importer.address)).to.equal(importerBefore - LC);
      const lc = await loc.getLC(id);
      expect(lc.reimbursed).to.equal(true);
      expect(Number(lc.reimbursedAt)).to.be.greaterThan(0);
      await expect(loc.reimburse(id)).to.be.revertedWithCustomError(loc, "AlreadyReimbursed");
    });

    it("refuses reimbursement for an unpaid or reclaimed credit", async function () {
      const { usd, tracker, loc } = await deploy();
      const id = await makeShipment(tracker);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);

      // Issued but never honored/paid: nothing has left the bank's pocket.
      await expect(loc.reimburse(id)).to.be.revertedWithCustomError(loc, "NotPaid");

      await time.increaseTo(Number((await tracker.getShipment(id)).deadline) + 1);
      await loc.reclaim(id);
      await expect(loc.reimburse(id)).to.be.revertedWithCustomError(loc, "AlreadySettled");
    });

    it("refuses to reclaim an honored deferred credit", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker, Incoterm.FOB, PaymentTerm.Deferred, 5n);
      await usd.mint(await loc.getAddress(), LC);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Deferred, 5n, 0);
      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);
      await loc.honor(id, exporter.address);

      await time.increaseTo(Number((await tracker.getShipment(id)).deadline) + 1);
      await expect(loc.reclaim(id)).to.be.revertedWithCustomError(loc, "AlreadyHonored");
    });

    it("forwards escrowed duty to the treasury when the proceeds are released", async function () {
      const { usd, tracker, registry, loc } = await deploy();
      const id = await makeShipment(tracker);
      await usd.mint(await loc.getAddress(), LC + 5n);
      await loc.issue(id, admin.address, exporter.address, LC, PaymentTerm.Sight, 0n, 0);
      await loc.payDuty(id, importer.address, 5n);
      await loc.setTreasury(outsider.address);
      await anchorPresentationSet(registry, id, Incoterm.FOB);
      await loc.recordPresentation(id);

      const expBefore = await usd.balanceOf(exporter.address);
      const treBefore = await usd.balanceOf(outsider.address);
      await loc.honor(id, exporter.address);
      expect(await usd.balanceOf(exporter.address)).to.equal(expBefore + LC);
      expect(await usd.balanceOf(outsider.address)).to.equal(treBefore + 5n);
    });

    it("exposes the LC and treasury views", async function () {
      const { loc } = await deploy();
      await loc.setTreasury(outsider.address);
      expect(await loc.treasury()).to.equal(outsider.address);
      expect(await loc.getLC(1n)).to.not.equal(undefined);
      expect((await loc.getLC(1n)).issued).to.equal(false);
      expect((await loc.getLC(1n)).presented).to.equal(false);
      expect((await loc.getLC(1n)).honored).to.equal(false);
      expect(await loc.isPaid(1n)).to.equal(false);
      expect(await loc.escrowBalance()).to.equal(0n);
    });
  });
});
