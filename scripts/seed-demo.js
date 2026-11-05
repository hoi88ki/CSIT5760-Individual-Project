// Drives a full documentary trade flow for all four Incoterms against a deployed core.
//   npx hardhat node                 # terminal 1
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/seed-demo.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Incoterm = { EXW: 0, FOB: 1, CIF: 2, DDP: 3 };
const DocType = {
  CommercialInvoice: 0,
  PackingList: 1,
  CertificateOfOrigin: 2,
  InspectionCertificate: 3,
  InsuranceCertificate: 4,
  BillOfLadingOrAWB: 5,
  CustomsClearance: 6,
};
const Phase = ["Created", "LCFunded", "PickedUp", "LoadedOnVessel", "Delivered", "Settled", "Reclaimed"];
const TERM_NAME = ["EXW", "FOB", "CIF", "DDP"];
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

async function runFlow(core, nft, ctx, term, lcAmount) {
  const { exporter, importer, logistics, verifier } = ctx;
  const termName = TERM_NAME[term];
  console.log(`\n================  ${termName}  ================`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  await (await core.connect(importer).createOrder(exporter.address, term, lcAmount, deadline)).wait();
  const orderId = await core.orderCount();
  await (await core.connect(exporter).createShipment(orderId, CID.invoice, CID.packing)).wait();
  const id = await core.shipmentCount();
  console.log(`  order #${orderId} → shipment #${id}`);

  await (await core.connect(importer).openLetterOfCredit(id)).wait();
  console.log(`  L/C funded with ${ethers.formatUnits(lcAmount, 6)} tUSD`);

  if (term !== Incoterm.EXW) {
    await (await core.connect(verifier).anchorDocument(id, DocType.InspectionCertificate, CID.inspection)).wait();
    console.log("  anchored Inspection Certificate (verifier)");
  }
  if (term === Incoterm.CIF) {
    await (await core.connect(verifier).anchorDocument(id, DocType.InsuranceCertificate, CID.insurance)).wait();
    console.log("  anchored Insurance Certificate (verifier)");
  }
  if (term === Incoterm.DDP) {
    await (await core.connect(exporter).anchorDocument(id, DocType.CertificateOfOrigin, CID.coo)).wait();
    console.log("  anchored Certificate of Origin (exporter)");
  }

  await (await core.connect(logistics).confirmPickup(id)).wait();
  console.log(`  pickup confirmed → phase ${Phase[Number((await core.getShipment(id)).phase)]}`);

  await (await core.connect(logistics).confirmVesselLoading(id, CID.bl)).wait();
  console.log(`  loaded on vessel, B/L anchored → phase ${Phase[Number((await core.getShipment(id)).phase)]}`);

  if (term === Incoterm.DDP) {
    await (await core.connect(verifier).anchorDocument(id, DocType.CustomsClearance, CID.clearance)).wait();
    await (await core.connect(exporter).payCustomsDuty(id, 500n * UNIT)).wait();
    console.log("  customs cleared, duty paid");
  }

  await (await core.connect(importer).confirmFinalDelivery(id)).wait();
  const s = await core.getShipment(id);
  console.log(`  final delivery → phase ${Phase[Number(s.phase)]}`);
  console.log(`  title NFT owner: ${await nft.ownerOf(id)}`);
}

async function main() {
  const dep = loadDeployment(network.name);
  const signers = await ethers.getSigners();
  const [admin, exporter, importer, , logistics, verifier] = signers;

  const core = await ethers.getContractAt("TradeChainCore", dep.core);
  const token = await ethers.getContractAt("TradeUSD", dep.settlementToken);
  const nft = await ethers.getContractAt("ShipmentNFT", dep.shipmentNFT);

  // Fund demo wallets (the deployer holds MINTER_ROLE on the demo TradeUSD).
  const fund = 10_000_000n * UNIT;
  try {
    await (await token.connect(admin).mint(importer.address, fund)).wait();
    await (await token.connect(admin).mint(exporter.address, fund)).wait();
  } catch {
    console.log("(skipping mint: settlement token is not the open-mint demo TradeUSD)");
  }
  await (await token.connect(importer).approve(dep.core, ethers.MaxUint256)).wait();
  await (await token.connect(exporter).approve(dep.core, ethers.MaxUint256)).wait();

  const ctx = { exporter, importer, logistics, verifier };
  await runFlow(core, nft, ctx, Incoterm.EXW, 100_000n * UNIT);
  await runFlow(core, nft, ctx, Incoterm.FOB, 100_000n * UNIT);
  await runFlow(core, nft, ctx, Incoterm.CIF, 100_000n * UNIT);
  await runFlow(core, nft, ctx, Incoterm.DDP, 100_000n * UNIT);

  console.log("\nAll four Incoterm flows completed.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
