// Off-chain document upload for the consortium IPFS model (decision B.8).
//
// Each role runs its OWN kubo node, so the upload target is configurable. The default is the
// local node's HTTP API; set VITE_KUBO_API (or pass an explicit `apiBase`) to point at the
// active role's node, e.g. http://127.0.0.1:5011 for a second node.
//
// Only the resulting CID is anchored on-chain (DocumentRegistry). Because CIDs are
// content-addressed, any node that pins the same bytes serves the same CID — no contract change
// is needed and there is exactly one CID per (shipment, DocType).

const DEFAULT_KUBO_API = import.meta.env.VITE_KUBO_API || "http://127.0.0.1:5001";

/** Uploads a file to a kubo node and returns its CIDv1. */
export async function uploadToKubo(file, apiBase = DEFAULT_KUBO_API) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/v0/add?cid-version=1&quieter=true`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`kubo upload failed (${res.status}). Is 'ipfs daemon' running at ${apiBase}?`);
  const json = await res.json();
  return json.Hash;
}

/** Optional hosted Pinata path (single provider; not part of the consortium model). */
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

/**
 * Uploads a file and returns its CIDv1.
 * @param {File} file
 * @param {{provider?: "kubo"|"pinata", apiBase?: string}} opts
 */
export async function uploadFile(file, { provider = "kubo", apiBase } = {}) {
  return provider === "pinata" ? uploadToPinata(file) : uploadToKubo(file, apiBase);
}
