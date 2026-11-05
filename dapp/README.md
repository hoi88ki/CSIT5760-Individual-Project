# TradeChain — Role Dashboard (React + Vite)

A role-based interface for driving TradeChain on a local Hardhat node or Sepolia, built with
**React (Vite) + Ethers.js v6 + MetaMask**.

## Run it

```bash
# terminal 1 — local chain + deployment
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost     # copy the TradeChainCore address

# terminal 2 — dashboard
cd dapp
npm install
npm run dev        # → http://localhost:5173
```

1. Open <http://localhost:5173>.
2. Paste the **TradeChainCore** address and click **Connect / Load**.
3. Choose the **active account** (with a local node, `eth_accounts` returns the unlocked role
   wallets — Exporter, Importer, Bank, Logistics, Verifier — no private keys needed).
4. Walk the numbered panels: order → shipment → documents/funding → milestones.

> With **MetaMask** the page uses it automatically; switch MetaMask to the Hardhat/Sepolia
> network and select the relevant role wallet.

## Off-chain documents (per-role IPFS)

Each role runs its **own kubo node** and keeps its own copy; the **IPFS node** field sets the node
endpoint for both upload and retrieval (default `http://127.0.0.1:5001`, override the default with
`VITE_KUBO_API`). Run one kubo daemon per role with distinct API ports, e.g.:

```bash
IPFS_PATH=~/.ipfs-exporter ipfs daemon   # API :5001  (exporter)
IPFS_PATH=~/.ipfs-importer ipfs daemon   # API :5011  (importer)
IPFS_PATH=~/.ipfs-bank     ipfs daemon   # API :5021  (bank)
```

The flow is: the issuing role uploads to **its** node (it keeps a copy) → the CID is anchored
on-chain (`DocumentRegistry`) → **any involved party reads the document through the DApp** by
pointing the *Document viewer* at the node holding the copy. A counterparty can also pull its own
copy onto its node so it stays available. Because CIDs are content-addressed, every copy serves the
same CID, so there is exactly **one CID per `(shipment, DocType)`** and **no contract change** is
needed.

Out-of-band upload / read / copy:

```bash
node scripts/ipfs-add.js path/to/document.pdf                                   # default node
node scripts/ipfs-add.js path/to/document.pdf --api /ip4/127.0.0.1/tcp/5011     # a specific node
ipfs cat bafy... --api /ip4/127.0.0.1/tcp/5011                                  # read from a role node
node scripts/ipfs-pin.js bafy... --api /ip4/127.0.0.1/tcp/5011                  # keep your own copy
node scripts/ipfs-add.js path/to/document.pdf --pinata                          # optional hosted
```

Full setup (per-role nodes, upload/retrieve flow):
[`../docs/IPFS_CONSORTIUM.md`](../docs/IPFS_CONSORTIUM.md).

> **Limitations.** CIDs are public on-chain, so per-role nodes give *consortium retrieval by
> convention*, not *confidentiality*: restrict the swarm or encrypt before upload if documents are
> sensitive. And a copy must exist somewhere — a CID whose only holder is offline (and that no
> counterparty copied) cannot be fetched.

## Build

```bash
npm run build      # static bundle in dist/
npm run preview    # serve the build on :5173
```

## Configuration (optional env)

| Variable | Purpose |
|----------|---------|
| `VITE_RPC_URL` | JSON-RPC endpoint used when MetaMask is absent (default `http://127.0.0.1:8545`). |
| `VITE_KUBO_API` | Local kubo HTTP API base (default `http://127.0.0.1:5001`). |
| `VITE_PINATA_JWT` | Pinata JWT for hosted uploads. |
