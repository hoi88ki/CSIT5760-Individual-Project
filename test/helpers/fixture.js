// Shared fixtures and helpers for the TradeChain test-suite.
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
const FUND = 1_000_000n * UNIT; // buyer funding
const LC = 100_000n * UNIT; // default L/C amount

async function deployTradeChain() {
  const [admin, seller, buyer, carrier, issuingBank, advisingBank, verifier, outsider] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MockERC20");
  const token = await Token.deploy("TradeChain USD", "tUSD", 6);
  await token.waitForDeployment();

  const Core = await ethers.getContractFactory("TradeChainCore");
  const core = await Core.deploy(await token.getAddress());
  await core.waitForDeployment();

  const roleNames = [
    "ROLE_SELLER",
    "ROLE_BUYER",
    "ROLE_CARRIER",
    "ROLE_ISSUING_BANK",
    "ROLE_ADVISING_BANK",
    "ROLE_VERIFIER",
  ];
  const holders = [seller, buyer, carrier, issuingBank, advisingBank, verifier];
  const roles = await Promise.all(roleNames.map((n) => core[n]()));
  await core.connect(admin).grantRoles(roles, holders.map((h) => h.address));

  const ebl = await ethers.getContractAt("EBLToken", await core.eblToken());
  const cert = await ethers.getContractAt("TradeCertNFT", await core.certNFT());

  await token.mint(buyer.address, FUND);
  await token.mint(seller.address, FUND);
  await token.connect(buyer).approve(await core.getAddress(), ethers.MaxUint256);
  await token.connect(seller).approve(await core.getAddress(), ethers.MaxUint256);

  return {
    token,
    core,
    ebl,
    cert,
    admin,
    seller,
    buyer,
    carrier,
    issuingBank,
    advisingBank,
    verifier,
    outsider,
  };
}

async function futureDeadline(days = 30) {
  const { time } = require("@nomicfoundation/hardhat-network-helpers");
  return BigInt(await time.latest()) + BigInt(days * 24 * 60 * 60);
}

/**
 * Buyer opens an order and the named seller creates the shipment.
 * @returns {{ orderId: bigint, shipmentId: bigint }}
 */
async function createOrderAndShipment(
  env,
  { buyer = env.buyer, seller = env.seller, term = Incoterm.FOB, lcAmount = LC, deadline, invoiceCID = CID.invoice, packingCID = CID.packing } = {}
) {
  if (deadline === undefined) deadline = await futureDeadline();
  await env.core.connect(buyer).createOrder(seller.address, term, lcAmount, deadline);
  const orderId = await env.core.orderCount();
  await env.core.connect(seller).createShipment(orderId, invoiceCID, packingCID);
  const shipmentId = await env.core.shipmentCount();
  return { orderId, shipmentId };
}

/** Buy-side: fund the L/C. */
async function fundLC(env, shipmentId, buyer = env.buyer) {
  await env.core.connect(buyer).openLetterOfCredit(shipmentId);
}

/** Deposit anchorDocument documents for a term/match. */
async function anchor(env, shipmentId, docType, cid, signer) {
  await env.core.connect(signer).anchorDocument(shipmentId, docType, cid);
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
};
