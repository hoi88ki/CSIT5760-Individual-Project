// Prepares the deployed TradeChain suite for a realistic multi-party demo:
//   1) validates every role key from .env (well-formed, distinct, admin is the core's admin);
//   2) funds the role accounts with ETH from the ADMIN account;
//   3) grants each operational role to its own account via grantRoles;
//   4) mints demo TradeUSD (the BANK funds L/C escrows; importer/exporter pay duty).
// Every transaction is recorded to deployments/<network>-accounts-setup.md.
//
//   npx hardhat run scripts/setup-accounts.js --network sepolia
//
// Required .env keys: ADMIN_PRIVATE_KEY, IMPORTER_PRIVATE_KEY, EXPORTER_PRIVATE_KEY,
// BANK_PRIVATE_KEY, LOGISTICS_PRIVATE_KEY, VERIFIER_PRIVATE_KEY (plus the deployment's
// PRIVATE_KEY/SEPOLIA_RPC_URL as usual). Idempotent: funded accounts, held roles and
// funded tUSD balances are skipped on re-runs.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ETH_TOPUP = ethers.parseEther("0.1"); // per account
const ETH_MIN = ethers.parseEther("0.02"); // below this, top up
const TUSD = 10n ** 6n;
const MINT = { BANK: 1_000_000n * TUSD, IMPORTER: 10_000n * TUSD, EXPORTER: 10_000n * TUSD };
const MINT_MIN = { BANK: 100_000n * TUSD, IMPORTER: 1_000n * TUSD, EXPORTER: 1_000n * TUSD };

const ROLE_KEYS = [
  ["IMPORTER_PRIVATE_KEY", "ROLE_IMPORTER", "applicant (L/C importer)"],
  ["EXPORTER_PRIVATE_KEY", "ROLE_EXPORTER", "beneficiary (exporter)"],
  ["BANK_PRIVATE_KEY", "ROLE_BANK", "issuing bank"],
  ["LOGISTICS_PRIVATE_KEY", "ROLE_LOGISTICS", "carrier / logistics"],
  ["VERIFIER_PRIVATE_KEY", "ROLE_VERIFIER", "verifier (inspection / insurance / customs)"],
];

