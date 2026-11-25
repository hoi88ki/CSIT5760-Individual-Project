// Multi-party documentary-credit demo: every step is signed by the role account from .env,
// on the deployed core (any network). Produces a full transaction record.
//
//   npx hardhat run scripts/demo-accounts.js --network sepolia
//
// Flow (FOB · sight): importer applies -> issuing bank issues & funds the escrow ->
// exporter ships -> verifier attests -> logistics custody -> exporter presents ->
// bank examines & honors (pays) -> importer takes delivery -> Settled.
// The transaction record is written to deployments/<network>-demo-log.md.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const Incoterm = { FOB: 1 };
const PaymentTerm = { Sight: 0 };
const DocType = { InspectionCertificate: 3 };
const Phase = ["OrderPlaced", "LCIssued", "Shipped", "Presented", "Honored", "Delivered", "Settled", "Reclaimed"];
const Custody = ["AtExporter", "PickedUp", "OnVessel", "Delivered"];
const UNIT = 10n ** 6n;
const LC_AMOUNT = 25_000n * UNIT;
const CID = {
  invoice: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  packing: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  bl: "bafybeibzl6c7tfi3m3xh5s7a6b2m4p6kzp7c4q4y2o7b6k5r4v3l5r5v7v3l5",
  inspection: "bafybeih2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2g3h4i5j6k7l",
};

const explorer = (hash) => `https://${network.name}.etherscan.io/tx/${hash}`;
const log = [];

function heading(text) {
  log.push("", text, "");
  console.log("\n" + text);
}
function line(text) {
  log.push(text);
  console.log(text);
}

