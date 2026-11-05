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

## Off-chain documents (IPFS)

The upload buttons default to a **local kubo** node through its HTTP API
(`http://127.0.0.1:5001`): run `ipfs daemon` first. Override the endpoint with
`VITE_KUBO_API`. To use hosted Pinata instead, set `VITE_PINATA_JWT` and build the app; the
`uploadFile()` helper in `src/ipfs.js` selects the provider. You can also upload out-of-band:

```bash
node scripts/ipfs-add.js path/to/document.pdf          # local kubo
node scripts/ipfs-add.js path/to/document.pdf --pinata # hosted Pinata
```

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