const log = [];
function record(line) {
  log.push(line);
  console.log(line);
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const core = await ethers.getContractAt("TradeChainCore", dep.core);
  const token = await ethers.getContractAt("TradeUSD", dep.settlementToken);

  // ---------------------------------------------------------------- validation
  record(`# Account setup — TradeChain on ${network.name} (core ${dep.core})`);
  record("");
  record(`Date: ${new Date().toISOString()}`);
  record("");
  record("## 1. Key validation");
  record("");
  record("| Env key | Address | Valid | Distinct | ETH |");
  record("|---|---|---|---|---|");

  const adminPk = (process.env.ADMIN_PRIVATE_KEY || "").trim();
  if (!adminPk) throw new Error("ADMIN_PRIVATE_KEY missing in .env");
  const admin = new ethers.Wallet(adminPk, ethers.provider);
  const adminRole = await core.DEFAULT_ADMIN_ROLE();
  if (!(await core.hasRole(adminRole, admin.address))) {
    throw new Error(`ADMIN ${admin.address} does not hold DEFAULT_ADMIN_ROLE on the core — role grants would fail`);
  }

  const wallets = { ADMIN: admin };
  const addresses = new Set([admin.address]);
  for (const [envKey] of ROLE_KEYS) {
    const pk = (process.env[envKey] || "").trim();
    let w;
    try {
      w = new ethers.Wallet(pk, ethers.provider); // throws on malformed keys
    } catch (e) {
      throw new Error(`${envKey} is not a usable private key: ${e.message.slice(0, 80)}`);
    }
    if (addresses.has(w.address)) throw new Error(`${envKey} address ${w.address} is not distinct`);
    addresses.add(w.address);
    wallets[envKey.replace("_PRIVATE_KEY", "")] = w;
    const bal = await ethers.provider.getBalance(w.address);
    record(`| ${envKey} | \`${w.address}\` | yes | yes | ${ethers.formatEther(bal)} |`);
  }
  record(`| ADMIN_PRIVATE_KEY (deployer) | \`${admin.address}\` | yes | yes | ${ethers.formatEther(await ethers.provider.getBalance(admin.address))} |`);
  record("");
  record(`ADMIN holds DEFAULT_ADMIN_ROLE on the core: yes`);

  // ---------------------------------------------------------------- 2. fund ETH
  record("");
  record("## 2. ETH funding from the ADMIN account");
  record("");
  record("| Account | Address | Before (ETH) | Sent (ETH) | Tx |");
  record("|---|---|---|---|---|");

  for (const [envKey] of ROLE_KEYS) {
    const name = envKey.replace("_PRIVATE_KEY", "");
    const w = wallets[name];
    const before = await ethers.provider.getBalance(w.address);
    let txHash = "— (already funded)";
    if (before < ETH_MIN) {
      const tx = await admin.sendTransaction({ to: w.address, value: ETH_TOPUP });
      const rc = await tx.wait();
      txHash = `[${rc.hash.slice(0, 10)}…](https://${network.name}.etherscan.io/tx/${rc.hash})`;
      record(`| ${name} | \`${w.address}\` | ${ethers.formatEther(before)} | ${ethers.formatEther(ETH_TOPUP)} | ${txHash} |`);
    } else {
      record(`| ${name} | \`${w.address}\` | ${ethers.formatEther(before)} | skipped | ${txHash} |`);
    }
  }

  // ---------------------------------------------------------------- 3. roles
  record("");
  record("## 3. Role assignment (`grantRoles`, one transaction for all five)");
  record("");
  record("| Role | Account | Holder |");
  record("|---|---|---|");

  const roleNames = ["ROLE_EXPORTER", "ROLE_IMPORTER", "ROLE_BANK", "ROLE_LOGISTICS", "ROLE_VERIFIER"];
  const roleConstants = await Promise.all(roleNames.map((n) => core[n]()));
  const grants = []; // [roleConstant, wallet, roleName, envKey]
  for (const [envKey, roleName, who] of ROLE_KEYS) {
    const w = wallets[envKey.replace("_PRIVATE_KEY", "")];
    const rc = await core[roleName]();
    const held = await core.hasRole(rc, w.address);
    grants.push({ roleConstant: rc, w, roleName, who, held });
    record(`| \`${roleName}\` | \`${w.address}\` | ${who}${held ? " (already held)" : ""} |`);
  }

  const missing = grants.filter((g) => !g.held);
  if (missing.length) {
    const tx = await core
      .connect(admin)
      .grantRoles(missing.map((g) => g.roleConstant), missing.map((g) => g.w.address));
    const rc = await tx.wait();
    record("");
    record(
      `Grant transaction: [\`${rc.hash.slice(0, 14)}…\`](https://${network.name}.etherscan.io/tx/${rc.hash}) ` +
        `(block ${rc.blockNumber}, gas ${rc.gasUsed}) — ${missing.map((g) => g.roleName).join(", ")}`
    );
  } else {
    record("");
    record("All roles already held — no grant transaction needed.");
  }

  // ---------------------------------------------------------------- 4. TradeUSD
  record("");
  record("## 4. Demo TradeUSD minting (the BANK funds L/C escrows)");
  record("");
  record("| Account | Amount (tUSD) | Balance after | Tx |");
  record("|---|---|---|---|");

  for (const name of Object.keys(MINT)) {
    const w = wallets[name];
    const before = await token.balanceOf(w.address);
    if (before < MINT_MIN[name]) {
      const tx = await core.connect(admin).mint(w.address, MINT[name]);
      const rc = await tx.wait();
      const after = await token.balanceOf(w.address);
      record(
        `| ${name} | ${ethers.formatUnits(MINT[name], 6)} | ${ethers.formatUnits(after, 6)} | [${rc.hash.slice(0, 10)}…](https://${network.name}.etherscan.io/tx/${rc.hash}) |`
      );
    } else {
      record(`| ${name} | skipped | ${ethers.formatUnits(before, 6)} | — (already funded) |`);
    }
  }
  record("");
  record(`Escrow account (LetterOfCredit module): \`${dep.letterOfCredit}\``);
  record("");
  record("> The ADMIN/deployer also retains its originally granted roles from the single-account");
  record("> deployment; the workflow demo (`scripts/demo-accounts.js`) signs every step with the");
  record("> distinct account above.");

  // ---------------------------------------------------------------- save record
  const out = path.join(__dirname, "..", "deployments", `${network.name}-accounts-setup.md`);
  fs.writeFileSync(out, log.join("\n") + "\n");
  console.log(`\nRecord saved → deployments/${network.name}-accounts-setup.md`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("setup failed:", e.shortMessage || e.message);
  process.exit(1);
});
