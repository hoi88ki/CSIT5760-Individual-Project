// Verifies the six deployed contracts on Etherscan from a deployments/<network>.json record.
//   npx hardhat run scripts/verify.js --network sepolia
const fs = require("fs");
const path = require("path");
const { run, network } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record for ${network.name}.`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`Verifying on ${network.name}…`);

  const targets = [
    {
      name: "TradeChainCore",
      address: dep.core,
      constructorArguments: [dep.settlementToken],
    },
    {
      name: "ShipmentTracker",
      address: dep.shipmentTracker,
      constructorArguments: [dep.core],
    },
    {
      name: "DocumentRegistry",
      address: dep.documentRegistry,
      constructorArguments: [dep.core],
    },
    {
      name: "ComplianceEngine",
      address: dep.complianceEngine,
      constructorArguments: [dep.core, dep.documentRegistry, dep.shipmentTracker],
    },
    {
      name: "LetterOfCredit",
      address: dep.letterOfCredit,
      constructorArguments: [dep.core, dep.settlementToken, dep.shipmentTracker, dep.complianceEngine, dep.core],
    },
  ];

  if (dep.tokenMeta) {
    targets.push({
      name: "TradeUSD",
      address: dep.settlementToken,
      constructorArguments: [dep.tokenMeta.admin, dep.tokenMeta.name, dep.tokenMeta.symbol, dep.tokenMeta.decimals],
    });
  }

  for (const t of targets) {
    console.log(`  → ${t.name} ${t.address}`);
    try {
      await run("verify:verify", { address: t.address, constructorArguments: t.constructorArguments });
    } catch (err) {
      console.warn(`    (skipped ${t.name}: ${err.message.split("\n")[0]})`);
    }
  }

  console.log("Verification complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
