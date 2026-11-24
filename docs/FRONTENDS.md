# TradeChain front ends and MetaMask

TradeChain includes two browser interfaces that both connect to the same `TradeChainCore` contract:

| Interface | Location | Start command | Wallet behavior |
|---|---|---|---|
| React role dashboard | [`dapp/`](../dapp/) | `cd dapp && npm install && npm run dev` | Explicitly requests MetaMask account access when you click **Connect MetaMask / Load**. Without MetaMask, it uses the configured JSON-RPC endpoint. |
| No-build flow console | [`ui/index.html`](../ui/index.html) | `python -m http.server 8090` from the repository root | Starts without a permission prompt; it can use an already-authorized MetaMask account, otherwise it is read-only. Click **Connect wallet** to authorize accounts, then choose the active signer from the header account menu. |

## Connect using MetaMask

1. Install and unlock MetaMask in the browser, then select the account that has the required TradeChain role.
2. Select the chain where the core is deployed:
   - **Sepolia:** chain ID `11155111`; the current core address is in [`deployments/sepolia.json`](../deployments/sepolia.json).
   - **Local Hardhat:** chain ID `31337`; start `npx hardhat node`, deploy with `npx hardhat run scripts/deploy.js --network localhost`, and use the core address printed by the deployment script (also saved to `deployments/localhost.json`).
3. Open the dashboard over `http://localhost` or another secure origin. In the React app, paste the core address and click **Connect MetaMask / Load**. In the standalone console, click **Connect wallet**, then **Load core** if needed.
4. Review the connected account and chain before submitting. MetaMask displays a confirmation for each transaction; the selected account must hold the role required by that action.

Both interfaces follow MetaMask account and chain changes. If you switch accounts or networks, verify the displayed address/chain and reload the core if the interface asks you to. They do not request or store a seed phrase or MetaMask private key. Contract reads can be made without an authorized wallet; writes need an authorized signer.

## Local Hardhat wallet notes

A local Hardhat node creates deterministic test accounts. For a browser transaction, import one of those **test-only** accounts into MetaMask and add the local network (`http://127.0.0.1:8545`, chain ID `31337`). Never import a real wallet into a local development setup, and never reuse a Hardhat test key on a public network.

The standalone console has an optional private-key field solely for local demonstrations; the value stays in page memory and must only be used with a local test node. MetaMask is the recommended path. The React dashboard has no private-key input.

## Troubleshooting

- **MetaMask is not detected:** open the page in a browser with the MetaMask extension enabled, reload, and confirm the extension is unlocked.
- **Wrong network:** switch MetaMask to the network matching the core address. The apps do not silently change networks for you.
- **Transaction reverts with an access-control error:** connect the account granted the relevant exporter, importer, bank, logistics, verifier, or admin role. On the current Sepolia demo deployment, the five operational roles initially share the deployer address; the deployment JSON records this, and the admin can grant distinct roles with `grantRoles`.
- **Local wallet has no funds:** use a fresh Hardhat node account; local ETH is provided by the node. For the demo `TradeUSD`, the admin must mint test tokens before the importer can fund an L/C.
- **IPFS upload fails:** the Kubo API must be running and reachable from the browser, and its CORS configuration must allow the dashboard origin. The local API endpoint is not exposed by the blockchain.
