# TradeChain — Design Decisions

Records the significant design choices and their rationale. Items marked **[Qn]** are earlier
design-review questions; items marked **[Pn]** respond to the proposal feedback in
`docs/PROPOSAL_UPDATES.md`. The change history is in `CHANGES.md`.

| # | Decision | Alternative | Rationale |
|---|----------|-------------|-----------|
| D1 | **Six modular contracts + one type library** [P1] | One composed contract / diamond | Keeps one storage owner per concern while the shipment record and its title token share one aggregate. |
| D2 | **Core is the only user entry point; companion writes use core-held controller roles** | Users call modules directly | Single DApp address and role authority; the core administers module roles with `setModuleRole`, while modules expose public views. |
| D3 | **Buyer opens an Order, then the Seller creates the Shipment** [Q1] | Seller creates the shipment directly | Fixes the counterparties up front. |
| D4 | **Settlement in an ERC-20 stablecoin (`TradeUSD`)** [Q8] | Native ETH | Matches fiat-denominated L/Cs; `SafeERC20` handles non-standard tokens. |
| D5 | **Single 100 % atomic payout** [Q9] | Instalments | Keeps the state machine and CEI simple. |
| D6 | **`TradeUSD` minting is role-gated** [P6] | Open `mint` (the old mock) | An open mint is a critical vulnerability if the token backs escrow. |
| D7 | **No certificate NFT** [P1] | Keep `TradeCertNFT` | The proposal has no certificate token; verification status lives in `DocumentRegistry` and is revocable. |
| D8 | **e-B/L document of title as an ERC-721 inside `ShipmentTracker`, escrowed by the core** [P1] | Freely transferable "ownership" NFT | In trade, the B/L is a document of **title**; `_update` rejects public transfers, so only the core can release it to the importer at final delivery. Payout/risk transfer follows the Incoterm and can happen earlier. |
| D9 | **Per-Incoterm/phase required documents** [P4] | Fixed set of six | CIF needs insurance, FOB needs the B/L, EXW needs neither, DDP needs clearance + duty. |
| D10 | **Customs duty optional and may be zero** [Q3][Q11] | Require a non-zero quoted duty | Many destinations are duty-free; escrowed duty is forwarded to a treasury or refunded on reclaim. |
| D11 | **`reclaimExpiredLC` restricted to importer / bank / admin** [Q10] | Permissionless | Prevents third-party griefing while keeping a neutral fallback. |
| D12 | **Either bank may `forceFinalizeDelivery`** [Q6] | Require both banks | A single stalled bank cannot withhold the exporter's payout. |
| D13 | **No dispute module** [P2] | Bonded arbitration | A dispute function is a DoS/griefing surface and was judged out of scope; reclaim + force-finalize already protect stakeholders. |
| D14 | **No `Pausable`** [P7] | Admin circuit breaker | A pause can *cause* the settlement stall the design prevents; settlement safety relies on `nonReentrant` + CEI + enum guards. |
| D15 | **Per-role IPFS: one kubo node per participant** [P8] | Single shared node; Pinata | Each role keeps its own copy and any involved party can read a document by CID through the DApp; content addressing keeps **one CID per `(shipment, DocType)`**. `scripts/ipfs-pin.js` keeps extra copies; Pinata stays optional. See `docs/IPFS_CONSORTIUM.md`. |
| D16 | **Settlement token injected; core deploys the four on-chain companions** | Core deploys the token too | Keeps the token swappable (any stablecoin) and the constructor affordable under coverage. |
| D17 | **`nonReentrant` on the internal settlement/refund** [Q19] | Guard external entry points only | The guard belongs where value leaves the contract; external callers are also protected by phase checks. |
| D18 | **Tamper-evident "locked" anchors + revocable verification** [P9] | Strict immutability | A CID can never be silently replaced; certificates can be withdrawn and become invalid at payout. |
| D19 | **`ShipmentNFT` merged into `ShipmentTracker`** | Separate ERC-721 contract | The shipment record and its title share one identity (`tokenId == shipmentId`); merging removes duplicated existence checks and lets `_update` close the ERC-721 transfer surface (the separate token left `transferFrom` open, contradicting the restricted-title design). |
| D20 | **Module access control mounted on `TradeChainCore`** | Each module hard-codes `msg.sender == core` | Every companion grants its `DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE` to the core at construction; the core administers them via `setModuleRole`. One authority, and a module writer can be revoked without redeploying. |
| D21 | **Swappable `DocumentRegistry`** | Hard-wired registry address | The admin or `ROLE_REGISTRY_ADMIN` can replace the registry. Two guards keep it safe: the replacement must be bound to this core and its runtime code must match the deployment-time registry (a look-alike could otherwise forge `isValid`). Anchors snapshot their registry, so a swap never orphans in-flight documents. |

## Consequences / trade-offs

- **Trusted verifier.** Verifiers are trusted to have validated the off-chain content before
  anchoring (trusted-oracle model).
- **Stablecoin dependency.** The core trusts the injected ERC-20; a malicious token is contained by
  `nonReentrant`/CEI but could censor transfers.
- **One bank role.** The demo collapses issuing/advising into a single `ROLE_BANK`; production would
  separate them (and could use multisigs).
- **Certificate of origin by the exporter.** A simplification; in practice a chamber of commerce or
  authority issues it.
- **Same-block deadline edge.** `createOrder` requires `deadline > block.timestamp`; the exporter
  must accept before the deadline (re-checked in `createShipment`).
