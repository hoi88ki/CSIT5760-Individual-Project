// Adds a file to a LOCAL IPFS node (kubo) and prints its CIDv1.
// Requires the `ipfs` CLI and a running daemon (`ipfs daemon`).
//
//   node scripts/ipfs-add.js path/to/invoice.pdf
//
// The printed CID is the value passed to createShipment()/anchorDocument().
// A purely local node keeps documents private and independently verifiable (Q12).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/ipfs-add.js <file>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  let cid;
  try {
    cid = execFileSync("ipfs", ["add", "--cid-version=1", "--quieter", path.resolve(file)], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    console.error("Failed to talk to the local IPFS daemon.");
    console.error("Install kubo (https://docs.ipfs.tech/install/) and run `ipfs daemon` first.");
    console.error(err.message);
    process.exit(1);
  }

  console.log(`file: ${file}`);
  console.log(`cid : ${cid}`);
  console.log(`uri : ipfs://${cid}`);
}

main();
