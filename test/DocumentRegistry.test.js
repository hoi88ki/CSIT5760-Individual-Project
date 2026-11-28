const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  DocType,
  CID,
  deployTradeChain,
  createOrderAndShipment,
} = require("./helpers/fixture");

describe("DocumentRegistry — anchoring & verification", function () {
  const fixture = deployTradeChain;

  async function shipped(env) {
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
    return shipmentId;
  }

  it("anchors an exporter-issued certificate of origin", async function () {
    const env = await deployTradeChain();
    const id = await shipped(env);

    await expect(env.core.connect(env.exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo))
      .to.emit(env.registry, "DocumentAnchored")
      .withArgs(id, DocType.CertificateOfOrigin, env.exporter.address, CID.coo);

    const rec = await env.core.getDocument(id, DocType.CertificateOfOrigin);
    expect(rec.cid).to.equal(CID.coo);
    expect(rec.issuer).to.equal(env.exporter.address);
    expect(rec.verified).to.equal(true);
    expect(await env.core.hasValidDocument(id, DocType.CertificateOfOrigin)).to.equal(true);
  });

  it("anchors a verifier attestation and links the IPFS CID", async function () {
    const env = await deployTradeChain();
    const id = await shipped(env);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    const rec = await env.core.getDocument(id, DocType.InspectionCertificate);
    expect(rec.cid).to.equal(CID.inspection);
    expect(rec.issuer).to.equal(env.verifier.address);
    expect(rec.verified).to.equal(true);
    expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(true);
  });

  it("locks a live anchor and re-anchors a revoked one", async function () {
    const env = await deployTradeChain();
    const id = await shipped(env);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.extra)
    ).to.be.revertedWithCustomError(env.registry, "DocumentLocked");

    // Revoking re-opens the slot: the issuer may anchor a replacement CID.
    await env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.extra)
    )
      .to.emit(env.registry, "DocumentAnchored")
      .withArgs(id, DocType.InspectionCertificate, env.verifier.address, CID.extra);

    const rec = await env.core.getDocument(id, DocType.InspectionCertificate);
    expect(rec.cid).to.equal(CID.extra);
    expect(rec.verified).to.equal(true);
    expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(true);
  });

  it("rejects empty CIDs", async function () {
    const env = await deployTradeChain();
    const id = await shipped(env);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, "")
    ).to.be.revertedWithCustomError(env.registry, "EmptyCID");
  });

  it("only accepts anchorable types (not invoice / packing list / B-L)", async function () {
    const env = await deployTradeChain();
    const id = await shipped(env);
    await expect(
      env.core.connect(env.exporter).anchorDocument(id, DocType.CommercialInvoice, CID.invoice)
    ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
    await expect(
      env.core.connect(env.logistics).anchorDocument(id, DocType.BillOfLadingOrAWB, CID.bl)
    ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
  });

  it("enforces the per-DocType issuer role", async function () {
    const env = await deployTradeChain();
    const id = await shipped(env);

    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo)
    ).to.be.revertedWithCustomError(env.core, "Unauthorized");
    await expect(
      env.core.connect(env.outsider).anchorDocument(id, DocType.InspectionCertificate, CID.inspection)
    ).to.be.revertedWithCustomError(env.core, "Unauthorized");
    // Logistics cannot anchor a verifier certificate through anchorDocument.
    await expect(
      env.core.connect(env.logistics).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance)
    ).to.be.revertedWithCustomError(env.core, "Unauthorized");
  });

  it("cannot anchor before the goods are shipped (credit issued but not drawn on)", async function () {
    const env = await deployTradeChain();
    await env.core
      .connect(env.importer)
      .createOrder(env.exporter.address, Incoterm.DDP, 100_000n * 10n ** 6n, BigInt((await time.latest()) + 30 * 24 * 3600), 0, 0);
    await env.core.connect(env.bank).issueLetterOfCredit(1n);
    await expect(
      env.core.connect(env.verifier).anchorDocument(1n, DocType.InspectionCertificate, CID.inspection)
    ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
  });

  describe("document replacement", function () {
    it("lets the designated role replace an existing document", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);

      await expect(env.core.connect(env.exporter).replaceDocument(id, DocType.CommercialInvoice, CID.extra))
        .to.emit(env.registry, "DocumentReplaced")
        .withArgs(id, DocType.CommercialInvoice, env.exporter.address, CID.invoice, CID.extra);

      const rec = await env.core.getDocument(id, DocType.CommercialInvoice);
      expect(rec.cid).to.equal(CID.extra);
      expect(rec.verified).to.equal(true);
    });

    it("rejects an unauthorized account and an unknown document", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);

      await expect(
        env.core.connect(env.outsider).replaceDocument(id, DocType.CommercialInvoice, CID.extra)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");
      // Nothing anchored for the B/L yet: the registry reports the missing document.
      await expect(
        env.core.connect(env.logistics).replaceDocument(id, DocType.BillOfLadingOrAWB, CID.bl)
      ).to.be.revertedWithCustomError(env.registry, "DocumentNotFound");
    });

    it("restores a revoked certificate so the custody gate passes", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env); // FOB

      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate);
      await env.core.connect(env.logistics).confirmPickup(id);
      await expect(
        env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl)
      ).to.be.revertedWithCustomError(env.compliance, "MissingMandatoryDocument");

      await env.core.connect(env.verifier).replaceDocument(id, DocType.InspectionCertificate, CID.extra);
      await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
      expect((await env.core.getShipment(id)).custody).to.equal(2n); // OnVessel
    });

    it("lets the original issuer replace a document after its role was revoked", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);

      await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);
      await env.core
        .connect(env.admin)
        .revokeRole(await env.core.ROLE_VERIFIER(), env.verifier.address);

      await env.core.connect(env.verifier).replaceDocument(id, DocType.InsuranceCertificate, CID.extra);
      expect((await env.core.getDocument(id, DocType.InsuranceCertificate)).cid).to.equal(CID.extra);
    });

    it("updates the e-B/L title URI when the bill of lading is replaced", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env); // FOB

      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.logistics).confirmPickup(id);
      await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
      expect(await env.tracker.tokenURI(id)).to.equal("ipfs://" + CID.bl);

      await env.core.connect(env.logistics).replaceDocument(id, DocType.BillOfLadingOrAWB, CID.extra);
      expect(await env.tracker.tokenURI(id)).to.equal("ipfs://" + CID.extra);
    });

    it("refuses replacement once the trade is reclaimed", async function () {
      const env = await deployTradeChain();
      const { orderId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
      const { deadline } = await env.core.getShipment(orderId);
      await time.increaseTo(Number(deadline) + 1);
      await env.core.connect(env.importer).reclaimExpiredLC(orderId);

      await expect(
        env.core.connect(env.exporter).replaceDocument(orderId, DocType.CommercialInvoice, CID.extra)
      ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
    });
  });

  describe("revocation", function () {
    it("lets the issuer revoke a document, invalidating it", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);

      await expect(env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate))
        .to.emit(env.registry, "DocumentRevoked")
        .withArgs(id, DocType.InspectionCertificate);

      expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(false);
    });

    it("lets the admin revoke but not an unrelated account", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);

      await expect(
        env.core.connect(env.outsider).revokeDocument(id, DocType.InsuranceCertificate)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");

      await env.core.connect(env.admin).revokeDocument(id, DocType.InsuranceCertificate);
      expect(await env.core.hasValidDocument(id, DocType.InsuranceCertificate)).to.equal(false);
    });

    it("reverts when there is no document to revoke", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);
      // Non-issuer is stopped by the core's authorization check...
      await expect(
        env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");
      // ...the admin reaches the registry, which reports the missing document.
      await expect(
        env.core.connect(env.admin).revokeDocument(id, DocType.InspectionCertificate)
      ).to.be.revertedWithCustomError(env.registry, "DocumentNotFound");
    });

    it("rejects revoking a document twice", async function () {
      const env = await deployTradeChain();
      const id = await shipped(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate);
      await expect(
        env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate)
      ).to.be.revertedWithCustomError(env.registry, "AlreadyRevoked");
    });
  });

  it("cannot anchor documents on a reclaimed trade", async function () {
    const env = await deployTradeChain();
    await env.core
      .connect(env.importer)
      .createOrder(env.exporter.address, Incoterm.FOB, 100_000n * 10n ** 6n, BigInt((await time.latest()) + 30 * 24 * 3600), 0, 0);
    await env.core.connect(env.bank).issueLetterOfCredit(1n);
    const { deadline } = await env.core.getShipment(1n);
    await time.increaseTo(Number(deadline) + 1);
    await env.core.connect(env.importer).reclaimExpiredLC(1n);

    await expect(
      env.core.connect(env.verifier).anchorDocument(1n, DocType.InspectionCertificate, CID.inspection)
    ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
  });
});
