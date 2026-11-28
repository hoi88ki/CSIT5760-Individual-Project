# TradeChain — Per-role IPFS (one node per participant)

Each participant runs its **own** kubo node and **keeps its own copy** of the documents it handles.
Documents are addressed by **CID**, so any involved party can retrieve a document through the console
by pointing at the node that holds a copy. Only the CID is anchored on-chain.

The blockchain is unchanged by this topology: `DocumentRegistry` stores **one CID per
`(shipment, DocType)`** (plus issuer, timestamp, verification status). Content addressing means
every copy of the same file yields the same CID, so no per-role on-chain records are required.

## 1. Roles, nodes and ports (single-machine demo)

Node repos live under `ipfs_data/` (gitignored runtime data — do not commit them):

| Role | `IPFS_PATH` | API port | Gateway port | API multiaddr |
|------|-------------|:--------:|:------------:|---------------|
| Exporter | `./ipfs_data/Exporter` | 5001 | 5002 | `/ip4/127.0.0.1/tcp/5001` |
| Importer | `./ipfs_data/Importer` | 5011 | 5012 | `/ip4/127.0.0.1/tcp/5011` |
| Bank | `./ipfs_data/Bank` | 5021 | 5022 | `/ip4/127.0.0.1/tcp/5021` |
| Logistics | `./ipfs_data/Logistics` | 5031 | 5032 | `/ip4/127.0.0.1/tcp/5031` |
| Verifier | `./ipfs_data/Verifier` | 5041 | 5042 | `/ip4/127.0.0.1/tcp/5041` |

Initialise and start each node with its own API and gateway ports (one daemon per role):

```bash
# In Linux
IPFS_PATH=./ipfs_data/Exporter ipfs init
IPFS_PATH=./ipfs_data/Exporter ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
IPFS_PATH=./ipfs_data/Exporter ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/5002
IPFS_PATH=./ipfs_data/Exporter ipfs daemon --offline # Offline mode to disable swarm
# repeat per role with 5011 / 5021 / 5031 / 5041 (gateways 5012 / 5022 / 5032 / 5042)

# In Windows
$env:IPFS_PATH = ".\ipfs_data\Exporter"
ipfs init
ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/5002
ipfs daemon --offline # Offline mode to disable swarm
# repeat per role with 5011 / 5021 / 5031 / 5041 (gateways 5012 / 5022 / 5032 / 5042)
```

> **`--offline` disables the swarm** on purpose for the single-machine demo: nodes never
> replicate from each other automatically, so a node serves exactly the documents it (or a
> counterparty via `ipfs-pin.js`) copied to it. That keeps the "who holds what" model explicit;
> drop the flag on a real network to get swarm replication.

## 2. Daily flow

1. **Issuing role uploads to its own node** (it now keeps a copy):
   ```bash
   node scripts/ipfs-add.js invoice.pdf --api /ip4/127.0.0.1/tcp/5001
   ```
   (The console does the same via the **IPFS node** field on the Documents tab.)
2. **Anchor the CID on-chain** (`createShipment` / `anchorDocument` / `confirmVesselLoading`).
3. **Any involved party reads the document through the console.** In the Documents tab, point the
   *IPFS node* field at the node that holds the copy (e.g. the exporter's `:5001`) and open the
   anchored CID:
   ```bash
   # underlying call the console makes
   ipfs cat bafy... --api /ip4/127.0.0.1/tcp/5001
   # or via that node's gateway: http://127.0.0.1:5002/ipfs/bafy...
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
