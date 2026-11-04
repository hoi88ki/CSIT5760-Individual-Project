// Deploys the TradeChain suite and wires the six operational roles.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
//
// Optional env:
//   STABLECOIN_ADDRESS   use an existing ERC-20 instead of deploying the demo MockERC20
//   TRADECHAIN_SELLER / _BUYER / _CARRIER / _ISSUING_BANK / _ADVISING_BANK / _VERIFIER
//                        role wallets (defaults to the first six signers on local networks)
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ROLE_KEYS = {
  ROLE_SELLER: "TRADECHAIN_SELLER",
  ROLE_BUYER: "TRADECHAIN_BUYER",
  ROLE_CARRIER: "TRADECHAIN_CARRIER",
  ROLE_ISSUING_BANK: "TRADECHAIN_ISSUING_BANK",
  ROLE_ADVISING_BANK: "TRADECHAIN_ADVISING_BANK",
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
  if (!tokenAddress) {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("TradeChain USD", "tUSD", 6);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    console.log(`MockERC20 (tUSD) deployed: ${tokenAddress}`);
  } else {
    console.log(`Using existing stablecoin: ${tokenAddress}`);
  }

  // 2) Core (deploys + owns the EBLToken and TradeCertNFT).
  const Core = await ethers.getContractFactory("TradeChainCore");
  const core = await Core.deploy(tokenAddress);
  await core.waitForDeployment();
  const coreAddress = await core.getAddress();
  console.log(`TradeChainCore deployed: ${coreAddress}`);

  // 3) Resolve role wallets.
  const roleNames = Object.keys(ROLE_KEYS);
  const roleConstants = await Promise.all(roleNames.map((n) => core[n]()));
  const accounts = roleNames.map((n, i) => {
    const addr = process.env[ROLE_KEYS[n]];
    if (addr) return addr;
    // Fall back to signers 1..6 when available (local networks).
    return (signers[i + 1] || deployer).address;
  });

  await (await core.connect(deployer).grantRoles(roleConstants, accounts)).wait();
  console.log("\nRoles granted:");
  roleNames.forEach((n, i) => console.log(`  ${n.padEnd(20)} ${accounts[i]}`));

  const ebl = await core.eblToken();
  const cert = await core.certNFT();

  saveDeployment(network.name, {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    settlementToken: tokenAddress,
    core: coreAddress,
    eblToken: ebl,
    tradeCertNFT: cert,
    roles: Object.fromEntries(roleNames.map((n, i) => [n, accounts[i]])),
    deployedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