/** Send `txFn` from `wallet`, wait, verify with `check`, and record everything. */
async function step(actor, role, action, args, wallet, txFn, check) {
  const before = (await ethers.provider.getBlock("latest")).number;
  const tx = await txFn();
  const rc = await tx.wait();
  const outcome = check ? await check() : [];
  const ok = outcome.every(([cond]) => cond);
  if (!ok) throw new Error(`${action}: state check failed — ${outcome.map(([, m]) => m).join("; ")}`);
  const eth = await ethers.provider.getBalance(wallet.address);
  line(
    `| ${actor} | \`${role}\` | \`${action}(${args})\` | [${rc.hash.slice(0, 10)}…](${explorer(rc.hash)}) | ` +
      `${rc.blockNumber} | ${rc.gasUsed} | ${ethers.formatEther(eth)} |`
  );
  for (const [, note] of outcome) line(`| | | ↳ ${note} | | | | |`);
  return rc;
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const core = await ethers.getContractAt("TradeChainCore", dep.core);
  const token = await ethers.getContractAt("TradeUSD", dep.settlementToken);
  const nft = await ethers.getContractAt("ShipmentTracker", dep.shipmentTracker);

  const pk = (n) => {
    const v = (process.env[n] || "").trim();
    if (!v) throw new Error(`${n} missing in .env`);
    return new ethers.Wallet(v, ethers.provider);
  };
  const importer = pk("IMPORTER_PRIVATE_KEY");
  const exporter = pk("EXPORTER_PRIVATE_KEY");
  const bank = pk("BANK_PRIVATE_KEY");
  const logistics = pk("LOGISTICS_PRIVATE_KEY");
  const verifier = pk("VERIFIER_PRIVATE_KEY");

  // ---------------------------------------------------------------- header
  heading(`# Multi-account workflow demo — TradeChain on ${network.name}`);
  line("");
  line(`Date: ${new Date().toISOString()}`);
  line("");
  line(`Core: \`${dep.core}\` · LetterOfCredit: \`${dep.letterOfCredit}\` · ShipmentTracker (e-B/L): \`${dep.shipmentTracker}\``);
  line("");
  line("| Party | Role | Address |");
  line("|---|---|---|");
  line(`| Importer (applicant) | ROLE_IMPORTER | \`${importer.address}\` |`);
  line(`| Issuing bank | ROLE_BANK | \`${bank.address}\` |`);
  line(`| Exporter (beneficiary) | ROLE_EXPORTER | \`${exporter.address}\` |`);
  line(`| Logistics | ROLE_LOGISTICS | \`${logistics.address}\` |`);
  line(`| Verifier | ROLE_VERIFIER | \`${verifier.address}\` |`);
  line("");
  line(`Terms: FOB · sight · L/C ${ethers.formatUnits(LC_AMOUNT, 6)} tUSD · expiry = now + 30 days`);
  line("");
  line("Every transaction below is signed by the party's own key (see the Etherscan links).");
  line("");
  line("| Party | Role | Action | Tx | Block | Gas | Party ETH left |");
  line("|---|---|---|---|---|---|---|");

  // ---------------------------------------------------------------- 1) application
  heading("## 1 · Application (importer)");
  const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 30 * 24 * 3600);
  await step("Importer", "ROLE_IMPORTER", "createOrder",
    `exporter=${exporter.address.slice(0, 10)}…, FOB, ${ethers.formatUnits(LC_AMOUNT, 6)} tUSD, sight`,
    importer,
    () => core.connect(importer).createOrder(exporter.address, Incoterm.FOB, LC_AMOUNT, deadline, PaymentTerm.Sight, 0),
    async () => {
      const orderId = await core.orderCount();
      const o = await core.getOrder(orderId);
      const s = await core.getShipment(orderId);
      return [
        [o.exporter.toLowerCase() === exporter.address.toLowerCase(), `order #${orderId} names the exporter as beneficiary`],
        [Number(s.phase) === 0, `phase OrderPlaced — nothing funded yet`],
      ];
    });
  const orderId = await core.orderCount();

  // ---------------------------------------------------------------- 2) issuance
  heading("## 2 · Issuance (issuing bank — funds the escrow)");
  const allowance = await token.allowance(bank.address, dep.core);
  if (allowance < LC_AMOUNT) {
    await step("Bank", "ROLE_BANK", "approve",
      `core ${dep.core.slice(0, 10)}…, max tUSD`,
      bank,
      () => token.connect(bank).approve(dep.core, ethers.MaxUint256),
      async () => [[(await token.allowance(bank.address, dep.core)) >= LC_AMOUNT, "escrow allowance in place"]]);
  }
  await step("Bank", "ROLE_BANK", "issueLetterOfCredit",
    `order #${orderId} — ${ethers.formatUnits(LC_AMOUNT, 6)} tUSD from the BANK`,
    bank,
    () => core.connect(bank).issueLetterOfCredit(orderId),
    async () => {
      const lc = await core.getLC(orderId);
      const escrow = await token.balanceOf(dep.letterOfCredit);
      return [
        [lc.issued && lc.issuingBank.toLowerCase() === bank.address.toLowerCase(), "credit recorded with the bank as issuer"],
        [lc.beneficiary.toLowerCase() === exporter.address.toLowerCase(), `beneficiary = exporter, stipulated docs bitmask ${lc.requiredDocs}`],
        [escrow === LC_AMOUNT, `escrow funded BY THE BANK: ${ethers.formatUnits(escrow, 6)} tUSD in the module`],
        [Number((await core.getShipment(orderId)).phase) === 1, "phase LCIssued — the exporter may now ship"],
      ];
    });

  // ---------------------------------------------------------------- 3) shipment
  heading("## 3 · Shipment (exporter — only now allowed to ship)");
  await step("Exporter", "ROLE_EXPORTER", "createShipment",
    "invoice + packing-list CIDs anchored, title minted to the core escrow",
    exporter,
    () => core.connect(exporter).createShipment(orderId, CID.invoice, CID.packing),
    async () => {
      const s = await core.getShipment(orderId);
      return [
        [Number(s.phase) === 2, "phase Shipped"],
        [(await nft.ownerOf(orderId)).toLowerCase() === dep.core.toLowerCase(), "e-B/L title token escrowed by the core"],
      ];
    });

  // ---------------------------------------------------------------- 4) certificates
  heading("## 4 · Verifier attestation");
  await step("Verifier", "ROLE_VERIFIER", "anchorDocument",
    "InspectionCertificate (part of the FOB stipulated set)",
    verifier,
    () => core.connect(verifier).anchorDocument(orderId, DocType.InspectionCertificate, CID.inspection),
    async () => [
      [await core.hasValidDocument(orderId, DocType.InspectionCertificate), "inspection certificate anchored & verified"],
    ]);

  // ---------------------------------------------------------------- 5) custody
  heading("## 5 · Custody (logistics) — risk moves, payment does NOT");
  await step("Logistics", "ROLE_LOGISTICS", "confirmPickup",
    "custody PickedUp; FOB risk still with the exporter",
    logistics,
    () => core.connect(logistics).confirmPickup(orderId),
    async () => {
      const s = await core.getShipment(orderId);
      return [
        [Number(s.custody) === 1, "custody PickedUp"],
        [s.riskHolder.toLowerCase() === exporter.address.toLowerCase(), "FOB: risk still with the exporter"],
        [!(await core.getLC(orderId)).paid, "no payment at the milestone (the credit pays on honor)"],
      ];
    });
  await step("Logistics", "ROLE_LOGISTICS", "confirmVesselLoading",
    "B/L anchored + title URI set; FOB risk transfers to the importer",
    logistics,
    () => core.connect(logistics).confirmVesselLoading(orderId, CID.bl),
    async () => {
      const s = await core.getShipment(orderId);
      return [
        [Number(s.custody) === 2, "custody OnVessel"],
        [s.riskHolder.toLowerCase() === importer.address.toLowerCase(), "FOB: risk now with the importer"],
        [(await nft.tokenURI(orderId)) === `ipfs://${CID.bl}`, "title tokenURI = ipfs://<B/L CID>"],
        [!(await core.getLC(orderId)).paid, "still no payment — presentation comes first"],
      ];
    });

  // ---------------------------------------------------------------- 6) presentation
  heading("## 6 · Presentation (exporter/beneficiary)");
  await step("Exporter", "ROLE_EXPORTER", "presentDocuments",
    "stipulated set complete → presentation recorded",
    exporter,
    () => core.connect(exporter).presentDocuments(orderId),
    async () => {
      const [ok] = await core.examinePresentation(orderId);
      return [
        [Number((await core.getShipment(orderId)).phase) === 3, "phase Presented"],
        [ok, "examination preview: presentation set complete — the bank may honor"],
      ];
    });

  // ---------------------------------------------------------------- 7) honor
  heading("## 7 · Examination & honor (issuing bank — sight: pays now)");
  const exporterBefore = await token.balanceOf(exporter.address);
  await step("Bank", "ROLE_BANK", "honorPresentation",
    `examines the presentation on-chain and honors — ${ethers.formatUnits(LC_AMOUNT, 6)} tUSD to the beneficiary`,
    bank,
    () => core.connect(bank).honorPresentation(orderId),
    async () => {
      const lc = await core.getLC(orderId);
      const exporterAfter = await token.balanceOf(exporter.address);
      return [
        [lc.honored && lc.paid, "credit honored and paid (sight)"],
        [exporterAfter === exporterBefore + LC_AMOUNT, `exporter balance +${ethers.formatUnits(LC_AMOUNT, 6)} tUSD`],
        [(await token.balanceOf(dep.letterOfCredit)) === 0n, "escrow emptied"],
      ];
    });

  // ---------------------------------------------------------------- 8) delivery
  heading("## 8 · Reimbursement (importer settles the credit with the issuing bank, on-chain)");
  // The LetterOfCredit module pulls the reimbursement, so the importer needs an allowance
  // for it (separate from the core's escrow/duty allowance).
  const locAllowance = await token.allowance(importer.address, dep.letterOfCredit);
  if (locAllowance < LC_AMOUNT) {
    await step("Importer", "ROLE_IMPORTER", "approve",
      `LetterOfCredit ${dep.letterOfCredit.slice(0, 10)}…, max tUSD (reimbursement pull-payment)`,
      importer,
      () => token.connect(importer).approve(dep.letterOfCredit, ethers.MaxUint256),
      async () => [
        [(await token.allowance(importer.address, dep.letterOfCredit)) >= LC_AMOUNT, "reimbursement allowance in place"],
      ]);
  }
  const bankTusdBefore = await token.balanceOf(bank.address);
  const importerTusdBefore = await token.balanceOf(importer.address);
  await step("Importer", "ROLE_IMPORTER", "reimburseIssuingBank",
    `settles the credit on-chain — ${ethers.formatUnits(LC_AMOUNT, 6)} tUSD from the importer to the issuing bank`,
    importer,
    () => core.connect(importer).reimburseIssuingBank(orderId),
    async () => {
      const lc = await core.getLC(orderId);
      return [
        [lc.reimbursed, "credit recorded as reimbursed"],
        [(await token.balanceOf(bank.address)) === bankTusdBefore + LC_AMOUNT, `bank balance +${ethers.formatUnits(LC_AMOUNT, 6)} tUSD (reimbursed)`],
        [(await token.balanceOf(importer.address)) === importerTusdBefore - LC_AMOUNT, "importer balance reduced by the credit amount"],
      ];
    });

  // ---------------------------------------------------------------- 9) delivery
  heading("## 9 · Final delivery (importer) — title released, trade Settled");
  await step("Importer", "ROLE_IMPORTER", "confirmFinalDelivery",
    "custody Delivered, e-B/L title released to the importer",
    importer,
    () => core.connect(importer).confirmFinalDelivery(orderId),
    async () => {
      const s = await core.getShipment(orderId);
      return [
        [Number(s.custody) === 3, "custody Delivered"],
        [Number(s.phase) === 6, "phase Settled (paid AND delivered)"],
        [(await nft.ownerOf(orderId)).toLowerCase() === importer.address.toLowerCase(), "e-B/L title now owned by the importer"],
      ];
    });

  // ---------------------------------------------------------------- summary
  heading("## Result");
  const s = await core.getShipment(orderId);
  const lc = await core.getLC(orderId);
  const balances = {};
  for (const [name, w] of Object.entries({ importer, exporter, bank, logistics, verifier })) {
    balances[name] = ethers.formatEther(await ethers.provider.getBalance(w.address));
  }
  line("");
  line(`Trade #${orderId}: phase **${Phase[Number(s.phase)]}**, custody **${Custody[Number(s.custody)]}**, credit paid **${lc.paid}**, reimbursed **${lc.reimbursed}**, title with the **importer**.`);
  line("");
  line("| Party | Final ETH (gas paid from these accounts) | Final tUSD |");
  line("|---|---|---|");
  line(`| Importer | ${balances.importer} | ${ethers.formatUnits(await token.balanceOf(importer.address), 6)} |`);
  line(`| Exporter | ${balances.exporter} | ${ethers.formatUnits(await token.balanceOf(exporter.address), 6)} |`);
  line(`| Bank | ${balances.bank} | ${ethers.formatUnits(await token.balanceOf(bank.address), 6)} |`);
  line(`| Logistics | ${balances.logistics} | — |`);
  line(`| Verifier | ${balances.verifier} | — |`);
  line("");

  const out = path.join(__dirname, "..", "deployments", `${network.name}-demo-log.md`);
  fs.writeFileSync(out, log.join("\n") + "\n");
  console.log(`\nTransaction record saved → deployments/${network.name}-demo-log.md`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("demo failed:", e.shortMessage || e.message);
  process.exit(1);
});
