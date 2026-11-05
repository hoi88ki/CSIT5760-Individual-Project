const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  DocType,
  CID,
  deployTradeChain,
  createOrderAndShipment,
  fundLC,
} = require("./helpers/fixture");

describe("DocumentRegistry — anchoring & verification", function () {
  const fixture = deployTradeChain;

  async function funded(env) {
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
    await fundLC(env, shipmentId);
    return shipmentId;
  }

  it("anchors an exporter-issued certificate of origin", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);

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
    const id = await funded(env);

    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    const rec = await env.core.getDocument(id, DocType.InspectionCertificate);
    expect(rec.cid).to.equal(CID.inspection);
    expect(rec.issuer).to.equal(env.verifier.address);
    expect(rec.verified).to.equal(true);
    expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(true);
  });

  it("is anchor-once-then-lock (duplicate anchoring reverts)", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.extra)
    ).to.be.revertedWithCustomError(env.registry, "DocumentLocked");
  });

  it("rejects empty CIDs", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, "")
    ).to.be.revertedWithCustomError(env.registry, "EmptyCID");
  });

  it("only accepts anchorable types (not invoice / packing list / B-L)", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);
    await expect(
      env.core.connect(env.exporter).anchorDocument(id, DocType.CommercialInvoice, CID.invoice)
    ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
    await expect(
      env.core.connect(env.logistics).anchorDocument(id, DocType.BillOfLadingOrAWB, CID.bl)
    ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
  });

  it("enforces the per-DocType issuer role", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);

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

  it("cannot anchor before the L/C is funded", async function () {
    const env = await deployTradeChain();
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
    await expect(
      env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection)
    ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
  });

  describe("revocation", function () {
    it("lets the issuer revoke a document, invalidating it", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);

      await expect(env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate))
        .to.emit(env.registry, "DocumentRevoked")
        .withArgs(id, DocType.InspectionCertificate);

      expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(false);
    });

    it("lets the admin revoke but not an unrelated account", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);

      await expect(
        env.core.connect(env.outsider).revokeDocument(id, DocType.InsuranceCertificate)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");

      await env.core.connect(env.admin).revokeDocument(id, DocType.InsuranceCertificate);
      expect(await env.core.hasValidDocument(id, DocType.InsuranceCertificate)).to.equal(false);
    });

    it("reverts when there is no document to revoke", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
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
      const id = await funded(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
      await env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate);
      await expect(
        env.core.connect(env.verifier).revokeDocument(id, DocType.InspectionCertificate)
      ).to.be.revertedWithCustomError(env.registry, "AlreadyRevoked");
    });
  });

  it("cannot anchor documents on a reclaimed shipment", async function () {
    const env = await deployTradeChain();
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    await fundLC(env, shipmentId);
    const { deadline } = await env.core.getShipment(shipmentId);
    await time.increaseTo(Number(deadline) + 1);
    await env.core.connect(env.importer).reclaimExpiredLC(shipmentId);

    await expect(
      env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection)
    ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
  });
});
