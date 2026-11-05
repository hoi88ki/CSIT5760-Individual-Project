// Off-chain document upload. Defaults to a LOCAL kubo node (project decision B.8), with an
// optional hosted Pinata path if VITE_PINATA_JWT is provided at build time.

const KUBO_API = import.meta.env.VITE_KUBO_API || "http://127.0.0.1:5001";

export async function uploadToKubo(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${KUBO_API}/api/v0/add?cid-version=1&quieter=true`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`kubo upload failed: ${res.status}. Is 'ipfs daemon' running?`);
  const json = await res.json();
  return json.Hash;
}

export async function uploadToPinata(file) {
  const jwt = import.meta.env.VITE_PINATA_JWT;
  if (!jwt) throw new Error("VITE_PINATA_JWT is not set.");
  const form = new FormData();
  form.append("file", file);
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Pinata upload failed: ${res.status}`);
  return (await res.json()).IpfsHash;
}

/** Uploads a file and returns its CIDv1 (local kubo by default). */
export async function uploadFile(file, provider = "kubo") {
  return provider === "pinata" ? uploadToPinata(file) : uploadToKubo(file);
}
