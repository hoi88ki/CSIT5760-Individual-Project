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

describe("DocumentRegistry — anchoring & certificate NFTs", function () {
  const fixture = deployTradeChain;

  async function funded(env) {
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.DDP });
    await fundLC(env, shipmentId);
    return shipmentId;
  }

  it("anchors a seller-issued certificate of origin without minting an NFT", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);

    await expect(env.core.connect(env.seller).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo))
      .to.emit(env.core, "DocumentAnchored")
      .withArgs(id, DocType.CertificateOfOrigin, env.seller.address, CID.coo, 0n)
      .and.to.not.emit(env.core, "CertificateMinted");

    const rec = await env.core.getDocument(id, DocType.CertificateOfOrigin);
    expect(rec.cid).to.equal(CID.coo);
    expect(rec.issuer).to.equal(env.seller.address);
    expect(rec.locked).to.equal(true);
    expect(rec.certId).to.equal(0n);
  });

  it("mints a certificate NFT for verifier attestations and points its URI at the CID", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);

    await expect(env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection))
      .to.emit(env.core, "CertificateMinted")
      .withArgs(1n, id, DocType.InspectionCertificate, env.verifier.address);

    const rec = await env.core.getDocument(id, DocType.InspectionCertificate);
    expect(rec.certId).to.equal(1n);
    expect(await env.cert.ownerOf(1n)).to.equal(env.verifier.address);
    expect(await env.cert.tokenURI(1n)).to.equal(`ipfs://${CID.inspection}`);
    expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(true);
  });

  it("is anchor-once-then-lock (duplicate anchoring reverts)", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.extra)
    ).to.be.revertedWithCustomError(env.core, "DocumentLocked");
  });

  it("rejects empty CIDs", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, "")
    ).to.be.revertedWithCustomError(env.core, "EmptyCID");
  });

  it("only accepts anchorable types (not invoice / packing list / B-L)", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);
    await expect(
      env.core.connect(env.seller).anchorDocument(id, DocType.CommercialInvoice, CID.invoice)
    ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
    await expect(
      env.core.connect(env.carrier).anchorDocument(id, DocType.BillOfLadingOrAWB, CID.bl)
    ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
  });

  it("enforces the per-DocType issuer role", async function () {
    const env = await deployTradeChain();
    const id = await funded(env);

    // CoO must come from the Seller role, inspection from the Verifier role.
    await expect(
      env.core.connect(env.verifier).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo)
    ).to.be.revertedWithCustomError(env.core, "Unauthorized");
    await expect(
      env.core.connect(env.outsider).anchorDocument(id, DocType.InspectionCertificate, CID.inspection)
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
    it("lets the issuer burn a certificate, invalidating the document", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);

      await expect(env.core.connect(env.verifier).revokeCertificate(id, DocType.InspectionCertificate))
        .to.emit(env.core, "CertificateRevoked")
        .withArgs(1n, id, DocType.InspectionCertificate);

      expect(await env.cert.exists(1n)).to.equal(false);
      expect(await env.core.hasValidDocument(id, DocType.InspectionCertificate)).to.equal(false);
    });

    it("lets the admin revoke but not an unrelated account", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
      await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);

      await expect(
        env.core.connect(env.outsider).revokeCertificate(id, DocType.InsuranceCertificate)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");

      await env.core.connect(env.admin).revokeCertificate(id, DocType.InsuranceCertificate);
      expect(await env.core.hasValidDocument(id, DocType.InsuranceCertificate)).to.equal(false);
    });

    it("reverts when there is no certificate to revoke", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
      await expect(
        env.core.connect(env.verifier).revokeCertificate(id, DocType.InspectionCertificate)
      ).to.be.revertedWithCustomError(env.core, "CertificateNotFound");
    });

    it("rejects revoking a non-certificate document type", async function () {
      const env = await deployTradeChain();
      const id = await funded(env);
      await expect(
        env.core.connect(env.seller).revokeCertificate(id, DocType.CertificateOfOrigin)
      ).to.be.revertedWithCustomError(env.core, "DocumentNotAnchorable");
    });
  });

  it("cannot anchor documents on a reclaimed shipment", async function () {
    const env = await deployTradeChain();
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.FOB });
    await fundLC(env, shipmentId);
    const { deadline } = await env.core.getShipment(shipmentId);
    await time.increaseTo(Number(deadline) + 1);
    await env.core.connect(env.buyer).reclaimExpiredLC(shipmentId);

    await expect(
      env.core.connect(env.verifier).anchorDocument(shipmentId, DocType.InspectionCertificate, CID.inspection)
    ).to.be.revertedWithCustomError(env.core, "InvalidStateRange");
  });
});
