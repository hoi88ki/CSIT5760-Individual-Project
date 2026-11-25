// Drives a full documentary-credit flow for all four Incoterms against a deployed core:
//   application → bank issues & funds the L/C → shipment → documents → custody →
//   presentation → examination → honor (sight or deferred) → delivery.
// Also demonstrates an expired unused credit reclaimed to the issuing bank.
//
//   npx hardhat node                 # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/seed-demo.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Incoterm = { EXW: 0, FOB: 1, CIF: 2, DDP: 3 };
const PaymentTerm = { Sight: 0, Deferred: 1 };
const DocType = {
  CommercialInvoice: 0,
  PackingList: 1,
  CertificateOfOrigin: 2,
  InspectionCertificate: 3,
  InsuranceCertificate: 4,
  BillOfLadingOrAWB: 5,
  CustomsClearance: 6,
};
const Phase = [
  "OrderPlaced",
  "LCIssued",
  "Shipped",
  "Presented",
  "Honored",
  "Delivered",
  "Settled",
  "Reclaimed",
];
const TERM_NAME = ["EXW", "FOB", "CIF", "DDP"];
const PAYMENT_NAME = ["Sight", "Deferred"];
const UNIT = 10n ** 6n;

const CID = {
  invoice: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  packing: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  bl: "bafybeibzl6c7tfi3m3xh5s7a6b2m4p6kzp7c4q4y2o7b6k5r4v3l5r5v7v3l5",
  coo: "bafybeicvlk3u5l5gqz5q7r7hnh5c7v5p3b7kq5wz3l5r5v7v3l5r5v7v3l5q",
  inspection: "bafybeih2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4i5j6k7l",
  insurance: "bafybeia1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a",
  clearance: "bafybeiz9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a",
};

