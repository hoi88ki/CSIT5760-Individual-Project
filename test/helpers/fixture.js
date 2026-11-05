// Shared fixtures and helpers for the TradeChain test-suite (6-contract layout).
const { ethers } = require("hardhat");

// Enum mirrors (Solidity enums are exposed as uint8 by ethers).
const Incoterm = { EXW: 0, FOB: 1, CIF: 2, DDP: 3 };
const Phase = {
  Created: 0,
  LCFunded: 1,
  PickedUp: 2,
  LoadedOnVessel: 3,
  Delivered: 4,
  Settled: 5,
  Reclaimed: 6,
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
  let canMint = true;
  try {
    await (await core.connect(admin).mint(importer.address, FUND)).wait();
    await (await core.connect(admin).mint(exporter.address, FUND)).wait();
  } catch {
    canMint = false;
  }
  if (canMint) {
    await token.connect(importer).approve(coreAddr, ethers.MaxUint256);
    await token.connect(exporter).approve(coreAddr, ethers.MaxUint256);
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
 * Importer opens an order and the named exporter creates the shipment.
 * @returns {{ orderId: bigint, shipmentId: bigint }}
 */
async function createOrderAndShipment(
  env,
  {
    importer = env.importer,
    exporter = env.exporter,
    term = Incoterm.FOB,
    lcAmount = LC,
    deadline,
    invoiceCID = CID.invoice,
    packingCID = CID.packing,
  } = {}
) {
  if (deadline === undefined) deadline = await futureDeadline();
  await env.core.connect(importer).createOrder(exporter.address, term, lcAmount, deadline);
  const orderId = await env.core.orderCount();
  await env.core.connect(exporter).createShipment(orderId, invoiceCID, packingCID);
  const shipmentId = await env.core.shipmentCount();
  return { orderId, shipmentId };
}

/** Importer escrows the L/C amount. */
async function fundLC(env, shipmentId, importer = env.importer) {
  await env.core.connect(importer).openLetterOfCredit(shipmentId);
}

/** Anchor a document via the appropriate role. */
async function anchor(env, shipmentId, docType, cid, signer) {
  await env.core.connect(signer).anchorDocument(shipmentId, docType, cid);
}

/** Drive a shipment to the "on vessel" state for the given Incoterm (docs + milestones). */
async function toLoadedOnVessel(env, id, term) {
  if (term !== Incoterm.EXW) {
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection);
  }
  if (term === Incoterm.CIF) {
    await env.core.connect(env.verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance);
  }
  await env.core.connect(env.logistics).confirmPickup(id);
  await env.core.connect(env.logistics).confirmVesselLoading(id, CID.bl);
}

module.exports = {
  ethers,
  Incoterm,
  Phase,
  DocType,
  CID,
  UNIT,
  FUND,
  LC,
  deployTradeChain,
  futureDeadline,
  createOrderAndShipment,
  fundLC,
  anchor,
  toLoadedOnVessel,
};
