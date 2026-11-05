// Off-chain document storage for the per-role IPFS model.
//
// Each role runs its OWN kubo node, so both the upload target and the retrieval target are
// configurable. A role keeps its own copy of the documents it handles, and any involved party can
// `cat` the document by its CID from whichever node holds it (point the "IPFS node" field at that
// role's node). The default is the local node's HTTP API; set VITE_KUBO_API (or pass an explicit
// `apiBase`) to point at another role's node, e.g. http://127.0.0.1:5011.
//
// Only the resulting CID is anchored on-chain (DocumentRegistry). Because CIDs are
// content-addressed, any node that holds the same bytes serves the same CID — no contract change
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

/**
 * Fetches a document by CID from a kubo node (any node that holds a copy) and returns a Blob.
 * This is what lets a counterparty read a document someone else uploaded, entirely through the DApp.
 */
export async function fetchFromKubo(cid, apiBase = DEFAULT_KUBO_API) {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/v0/cat?arg=${encodeURIComponent(cid)}`, {
    method: "POST",
  });
  if (!res.ok)
    throw new Error(`kubo retrieve failed (${res.status}). Is the node holding ${cid} reachable at ${apiBase}?`);
  return res.blob();
}

/** Optional hosted Pinata path (single provider; not part of the per-role model). */
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
