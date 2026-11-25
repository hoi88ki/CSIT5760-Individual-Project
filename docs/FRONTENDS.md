# TradeChain front ends and MetaMask

TradeChain includes two browser interfaces that both connect to the same `TradeChainCore` contract:

| Interface | Location | Start command | Wallet behavior |
|---|---|---|---|
| React role dashboard | [`dapp/`](../dapp/) | `cd dapp && npm install && npm run dev` | Explicitly requests MetaMask account access when you click **Connect MetaMask / Load**. Without MetaMask, it uses the configured JSON-RPC endpoint — on a local Hardhat node the unlocked accounts can sign, and the **Active account** selector switches the sender. |
| No-build flow console | [`ui/index.html`](../ui/index.html) | `python -m http.server 8090` from the repository root | Starts without a permission prompt; it can use an already-authorized MetaMask account, otherwise it is read-only. Click **Connect wallet** to authorize accounts, then choose the active signer from the header account menu. For local demos it also accepts a **test-only private key** in the connection panel. |

## Connect using MetaMask

1. Install and unlock MetaMask in the browser, then select the account that has the required TradeChain role.
2. Select the chain where the core is deployed:
   - **Sepolia:** chain ID `11155111`; the deployed core address is in [`deployments/sepolia.json`](../deployments/sepolia.json) (the flow console's *Sepolia* preset points there).
   - **Local Hardhat:** chain ID `31337`; start `npx hardhat node`, deploy with `npx hardhat run scripts/deploy.js --network localhost`, and use the core address printed by the deployment script (also saved to `deployments/localhost.json`).
3. Open the dashboard over `http://localhost` or another secure origin. In the React app, paste the core address and click **Connect MetaMask / Load**. In the standalone console, click **Connect wallet**, then **Load core** if needed.
4. Review the connected account and chain before submitting. MetaMask displays a confirmation for each transaction; the selected account must hold the role required by that action.

Both interfaces follow MetaMask account and chain changes. If you switch accounts or networks, verify the displayed address/chain and reload the core if the interface asks you to. They do not request or store a seed phrase or MetaMask private key. Contract reads can be made without an authorized wallet; writes need an authorized signer.

## Local Hardhat wallet notes

A local Hardhat node creates deterministic test accounts. For a browser transaction, import one of those **test-only** accounts into MetaMask and add the local network (`http://127.0.0.1:8545`, chain ID `31337`). Never import a real wallet into a local development setup, and never reuse a Hardhat test key on a public network.

The standalone console has an optional private-key field solely for local demonstrations; the value stays in page memory and must only be used with a local test node. MetaMask is the recommended path. The React dashboard has no private-key input — against a local node it signs with the unlocked account chosen in the **Active account** selector.

## Simulating the whole L/C workflow in the UI (local node, multiple accounts)

The workflow is now a **bank-issued documentary credit**:

```
Importer applies → issuing bank issues & funds the L/C → the named exporter ships →
exporter presents documents → bank examines & honors (sight / deferred) → delivery &
title → (expired unused credits return to the issuing bank)
```

`scripts/seed-demo.js` drives all of it from the CLI against the same deployment. To walk it
through a UI instead, run:

```bash
npx hardhat node                                              # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # terminal 2 → copy the core address
python -m http.server 8090                                    # terminal 3 → http://127.0.0.1:8090/ui/index.html
# and/or: cd dapp && npm install && npm run dev               # → http://localhost:5173
```

The deploy grants the roles to deterministic Hardhat accounts:

| Role | Account (index) | Address |
|------|-----------------|---------|
| Admin / deployer | #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Exporter (beneficiary) | #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Importer (applicant) | #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| Issuing bank | #3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |
| Logistics | #4 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` |
| Verifier | #5 | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` |

In the **flow console**, paste each account's test key into the *Test-only signer private key*
field and click **Connect wallet** to switch the active signer between steps (in the React
dashboard, pick each account in the **Active account** selector instead). Then:

1. **Admin (#0)** — *5 · Admin & registry*: mint 1,000,000 tUSD to the bank, the importer and the
   exporter (the bank is the party that funds every escrow).
2. **Bank (#3)** — *0 · Connection*: **Approve TradeUSD (max)** so the core can pull the credit
   amount when issuing.
3. **Importer (#2)** — *3 · Apply for credit*: fill the beneficiary (exporter #1), an Incoterm,
   the L/C amount, **Payment term** (Sight, or Deferred + deferral days) and **Deadline**, then
   **Importer → createOrder (apply for L/C)**. The order id is auto-filled; nothing is funded yet.
4. *(Optional negative check)* **Exporter (#1)**: click **Exporter → createShipment** now — it must
   be refused: the credit is not issued (`InvalidState`).
5. **Bank (#3)** — *3*: **Bank → issueLetterOfCredit (funds the escrow)**. The viewer shows phase
   `LCIssued`, the escrow balance rises by the L/C amount, and the L/C panel records the issuing
   bank, the beneficiary and the stipulated document bitmask.
6. **Exporter (#1)** — *3*: paste invoice/packing-list CIDs, **Exporter → createShipment**. Phase
   `Shipped`, title NFT minted and escrowed by the core.
7. **Verifier (#5)** — *2 · Documents*: anchor the certificates the credit stipulates (★ in the
   document table) — e.g. the inspection certificate for FOB.
8. **Logistics (#4)** — *4 · Presentation, examination & custody*: paste a B/L CID,
   **confirmPickup** then **confirmVesselLoading** (anchors the B/L, sets the title URI, moves
   risk for FOB/CIF). No payment happens at milestones anymore.
9. *(Optional negative check)* **Exporter (#1)**: **presentDocuments** before the B/L exists is
   refused (`MissingMandatoryDocument`); the examination preview row names the missing document.
10. **Exporter (#1)** — *4*: **Exporter → presentDocuments** → phase `Presented`.
11. **Bank (#3)** — *4*: **Bank → honorPresentation (examines & honors)**. A sight credit pays the
    beneficiary immediately (L/C panel: *honored yes · sight paid*); a deferred credit schedules
    payment at `honoredAt + deferral`.
12. **Importer (#2)** — *4*: **Importer → confirmFinalDelivery** → title NFT released to the
    importer; the phase becomes `Settled` once the credit has paid.
13. **Deferred credits only** — advance past maturity on a local node:
    `curl -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"evm_increaseTime","params":[259201]}' http://127.0.0.1:8545`
    (then `evm_mine`), and **anyone** — e.g. the verifier — clicks **drawDeferredPayment**.
14. **Expired unused credit** — apply for another credit (bank issues it), let the deadline pass
    (advance time as above), then **Importer/Bank/Admin → reclaimExpiredLC**: the escrowed funds
    return to the **issuing bank** and the trade ends in `Reclaimed`. If the beneficiary had
    shipped but never presented, the escrowed title returns to the exporter with the goods.

Every step's receipt and the live lifecycle stepper / flow guide in section 1 reflect on-chain
state, so the walkthrough can be verified without reading raw transactions.

## Troubleshooting

- **MetaMask is not detected:** open the page in a browser with the MetaMask extension enabled, reload, and confirm the extension is unlocked. On a local node you can also use the private-key field (console) or the account selector (dashboard).
- **Wrong network:** switch MetaMask to the network matching the core address. The apps do not silently change networks for you.
- **Transaction reverts with an access-control error:** connect the account granted the relevant exporter, importer, **bank**, logistics, verifier, or admin role. The bank role in particular now funds and honors every credit.
- **Transaction reverts with `InvalidState` on `createShipment`:** the credit has not been issued yet — the exporter can only ship after **issueLetterOfCredit**.
- **`InvalidDeadline` when applying:** deadlines are computed from the chain clock; if the local node's time was shifted by `evm_increaseTime`, click **Load core** again (the console and dashboard read the latest block timestamp).
- **Local wallet has no funds:** use a fresh Hardhat node account; local ETH is provided by the node. For the demo `TradeUSD`, the admin must mint test tokens — to the **bank** first (it funds the escrows).
- **IPFS upload fails:** the Kubo API must be running and reachable from the browser, and its CORS configuration must allow the dashboard origin. The local API endpoint is not exposed by the blockchain.
