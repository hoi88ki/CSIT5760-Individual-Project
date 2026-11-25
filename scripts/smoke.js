// Post-deployment smoke test: drives one complete sight credit against the deployed core
// (any network). The deployer holds every role on single-key deployments, so one account
// plays the applicant, the issuing bank, the beneficiary, logistics and the verifier.
//   npx hardhat run scripts/smoke.js --network sepolia   (or --network localhost)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Incoterm = { EXW: 0, FOB: 1 };
const PaymentTerm = { Sight: 0, Deferred: 1 };
const DocType = { InspectionCertificate: 3 };
const Phase = ["OrderPlaced", "LCIssued", "Shipped", "Presented", "Honored", "Delivered", "Settled", "Reclaimed"];
const UNIT = 10n ** 6n;
const CID = {
  invoice: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  packing: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  bl: "bafybeibzl6c7tfi3m3xh5s7a6b2m4p6kzp7c4q4y2o7b6k5r4v3l5r5v7v3l5",
  inspection: "bafybeih2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4i5j6k7l",
};

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [me] = await ethers.getSigners();
  const core = await ethers.getContractAt("TradeChainCore", dep.core);
  const token = await ethers.getContractAt("TradeUSD", dep.settlementToken);
  const nft = await ethers.getContractAt("ShipmentTracker", dep.shipmentTracker);

  // Companion wiring sanity.
  for (const [name, want] of [["shipmentTracker", dep.shipmentTracker], ["documentRegistry", dep.documentRegistry], ["complianceEngine", dep.complianceEngine], ["letterOfCredit", dep.letterOfCredit]]) {
    const got = await core[name]();
    if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`${name} mismatch`);
  }
  console.log("wiring OK: companions resolve to the deployment record");

  // Fund the single-account demo (the deployer holds every role).
  await (await core.connect(me).mint(me.address, 1_000_000n * UNIT)).wait();
  await (await token.connect(me).approve(dep.core, ethers.MaxUint256)).wait();
  console.log("funded + approved");

  const beneficiary = me.address; // single-account demo: the deployer plays every role
  const deadline = (await ethers.provider.getBlock("latest")).timestamp + 30 * 24 * 3600;

  // 1) application
  await (await core.connect(me).createOrder(beneficiary, Incoterm.FOB, 25_000n * UNIT, deadline, PaymentTerm.Sight, 0)).wait();
  const orderId = await core.orderCount();
  console.log(`order #${orderId} applied`);

  // 2) bank issues & funds the escrow
  await (await core.connect(me).issueLetterOfCredit(orderId)).wait();
  const lc1 = await core.getLC(orderId);
  console.log(`L/C issued: bank=${lc1.issuingBank} amount=${ethers.formatUnits(lc1.amount, 6)} tUSD stipulatedDocs=${lc1.requiredDocs}`);

  // 3) beneficiary ships
  await (await core.connect(me).createShipment(orderId, CID.invoice, CID.packing)).wait();
  console.log(`shipment created, phase=${Phase[Number((await core.getShipment(orderId)).phase)]}, title escrowed by ${(await nft.ownerOf(orderId)) === dep.core ? "core" : "other"}`);

  // 4) verifier certificate + custody
  await (await core.connect(me).anchorDocument(orderId, DocType.InspectionCertificate, CID.inspection)).wait();
  await (await core.connect(me).confirmPickup(orderId)).wait();
  await (await core.connect(me).confirmVesselLoading(orderId, CID.bl)).wait();
  console.log(`custody=${Number((await core.getShipment(orderId)).custody)} (2=OnVessel), no payment at milestones: paid=${(await core.getLC(orderId)).paid}`);

  // 5) presentation + examination/honor (sight)
  await (await core.connect(me).presentDocuments(orderId)).wait();
  const [ok] = await core.examinePresentation(orderId);
  console.log(`presented, examination ok=${ok}`);
  await (await core.connect(me).honorPresentation(orderId)).wait();
  const lc2 = await core.getLC(orderId);
  console.log(`honored: paid=${lc2.paid}`);

  // 6) delivery + title
  await (await core.connect(me).confirmFinalDelivery(orderId)).wait();
  const s = await core.getShipment(orderId);
  console.log(`final phase=${Phase[Number(s.phase)]} (6=Settled), title owner=${await nft.ownerOf(orderId)}`);
  if (Number(s.phase) !== 6) throw new Error("smoke test failed: trade did not settle");
  console.log("SMOKE TEST PASSED");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
