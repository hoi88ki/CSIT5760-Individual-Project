// Deploys the TradeChain suite (7 contracts) and wires the operational roles.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Optional env:
//   STABLECOIN_ADDRESS   use an existing ERC-20 instead of deploying the demo TradeUSD
//   TRADECHAIN_EXPORTER / _IMPORTER / _BANK / _LOGISTICS / _VERIFIER
//                        role wallets (default to signers 1..5 on local networks)
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROLE_KEYS = {
  ROLE_EXPORTER: "TRADECHAIN_EXPORTER",
  ROLE_IMPORTER: "TRADECHAIN_IMPORTER",
  ROLE_BANK: "TRADECHAIN_BANK",
  ROLE_LOGISTICS: "TRADECHAIN_LOGISTICS",
  ROLE_VERIFIER: "TRADECHAIN_VERIFIER",
};

function saveDeployment(name, data) {
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\nSaved deployment record → ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const signers = await ethers.getSigners();
  const [deployer] = signers;

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  // 1) Settlement token (stablecoin).
  let tokenAddress = process.env.STABLECOIN_ADDRESS;
  let tokenMeta = null;
  let deployedToken = false;
  if (!tokenAddress) {
    const TradeUSD = await ethers.getContractFactory("TradeUSD");
    const token = await TradeUSD.deploy(deployer.address, "TradeChain USD", "tUSD", 6);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    tokenMeta = { name: "TradeChain USD", symbol: "tUSD", decimals: 6, admin: deployer.address };
    deployedToken = true;
    console.log(`TradeUSD deployed: ${tokenAddress}`);
  } else {
    console.log(`Using existing stablecoin: ${tokenAddress}`);
  }

  // 2) Core (deploys + owns the six companion contracts).
  const Core = await ethers.getContractFactory("TradeChainCore");
  const core = await Core.deploy(tokenAddress);
  await core.waitForDeployment();
  const coreAddress = await core.getAddress();
  console.log(`TradeChainCore deployed: ${coreAddress}`);

  // 3) Let the core mint demo TradeUSD.
  if (deployedToken) {
    const token = await ethers.getContractAt("TradeUSD", tokenAddress);
    await (await token.connect(deployer).grantRole(await token.MINTER_ROLE(), coreAddress)).wait();
  }

  // 4) Resolve role wallets and grant roles.
  const roleNames = Object.keys(ROLE_KEYS);
  const roleConstants = await Promise.all(roleNames.map((n) => core[n]()));
  const accounts = roleNames.map((n, i) => {
    const addr = process.env[ROLE_KEYS[n]];
    if (addr) return addr;
    return (signers[i + 1] || deployer).address;
  });

  await (await core.connect(deployer).grantRoles(roleConstants, accounts)).wait();
  console.log("\nRoles granted:");
  roleNames.forEach((n, i) => console.log(`  ${n.padEnd(16)} ${accounts[i]}`));

  saveDeployment(network.name, {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    settlementToken: tokenAddress,
    tokenMeta,
    core: coreAddress,
    shipmentNFT: await core.shipmentNFT(),
    shipmentTracker: await core.shipmentTracker(),
    documentRegistry: await core.documentRegistry(),
    complianceEngine: await core.complianceEngine(),
    letterOfCredit: await core.letterOfCredit(),
    roles: Object.fromEntries(roleNames.map((n, i) => [n, accounts[i]])),
    deployedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
