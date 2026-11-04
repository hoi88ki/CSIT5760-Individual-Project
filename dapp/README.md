# TradeChain — Role Dashboard

A minimal, single-page interface for driving TradeChain (ethers v6, **no build step**).

## Run it

```bash
# terminal 1 — local chain + deployment
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost     # copy the core address

# terminal 2 — dashboard
node dapp/server.js        # → http://localhost:5173
```

1. Open <http://localhost:5173>.
2. Paste the **TradeChainCore** address and click **Connect / Load**.
3. Pick the **active account** from the dropdown. With a local node, `eth_accounts`
   returns the six unlocked role wallets (Seller, Buyer, Carrier, Issuing bank,
   Advising bank, Verifier) — no private keys needed.
4. Use the numbered panels: order → shipment → documents → milestones.

> With **MetaMask** available, the page uses it automatically; switch MetaMask to
> the Hardhat/Sepolia network and use the relevant role wallet.

## Panels

| Panel | Functions |
|-------|-----------|
| **1 · Order & Shipment** | `createOrder` (Buyer), `createShipment` (Seller) |
| **2 · Documents & Funding** | token `approve`, `openLetterOfCredit` (Buyer), `anchorDocument` (role-gated) |
| **3 · Milestones** | `confirmPickup` / `confirmVesselLoading` (Carrier), `payCustomsDuty`, `confirmFinalDelivery` (Buyer), `reclaimExpiredLC`, `forceFinalizeDelivery` |
| **Shipment viewer** | live phase, flags, document validity |

The dashboard calls the real on-chain contract; it does no off-chain validation beyond
formatting. Documents live on IPFS — use `node scripts/ipfs-add.js <file>` to obtain a CID.
