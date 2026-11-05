// Adds a file to IPFS and prints its CIDv1 — the value passed to createShipment()/anchorDocument().
//
//   node scripts/ipfs-add.js path/to/invoice.pdf            # local kubo node (recommended)
//   node scripts/ipfs-add.js path/to/invoice.pdf --pinata   # hosted Pinata (needs PINATA_JWT)
//
// Local kubo keeps commercially sensitive documents private and independently verifiable
// (project decision B.8). Hosted pinning is available as an option for convenience.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function viaKubo(file) {
  try {
    return execFileSync("ipfs", ["add", "--cid-version=1", "--quieter", path.resolve(file)], {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    console.error("Failed to talk to the local IPFS daemon.");
    console.error("Install kubo (https://docs.ipfs.tech/install/) and run `ipfs daemon` first.");
    console.error(err.message);
    process.exit(1);
  }
}

async function viaPinata(file) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    console.error("PINATA_JWT is not set. Add it to .env or use the local kubo mode.");
    process.exit(1);
  }
  const form = new FormData();
  const bytes = fs.readFileSync(file);
  form.append("file", new Blob([bytes]), path.basename(file));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) {
    console.error(`Pinata upload failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const json = await res.json();
  return json.IpfsHash;
}

async function main() {
  const args = process.argv.slice(2);
  const usePinata = args.includes("--pinata");
  const file = args.find((a) => !a.startsWith("--"));

  if (!file) {
    console.error("Usage: node scripts/ipfs-add.js <file> [--pinata]");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const cid = usePinata ? await viaPinata(file) : await viaKubo(file);
  console.log(`file: ${file}`);
  console.log(`cid : ${cid}`);
  console.log(`uri : ipfs://${cid}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
