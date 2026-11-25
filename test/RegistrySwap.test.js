const { expect } = require("chai");
const { ethers } = require("hardhat");
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

describe("Swappable DocumentRegistry & mounted module access control", function () {
  const fixture = deployTradeChain;

  async function deploySecondRegistry(env) {
    const R = await ethers.getContractFactory("DocumentRegistry");
    const reg = await R.deploy(await env.core.getAddress());
    await reg.waitForDeployment();
    return reg;
  }

  describe("setDocumentRegistry", function () {
    it("is restricted to the admin or ROLE_REGISTRY_ADMIN", async function () {
      const env = await loadFixture(fixture);
      const second = await deploySecondRegistry(env);

      await expect(env.core.connect(env.outsider).setDocumentRegistry(await second.getAddress()))
        .to.be.revertedWithCustomError(env.core, "Unauthorized");
      await expect(env.core.connect(env.exporter).setDocumentRegistry(await second.getAddress()))
        .to.be.revertedWithCustomError(env.core, "Unauthorized");

      // The admin grants the dedicated registry-admin role; its holder may swap.
      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_REGISTRY_ADMIN()], [env.bank.address]);
      await env.core.connect(env.bank).setDocumentRegistry(await second.getAddress());
      expect(await env.core.documentRegistry()).to.equal(await second.getAddress());
    });

    it("validates the replacement registry", async function () {
      const env = await loadFixture(fixture);

      await expect(env.core.connect(env.admin).setDocumentRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        env.core,
        "ZeroAddress"
      );
      await expect(env.core.connect(env.admin).setDocumentRegistry(await env.registry.getAddress()))
        .to.be.revertedWithCustomError(env.core, "RegistryAlreadyActive");

      // Bound to a different core.
      const R = await ethers.getContractFactory("DocumentRegistry");
      const foreign = await R.deploy(env.outsider.address);
      await foreign.waitForDeployment();
      await expect(env.core.connect(env.admin).setDocumentRegistry(await foreign.getAddress()))
        .to.be.revertedWithCustomError(env.core, "RegistryNotBoundToCore");

      // Correct binding but look-alike code: it could forge `isValid` for compliance.
      const F = await ethers.getContractFactory("FakeRegistry");
      const fake = await F.deploy(await env.core.getAddress());
      await fake.waitForDeployment();
      await expect(env.core.connect(env.admin).setDocumentRegistry(await fake.getAddress()))
        .to.be.revertedWithCustomError(env.core, "RegistryInvalidCode");
    });

    it("routes new anchors to the new registry while old anchors keep resolving", async function () {
      const env = await loadFixture(fixture);
      const second = await deploySecondRegistry(env);

      // In-flight trade anchored in the original registry.
      const a = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await env.core.connect(env.verifier).anchorDocument(a.shipmentId, DocType.InspectionCertificate, CID.inspection);

      expect(await env.core.documentRegistryOf(a.shipmentId, DocType.InspectionCertificate)).to.equal(
        await env.registry.getAddress()
      );

      await env.core.connect(env.admin).setDocumentRegistry(await second.getAddress());

      // New anchors land in the new registry ...
      const b = await createOrderAndShipment(env, { term: Incoterm.FOB });
      await env.core.connect(env.verifier).anchorDocument(b.shipmentId, DocType.InspectionCertificate, CID.inspection);
      expect(await env.core.documentRegistryOf(b.shipmentId, DocType.InspectionCertificate)).to.equal(
        await second.getAddress()
      );
      expect(await env.registry.isValid(b.shipmentId, DocType.InspectionCertificate)).to.equal(false);
      expect(await second.isValid(b.shipmentId, DocType.InspectionCertificate)).to.equal(true);

      // ... while pre-swap anchors still resolve to the registry that holds them.
      expect(await env.core.hasValidDocument(a.shipmentId, DocType.InspectionCertificate)).to.equal(true);
      expect(await env.core.hasValidDocument(a.shipmentId, DocType.CommercialInvoice)).to.equal(true);
      expect(await env.core.isCompliant(a.shipmentId, Custody.PickedUp)).to.equal(true);
      expect(await env.core.isCompliant(b.shipmentId, Custody.PickedUp)).to.equal(true);

      // Revocation resolves to the registry that holds the document.
      await env.core.connect(env.verifier).revokeDocument(a.shipmentId, DocType.InspectionCertificate);
      expect(await env.core.hasValidDocument(a.shipmentId, DocType.InspectionCertificate)).to.equal(false);
      await expect(
        env.core.connect(env.verifier).revokeDocument(b.shipmentId, DocType.InspectionCertificate)
      ).to.not.be.reverted;
    });

    it("unresolved reads fall back to the active registry", async function () {
      const env = await loadFixture(fixture);
      const second = await deploySecondRegistry(env);
      await env.core.connect(env.admin).setDocumentRegistry(await second.getAddress());

      // Nothing anchored for shipment 999: the pairing is empty, so the active registry is used.
      expect(await env.core.documentRegistryOf(999n, DocType.CommercialInvoice)).to.equal(await second.getAddress());
      expect(await env.core.hasValidDocument(999n, DocType.CommercialInvoice)).to.equal(false);
    });
  });

  describe("DocumentRegistry access control mounted on the core", function () {
    it("only the core (CONTROLLER_ROLE) may anchor or revoke directly", async function () {
      const env = await loadFixture(fixture);
      const second = await deploySecondRegistry(env);

      await expect(
        second.connect(env.verifier).anchor(1n, DocType.InspectionCertificate, CID.inspection, env.verifier.address)
      ).to.be.revertedWithCustomError(second, "AccessControlUnauthorizedAccount");
      await expect(second.connect(env.verifier).revoke(1n, DocType.InspectionCertificate))
        .to.be.revertedWithCustomError(second, "AccessControlUnauthorizedAccount");

      // The core holds both the admin and the controller role on every instance it accepts.
      const adminRole = await second.DEFAULT_ADMIN_ROLE();
      const controller = await second.CONTROLLER_ROLE();
      expect(await second.hasRole(adminRole, await env.core.getAddress())).to.equal(true);
      expect(await second.hasRole(controller, await env.core.getAddress())).to.equal(true);
      expect(await second.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
      expect(await second.core()).to.equal(await env.core.getAddress());
    });
  });

  describe("setModuleRole", function () {
    it("is admin-only and whitelist-checked", async function () {
      const env = await loadFixture(fixture);
      const role = await env.registry.CONTROLLER_ROLE();

      await expect(
        env.core.connect(env.outsider).setModuleRole(await env.registry.getAddress(), role, env.outsider.address, true)
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");

      await expect(
        env.core.connect(env.admin).setModuleRole(env.outsider.address, role, env.outsider.address, true)
      ).to.be.revertedWithCustomError(env.core, "UnknownModule");
    });

    it("administers the modules' writers from the core", async function () {
      const env = await loadFixture(fixture);
      const controller = await env.registry.CONTROLLER_ROLE();
      const registryAddr = await env.registry.getAddress();

      // By default only the core may write; the core can hand the role out and take it back.
      await expect(
        env.registry.connect(env.verifier).anchor(1n, DocType.InspectionCertificate, CID.inspection, env.verifier.address)
      ).to.be.revertedWithCustomError(env.registry, "AccessControlUnauthorizedAccount");

      await env.core.connect(env.admin).setModuleRole(registryAddr, controller, env.verifier.address, true);
      await expect(env.registry.connect(env.verifier).anchor(1n, DocType.InspectionCertificate, CID.inspection, env.verifier.address))
        .to.emit(env.registry, "DocumentAnchored");

      await env.core.connect(env.admin).setModuleRole(registryAddr, controller, env.verifier.address, false);
      await expect(
        env.registry.connect(env.verifier).anchor(2n, DocType.InspectionCertificate, CID.inspection, env.verifier.address)
      ).to.be.revertedWithCustomError(env.registry, "AccessControlUnauthorizedAccount");
    });

    it("works for the LetterOfCredit and ComplianceEngine modules too", async function () {
      const env = await loadFixture(fixture);
      const locAddr = await env.loc.getAddress();
      const controller = await env.loc.CONTROLLER_ROLE();

      await env.core.connect(env.admin).setModuleRole(locAddr, controller, env.outsider.address, true);
      expect(await env.loc.hasRole(controller, env.outsider.address)).to.equal(true);

      const adminRole = await env.compliance.DEFAULT_ADMIN_ROLE();
      await env.core
        .connect(env.admin)
        .setModuleRole(await env.compliance.getAddress(), adminRole, env.outsider.address, true);
      expect(await env.compliance.hasRole(adminRole, env.outsider.address)).to.equal(true);
    });

    it("refuses to revoke the core's own admin on a module", async function () {
      const env = await loadFixture(fixture);
      const adminRole = await env.registry.DEFAULT_ADMIN_ROLE();
      await expect(
        env.core
          .connect(env.admin)
          .setModuleRole(await env.registry.getAddress(), adminRole, await env.core.getAddress(), false)
      ).to.be.revertedWithCustomError(env.core, "CannotRevokeCoreAdmin");
    });
  });
});
