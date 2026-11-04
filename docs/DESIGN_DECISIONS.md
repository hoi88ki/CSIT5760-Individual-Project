# TradeChain — Design Decisions

This log records the significant design choices and their rationale. Decisions marked
**[Qn]** were confirmed by the reviewer's answers in `QUESTIONS.md`.

| # | Decision | Alternative considered | Rationale |
|---|----------|------------------------|-----------|
| D1 | **Buyer opens an Order, then the Seller creates the Shipment** (`createOrder` → `createShipment`) **[Q1]** | Seller creates the shipment directly and the Buyer is inferred from `openLetterOfCredit` | The reviewer required the Buyer to create the order first; the named exporter then accepts it, which also fixes the counterparties up front and prevents an open-order race. |
| D2 | **Settlement in an ERC-20 stablecoin** (injected token, `SafeERC20`) **[Q8]** | Native ETH | Matches real fiat-denominated L/Cs; avoids ETH price risk; `SafeERC20` handles non-standard tokens. Native ETH is no longer used. |
| D3 | **Single 100 % atomic payout** at the risk-transfer milestone **[Q9]** | Instalments / partial draws | Explicitly in scope; keeps the state machine and CEI simple. |
| D4 | **Insurance module omitted** **[Q2]** | Implement premium escrow + damage claims from the diagram | The reviewer judged the diagram's insurance flow out of scope and not "latest"; removing it keeps the core settlement focused. |
| D5 | **Customs duty is optional and may be zero** **[Q3][Q11]** | Require a non-zero quoted duty | Many destinations are duty-free; `payCustomsDuty(id, 0)` still records the clearance step while moving no funds. |
| D6 | **`DocType` order & anchor authority** **[Q4]** | Original ordering | Adopted the reviewer's table: CoO is Seller-issued (no NFT); Inspection/Insurance/Clearance are Verifier-issued and mint `TradeCertNFT`; the B/L (or AWB) is anchored by the Carrier at loading. |
| D7 | **`reclaimExpiredLC` restricted to Buyer / issuing bank / admin** **[Q10]** | Permissionless | Prevents third-party griefing while keeping a neutral fallback if the Buyer is unavailable. |
| D8 | **Either bank may `forceFinalizeDelivery`** independently **[Q6]** | Require both banks | A single stalled bank cannot withhold the Seller's payout. |
| D9 | **Local IPFS (kubo)** **[Q12]** | Pinata (hosted) | The reviewer wants to verify content locally; `scripts/ipfs-add.js` returns a CIDv1, and only CIDs reach the chain. |
| D10 | **No encryption of off-chain docs** **[Q13]** | Encrypt before pinning | The reviewer accepts restricted local access for this prototype. |
| D11 | **eB/L escrow**: minted to the core at shipment creation; `tokenURI` set at loading; transferred to the Buyer at delivery | Mint at loading | One token per shipment avoids the need for token-id bookkeeping across terms, and EXW can settle before a B/L exists. |
| D12 | **`nonReentrant` on the internal payout** **[Q19]** | Guard only external entry points | The guard belongs where value leaves the contract; external callers are additionally protected by phase checks. |
| D13 | **`Phase` enum name** | `ShipmentState` (proposal) | The proposal used `ShipmentState` for both the storage-base contract and the enum; renaming the enum keeps the code compilable. |
| D14 | **One storage base, no proxies** | Upgradeable/diamond | Matches the proposal's exclusion of proxy patterns and keeps a single auditable layout. |
| D15 | **Documented "objective completion" for force-finalize** = `LoadedOnVessel` + full delivery document set anchored (+ duty for DDP) **[Q6]** | Require physical proof of delivery | Final delivery is subjective; anchoring the complete document set is the strongest objective signal available on-chain. |

## Consequences / trade-offs

- **Trusted verifier.** Verifiers are trusted to have checked the off-chain content before
  anchoring/minting (trusted-oracle model), as stated in the proposal.
- **Stablecoin dependency.** The core trusts the injected ERC-20; a malicious token could
  re-enter (mitigated by `nonReentrant`) or censor transfers. Deployments should use a reputable
  stablecoin.
- **No partial settlement.** A single full payout means the contract cannot model retention or
  discrepancy fees; acceptable for the scope.
- **Same-block deadline edge.** `createOrder` requires `deadline > block.timestamp`; the Seller
  must accept before the deadline (checked again in `createShipment`).
