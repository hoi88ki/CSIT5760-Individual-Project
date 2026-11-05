// Pins a CID on one or more IPFS nodes, so a role keeps its own copy of a document.
//
//   node scripts/ipfs-pin.js <cid> --api /ip4/127.0.0.1/tcp/5011
//   node scripts/ipfs-pin.js <cid> --api /ip4/127.0.0.1/tcp/5001 --api /ip4/127.0.0.1/tcp/5011
//
// After the issuing role anchors a CID on-chain, any counterparty that needs the document can pull
// it onto its own node. Because CIDs are content-addressed, every copy serves the same bytes.
const { execFileSync } = require("child_process");

function pin(cid, api) {
  const args = ["pin", "add", cid];
  if (api) args.push("--api", api);
  try {
    execFileSync("ipfs", args, { stdio: "inherit" });
  } catch (err) {
    console.error(`pin failed for ${api || "(default node)"}: ${err.message}`);
    process.exitCode = 1;
  }
}

function main() {
  const args = process.argv.slice(2);
  const apis = [];
  args.forEach((a, i) => {
    if (a === "--api" && args[i + 1]) apis.push(args[i + 1]);
  });
  const cid = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--api");

  if (!cid) {
    console.error("Usage: node scripts/ipfs-pin.js <cid> [--api <multiaddr> ...]");
    process.exit(1);
  }
  if (apis.length === 0) apis.push(undefined); // default node

  for (const api of apis) {
    console.log(`pinning ${cid} on ${api || "default node"}`);
    pin(cid, api);
  }
}

main();
