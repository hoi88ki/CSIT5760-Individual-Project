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

## Off-chain documents (consortium IPFS, one node per role)

Each role runs its **own kubo node**; the **IPFS node** field in panel 2 sets that role's node
endpoint (default `http://127.0.0.1:5001`, override the default with `VITE_KUBO_API`). Run one
kubo daemon per role with distinct API ports, e.g.:

```bash
IPFS_PATH=~/.ipfs-exporter ipfs daemon   # API :5001  (exporter)
IPFS_PATH=~/.ipfs-importer ipfs daemon   # API :5011  (importer)
IPFS_PATH=~/.ipfs-bank     ipfs daemon   # API :5021  (bank)
```

The flow is: the issuing role uploads to **its** node → the CID is anchored on-chain
(`DocumentRegistry`) → the CID is **replicated/pinned** to the other nodes so any party can
retrieve the bytes. Because CIDs are content-addressed, every replica serves the same CID, so
there is exactly **one CID per `(shipment, DocType)`** and **no contract change** is needed.

Out-of-band uploads:

```bash
node scripts/ipfs-add.js path/to/document.pdf                                   # default node
node scripts/ipfs-add.js path/to/document.pdf --api /ip4/127.0.0.1/tcp/5011     # a specific node
node scripts/ipfs-pin.js bafy... --api /ip4/127.0.0.1/tcp/5011                  # replicate across nodes
node scripts/ipfs-add.js path/to/document.pdf --pinata                          # optional hosted
```

Full setup (per-role nodes, private swarm key, pin/retrieve flow):
[`../docs/IPFS_CONSORTIUM.md`](../docs/IPFS_CONSORTIUM.md).

> **Limitations.** CIDs are public on-chain, so per-role nodes give *ownership/availability*, not
> *confidentiality*: use a **private swarm** and/or encrypt before pinning if documents are
> sensitive. And replication is required for availability — an unpinned CID is unfetchable once
> the only holding node goes offline.

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
