// Verifies the deployed contracts on Etherscan from a deployments/<network>.json record.
//   npx hardhat run scripts/verify.js --network sepolia
const fs = require("fs");
const path = require("path");
const { run, network } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record for ${network.name}.`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`Verifying on ${network.name}…`);

  await run("verify:verify", {
    address: dep.core,
    constructorArguments: [dep.settlementToken],
  });
  await run("verify:verify", {
    address: dep.eblToken,
    constructorArguments: [dep.core],
  });
  await run("verify:verify", {
    address: dep.tradeCertNFT,
    constructorArguments: [dep.core],
  });
  await run("verify:verify", {
    address: dep.settlementToken,
    constructorArguments: ["TradeChain USD", "tUSD", 6],
  });

  console.log("Verification complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
