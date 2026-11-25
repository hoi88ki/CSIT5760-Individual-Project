// Shared fixtures and helpers for the TradeChain test-suite (6-contract layout).
const { ethers } = require("hardhat");

// Enum mirrors (Solidity enums are exposed as uint8 by ethers).
const Incoterm = { EXW: 0, FOB: 1, CIF: 2, DDP: 3 };
const PaymentTerm = { Sight: 0, Deferred: 1 };
const Phase = {
  OrderPlaced: 0,
  LCIssued: 1,
  Shipped: 2,
  Presented: 3,
  Honored: 4,
  Delivered: 5,
  Settled: 6,
  Reclaimed: 7,
};
const Custody = {
  AtExporter: 0,
  PickedUp: 1,
  OnVessel: 2,
  Delivered: 3,
};
const DocType = {
  CommercialInvoice: 0,
  PackingList: 1,
  CertificateOfOrigin: 2,
  InspectionCertificate: 3,
  InsuranceCertificate: 4,
  BillOfLadingOrAWB: 5,
  CustomsClearance: 6,
};

// Illustrative (well-formed length) CIDv1 strings.
const CID = {
  invoice: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  packing: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  bl: "bafybeibzl6c7tfi3m3xh5s7a6b2m4p6kzp7c4q4y2o7b6k5r4v3l5r5v7v3l5",
  coo: "bafybeicvlk3u5l5gqz5q7r7hnh5c7v5p3b7kq5wz3l5r5v7v3l5r5v7v3l5q",
  inspection: "bafybeih2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4i5j6k7l",
  insurance: "bafybeia1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a",
  clearance: "bafybeiz9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a",
  extra: "bafybeif7e6d5c4b3a2z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0x",
};

const UNIT = 10n ** 6n; // 6-decimal stablecoin
const FUND = 1_000_000n * UNIT; // demo funding
const LC = 100_000n * UNIT; // default L/C amount

/**
 * Deploys the full suite. Pass `settlementToken` to inject an external ERC-20
 * (e.g. the adversarial token); otherwise a demo TradeUSD is deployed and injected.
 */
async function deployTradeChain({ settlementToken } = {}) {
  const [admin, exporter, importer, bank, logistics, verifier, outsider] = await ethers.getSigners();

  // Deploy the settlement token first (the core takes it as a constructor argument).
  let usd = null;
  let tokenAddr = settlementToken;
  if (!tokenAddr) {
    const USD = await ethers.getContractFactory("TradeUSD");
    usd = await USD.deploy(admin.address, "TradeChain USD", "tUSD", 6);
    await usd.waitForDeployment();
    tokenAddr = await usd.getAddress();
  }

  const Core = await ethers.getContractFactory("TradeChainCore");
  const core = await Core.deploy(tokenAddr);
  await core.waitForDeployment();
  const coreAddr = await core.getAddress();

  const roleNames = ["ROLE_EXPORTER", "ROLE_IMPORTER", "ROLE_BANK", "ROLE_LOGISTICS", "ROLE_VERIFIER"];
  const holders = [exporter, importer, bank, logistics, verifier];
  const roles = await Promise.all(roleNames.map((n) => core[n]()));
  await core.connect(admin).grantRoles(roles, holders.map((h) => h.address));

  // Let the core mint demo TradeUSD.
  if (usd) await usd.connect(admin).grantRole(await usd.MINTER_ROLE(), coreAddr);

  const token = await ethers.getContractAt("TradeUSD", tokenAddr);
  const registry = await ethers.getContractAt("DocumentRegistry", await core.documentRegistry());
  // ShipmentTracker is also the ERC-721 document-of-title token (tokenId == shipmentId).
  const tracker = await ethers.getContractAt("ShipmentTracker", await core.shipmentTracker());
  const nft = tracker;
  const compliance = await ethers.getContractAt("ComplianceEngine", await core.complianceEngine());
  const loc = await ethers.getContractAt("LetterOfCredit", await core.letterOfCredit());

  // Demo funding (only possible when the core deployed its own TradeUSD).
  // The bank funds the L/C escrow; the importer/exporter still move duty tokens.
  let canMint = true;
  try {
    await (await core.connect(admin).mint(importer.address, FUND)).wait();
    await (await core.connect(admin).mint(exporter.address, FUND)).wait();
    await (await core.connect(admin).mint(bank.address, FUND * 10n)).wait();
  } catch {
    canMint = false;
  }
  if (canMint) {
    const locAddr = await loc.getAddress();
    for (const holder of [importer, exporter, bank]) {
      // the core pulls escrow/duty tokens; the LetterOfCredit module pulls the reimbursement
      await token.connect(holder).approve(coreAddr, ethers.MaxUint256);
      await token.connect(holder).approve(locAddr, ethers.MaxUint256);
    }
  }

  return {
    core,
    token,
    nft,
    registry,
    tracker,
    compliance,
    loc,
    admin,
    exporter,
    importer,
    bank,
    logistics,
    verifier,
    outsider,
    canMint,
  };
}

