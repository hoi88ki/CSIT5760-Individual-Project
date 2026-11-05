# TradeChain — Consortium IPFS (one node per role)

Decision **B.8**: each participant runs its **own** kubo node, optionally in a **private swarm**;
documents are addressed by CID and **manually pinned** on the nodes that need them.

The blockchain is unchanged by this topology: `DocumentRegistry` stores **one CID per
`(shipment, DocType)`** (plus issuer, timestamp, verification status). Content addressing means
every replica of the same file yields the same CID, so no per-role on-chain records are required.

## 1. Roles, nodes and ports (single-machine demo)

| Role | `IPFS_PATH` | API port | Multiaddr |
|------|-------------|:--------:|-----------|
| Exporter | `./.ipfs-exporter` | 5001 | `/ip4/127.0.0.1/tcp/5001` |
| Importer | `./.ipfs-importer` | 5011 | `/ip4/127.0.0.1/tcp/5011` |
| Bank | `./.ipfs-bank` | 5021 | `/ip4/127.0.0.1/tcp/5021` |
| Logistics | `./.ipfs-logistics` | 5031 | `/ip4/127.0.0.1/tcp/5031` |
| Verifier | `./.ipfs-verifier` | 5041 | `/ip4/127.0.0.1/tcp/5041` |

Initialise and start each node with the API and gateway ports set in its config (kubo uses only
one API port per node; run one daemon per role):

```bash
IPFS_PATH=./.ipfs-exporter ipfs init
IPFS_PATH=./.ipfs-exporter ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001
IPFS_PATH=./.ipfs-exporter ipfs daemon
# repeat per role with 5011 / 5021 / 5031 / 5041
```

> On Windows PowerShell use `$env:IPFS_PATH="./.ipfs-exporter"` before the `ipfs` command.

## 2. Optional private swarm (confidentiality)

A **private swarm** (`swarm.key`) lets only consortium members retrieve content. Generate one key
and copy the identical `swarm.key` into every node's repo, then remove the public bootstrap peers:

```bash
# 1) 64 hex chars
python -c "import secrets;print(secrets.token_hex(32))"   # or: openssl rand -hex 32

# 2) create <IPFS_PATH>/swarm.key
#    /key/swarm/psk/1.0.0/
#    /base16/
#    <the 64 hex chars>

# 3) per node: drop public bootstrappers and reconnect to peers only
ipfs bootstrap rm --all
```

**Confidentiality caveat.** CIDs are written to a public chain, so per-role nodes + a private
swarm give *consortium-only retrieval*, not cryptographic secrecy: anyone who (a) is in the swarm
or (b) learns the bytes can fetch them. Stronger confidentiality would require **encrypting before
pinning** (out of scope per the earlier "no encryption" decision).

## 3. Daily flow

1. **Issuing role** uploads to its own node:
   ```bash
   node scripts/ipfs-add.js invoice.pdf --api /ip4/127.0.0.1/tcp/5001
   ```
   (The DApp does the same via the **IPFS node** field in panel 2.)
2. **Anchor the CID on-chain** (`createShipment` / `anchorDocument` / `confirmVesselLoading`).
3. **Replicate (pin) the CID** on the nodes that need it:
   ```bash
   node scripts/ipfs-pin.js bafy... --api /ip4/127.0.0.1/tcp/5011 --api /ip4/127.0.0.1/tcp/5021
   ```
4. **Retrieve** from any node; the CID proves integrity:
   ```bash
   ipfs cat bafy... --api /ip4/127.0.0.1/tcp/5011
   # or the gateway: http://127.0.0.1:8081/ipfs/bafy...
   ```

## 4. Availability & limits

- **Replication is required for availability.** An unpinned CID becomes unfetchable once its only
  holder goes offline (the on-chain anchor survives, the document does not).
- **No single authoritative node.** The CID is the authority; any correct replica is valid.
- **Pinata** (a single hosted provider) is not part of this model; it remains only an optional
  convenience via `ipfs-add.js --pinata`.