function loadDeployment(name) {
  const file = path.join(__dirname, "..", "deployments", `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment for ${name}. Run scripts/deploy.js first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Chain clock (wall-clock drifts once the deferred demo advances time). */
async function chainNow() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp);
}

async function runFlow(core, nft, ctx, term, lcAmount, paymentTerm, deferredDays) {
  const { exporter, importer, bank, logistics, verifier } = ctx;
  const termName = TERM_NAME[term];
  const payName = PAYMENT_NAME[paymentTerm];
  console.log(`\n================  ${termName} · ${payName}  ================`);

  const deadline = (await chainNow()) + 30n * 24n * 3600n;
  await (
    await core
      .connect(importer)
      .createOrder(exporter.address, term, lcAmount, deadline, paymentTerm, deferredDays)
  ).wait();
  const orderId = await core.orderCount();
  console.log(`  application #${orderId} recorded (${payName}${paymentTerm === PaymentTerm.Deferred ? ` +${deferredDays}d` : ""})`);

  await (await core.connect(bank).issueLetterOfCredit(orderId)).wait();
  const lc = await core.getLC(orderId);
  console.log(
    `  L/C issued by the bank — ${ethers.formatUnits(lc.amount, 6)} tUSD escrowed, ` +
      `${Number(lc.requiredDocs)} documentary requirements`
  );

  await (await core.connect(exporter).createShipment(orderId, CID.invoice, CID.packing)).wait();
  console.log(`  shipment #${orderId} created by the beneficiary (invoice + packing anchored, title escrowed)`);

  if (term !== Incoterm.EXW) {
    await (await core.connect(verifier).anchorDocument(orderId, DocType.InspectionCertificate, CID.inspection)).wait();
    console.log("  anchored Inspection Certificate (verifier)");
  }
  if (term === Incoterm.CIF) {
    await (await core.connect(verifier).anchorDocument(orderId, DocType.InsuranceCertificate, CID.insurance)).wait();
    console.log("  anchored Insurance Certificate (verifier)");
  }
  if (term === Incoterm.DDP) {
    await (await core.connect(exporter).anchorDocument(orderId, DocType.CertificateOfOrigin, CID.coo)).wait();
    await (await core.connect(verifier).anchorDocument(orderId, DocType.CustomsClearance, CID.clearance)).wait();
    console.log("  anchored Certificate of Origin (exporter) + Customs Clearance (verifier)");
  }

  await (await core.connect(logistics).confirmPickup(orderId)).wait();
  console.log(`  pickup confirmed → custody PickedUp`);

  await (await core.connect(logistics).confirmVesselLoading(orderId, CID.bl)).wait();
  console.log(`  loaded on vessel, B/L anchored → custody OnVessel`);

  if (term === Incoterm.DDP) {
    await (await core.connect(exporter).payCustomsDuty(orderId, 500n * UNIT)).wait();
    console.log("  DDP duty escrowed (500 tUSD)");
  }

  await (await core.connect(exporter).presentDocuments(orderId)).wait();
  console.log(`  documents presented → phase ${Phase[Number((await core.getShipment(orderId)).phase)]}`);

  await (await core.connect(bank).honorPresentation(orderId)).wait();
  let lcAfter = await core.getLC(orderId);
  if (paymentTerm === PaymentTerm.Sight) {
    console.log(`  bank examined & honored at sight → ${ethers.formatUnits(lcAfter.amount, 6)} tUSD paid to the beneficiary`);
  } else {
    console.log(
      `  bank examined & honored (deferred) → proceeds payable at ${new Date(
        Number(lcAfter.maturityAt) * 1000
      ).toLocaleTimeString()}`
    );
  }

  await (await core.connect(importer).confirmFinalDelivery(orderId)).wait();
  let s = await core.getShipment(orderId);
  console.log(`  final delivery → phase ${Phase[Number(s.phase)]}, title NFT owner: ${await nft.ownerOf(orderId)}`);

  if (paymentTerm === PaymentTerm.Deferred) {
    if (network.name === "localhost" || network.name === "hardhat") {
      await ethers.provider.send("evm_increaseTime", [Number(deferredDays) * 24 * 3600 + 1]);
      await ethers.provider.send("evm_mine", []);
      await (await core.connect(bank).drawDeferredPayment(orderId)).wait();
      s = await core.getShipment(orderId);
      console.log(`  maturity reached, proceeds drawn → phase ${Phase[Number(s.phase)]}`);
    } else {
      console.log("  (deferred proceeds remain payable at maturity — advance past maturity to draw)");
    }
  }
}

async function main() {
  const dep = loadDeployment(network.name);
  const signers = await ethers.getSigners();
  const [admin, exporter, importer, bank, logistics, verifier] = signers;

  const core = await ethers.getContractAt("TradeChainCore", dep.core);
  const token = await ethers.getContractAt("TradeUSD", dep.settlementToken);
  const nft = await ethers.getContractAt("ShipmentTracker", dep.shipmentTracker);

  // Fund demo wallets (the deployer holds MINTER_ROLE on the demo TradeUSD). The BANK is the
  // party that funds every L/C escrow in the documentary-credit flow.
  const fund = 10_000_000n * UNIT;
  try {
    await (await token.connect(admin).mint(bank.address, fund)).wait();
    await (await token.connect(admin).mint(importer.address, fund)).wait();
    await (await token.connect(admin).mint(exporter.address, fund)).wait();
  } catch {
    console.log("(skipping mint: settlement token is not the open-mint demo TradeUSD)");
  }
  for (const holder of [bank, importer, exporter]) {
    await (await token.connect(holder).approve(dep.core, ethers.MaxUint256)).wait();
  }

  const ctx = { exporter, importer, bank, logistics, verifier };
  await runFlow(core, nft, ctx, Incoterm.EXW, 100_000n * UNIT, PaymentTerm.Sight, 0n);
  await runFlow(core, nft, ctx, Incoterm.FOB, 100_000n * UNIT, PaymentTerm.Sight, 0n);
  await runFlow(core, nft, ctx, Incoterm.CIF, 100_000n * UNIT, PaymentTerm.Sight, 0n);
  await runFlow(core, nft, ctx, Incoterm.DDP, 100_000n * UNIT, PaymentTerm.Sight, 0n);
  await runFlow(core, nft, ctx, Incoterm.CIF, 100_000n * UNIT, PaymentTerm.Deferred, 3n);

  // Expired, unused credit: the bank reclaims its own funds (never the importer's money — the
  // importer only applied for the credit).
  console.log("\n================  EXW · expired unused credit  ================\n");
  const shortDeadline = (await chainNow()) + 3n;
  await (await core.connect(importer).createOrder(exporter.address, Incoterm.EXW, 50_000n * UNIT, shortDeadline, PaymentTerm.Sight, 0n)).wait();
  const staleOrder = await core.orderCount();
  await (await core.connect(bank).issueLetterOfCredit(staleOrder)).wait();
  console.log(`  application #${staleOrder} issued and funded — the beneficiary never ships`);
  await ethers.provider.send("evm_increaseTime", [10]);
  await ethers.provider.send("evm_mine", []);
  const bankBefore = await token.balanceOf(bank.address);
  await (await core.connect(bank).reclaimExpiredLC(staleOrder)).wait();
  const bankAfter = await token.balanceOf(bank.address);
  console.log(
    `  credit expired unused → reclaimed to the issuing bank (+${ethers.formatUnits(bankAfter - bankBefore, 6)} tUSD)`
  );

  console.log("\nAll documentary-credit flows completed.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