async function futureDeadline(days = 30) {
  const { time } = require("@nomicfoundation/hardhat-network-helpers");
  return BigInt(await time.latest()) + BigInt(days * 24 * 60 * 60);
}

/**
 * Importer applies for an L/C; the issuing bank issues and funds it; the named exporter ships.
 * @returns {{ orderId: bigint, shipmentId: bigint }}
 */
async function createOrderAndShipment(
  env,
  {
    importer = env.importer,
    exporter = env.exporter,
    bank = env.bank,
    term = Incoterm.FOB,
    paymentTerm = PaymentTerm.Sight,
    deferredDays = 0n,
    lcAmount = LC,
    deadline,
    invoiceCID = CID.invoice,
    packingCID = CID.packing,
  } = {}
) {
  if (deadline === undefined) deadline = await futureDeadline();
  await env.core
    .connect(importer)
    .createOrder(exporter.address, term, lcAmount, deadline, paymentTerm, deferredDays);
  const orderId = await env.core.orderCount();
  await env.core.connect(bank).issueLetterOfCredit(orderId);
  await env.core.connect(exporter).createShipment(orderId, invoiceCID, packingCID);
  const shipmentId = await env.core.shipmentCount();
  return { orderId, shipmentId };
}

/** Anchor a document via the appropriate role. */
async function anchor(env, shipmentId, docType, cid, signer) {
  await env.core.connect(signer).anchorDocument(shipmentId, docType, cid);
}

/** Anchor every presentation certificate the Incoterm stipulates (invoice/packing already anchored). */
async function anchorPresentationCertificates(env, id, termArg) {
  const term = termArg ?? Number((await env.core.getShipment(id)).term);
  if (term !== Incoterm.EXW) {
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
  }
  if (term === Incoterm.CIF) {
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);
  }
  if (term === Incoterm.DDP) {
    await env.core.connect(env.exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo);
    await env.core.connect(env.verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance);
  }
}

/**
 * Drive a shipment from "shipped" to "presentable": anchor the stipulated certificates and
 * complete custody up to vessel loading (the B/L is part of every presentation set).
 */
async function toPresentable(env, id, term) {
  await anchorPresentationCertificates(env, id, term);
  await env.core.connect(env.logistics).confirmPickup(id);
  await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
}

/** Beneficiary records the presentation of the stipulated documents. */
function present(env, shipmentId, exporter = env.exporter) {
  return env.core.connect(exporter).presentDocuments(shipmentId);
}

/** Issuing bank examines and honors a presented credit. */
function honor(env, shipmentId, bank = env.bank) {
  return env.core.connect(bank).honorPresentation(shipmentId);
}

module.exports = {
  ethers,
  Incoterm,
  PaymentTerm,
  Phase,
  Custody,
  DocType,
  CID,
  UNIT,
  FUND,
  LC,
  deployTradeChain,
  futureDeadline,
  createOrderAndShipment,
  anchor,
  anchorPresentationCertificates,
  toPresentable,
  present,
  honor,
};
