# TradeChain — Per-role IPFS (one node per participant)

Each participant runs its **own** kubo node and **keeps its own copy** of the documents it handles.
Documents are addressed by **CID**, so any involved party can retrieve a document through the DApp
by pointing at the node that holds a copy. Only the CID is anchored on-chain.

The blockchain is unchanged by this topology: `DocumentRegistry` stores **one CID per
`(shipment, DocType)`** (plus issuer, timestamp, verification status). Content addressing means
every copy of the same file yields the same CID, so no per-role on-chain records are required.

## 1. Roles, nodes and ports (single-machine demo)

| Role | `IPFS_PATH` | API port | Multiaddr |
|------|-------------|:--------:|-----------|
| Exporter | `./.ipfs-exporter` | 5001 | `/ip4/127.0.0.1/tcp/5001` |
| Importer | `./.ipfs-importer` | 5011 | `/ip4/127.0.0.1/tcp/5011` |
| Bank | `./.ipfs-bank` | 5021 | `/ip4/127.0.0.1/tcp/5021` |
| Logistics | `./.ipfs-logistics` | 5031 | `/ip4/127.0.0.1/tcp/5031` |
| Verifier | `./.ipfs-verifier` | 5041 | `/ip4/127.0.0.1/tcp/5041` |

Initialise and start each node with its own API and gateway ports (one daemon per role):

```bash
IPFS_PATH=./.ipfs-exporter ipfs init
IPFS_PATH=./.ipfs-exporter ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
IPFS_PATH=./.ipfs-exporter ipfs daemon
# repeat per role with 5011 / 5021 / 5031 / 5041
```

> On Windows PowerShell use `$env:IPFS_PATH="./.ipfs-exporter"` before the `ipfs` command.

## 2. Daily flow

1. **Issuing role uploads to its own node** (it now keeps a copy):
   ```bash
   node scripts/ipfs-add.js invoice.pdf --api /ip4/127.0.0.1/tcp/5001
   ```
   (The DApp does the same via the **IPFS node** field in panel 2.)
2. **Anchor the CID on-chain** (`createShipment` / `anchorDocument` / `confirmVesselLoading`).
3. **Any involved party reads the document through the DApp.** In the **Document viewer** panel,
   point the *IPFS node* field at the node that holds the copy (e.g. the exporter's `:5001`) and
   open the anchored CID:
   ```bash
   # underlying call the DApp makes
   ipfs cat bafy... --api /ip4/127.0.0.1/tcp/5001
   # or via the gateway: http://127.0.0.1:8080/ipfs/bafy...
   ```
4. **Keep your own copy** (optional, for resilience): a counterparty that needs a document can pull
   it onto its own node so it stays available even if the origin node goes offline.
   ```bash
   node scripts/ipfs-pin.js bafy... --api /ip4/127.0.0.1/tcp/5011 --api /ip4/127.0.0.1/tcp/5021
   ```

## 3. Availability & confidentiality

- **The CID is the authority.** Any node holding the same bytes serves the same CID; integrity is
  guaranteed regardless of which node responds. No single authoritative node.
- **Availability depends on the copy existing somewhere.** If the only holder of a CID goes offline
  and no counterparty kept a copy, the on-chain anchor survives but the file cannot be fetched —
  make extra copies for long-lived documents.
- **Confidentiality.** CIDs are written to a public chain, so the model gives *consortium-only
  retrieval* by convention, not cryptographic secrecy: anyone who learns the bytes can fetch them.
  Stronger confidentiality would require restricting the swarm (`swarm.key`) or encrypting before
  upload — both optional and out of scope for this prototype.
- **Pinata** (a single hosted provider) is not part of this model; it remains only an optional
  convenience via `ipfs-add.js --pinata`.
