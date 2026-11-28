# TradeChain — Design Decisions

Records the significant design choices and their rationale. Items marked **[Qn]** are earlier
design-review questions; items marked **[Pn]** respond to the proposal feedback in
`docs/PROPOSAL_UPDATES.md`.

| # | Decision | Alternative | Rationale |
|---|----------|-------------|-----------|
| D1 | **Six modular contracts + one type library** [P1] | One composed contract / diamond | Keeps one storage owner per concern while the shipment record and its title token share one aggregate. |
| D2 | **Core is the only user entry point; companion writes use core-held controller roles** | Users call modules directly | Single core address and role authority; the core administers module roles with `setModuleRole`, while modules expose public views. |
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
| D15 | **Per-role IPFS: one kubo node per participant** [P8] | Single shared node; Pinata | Each role keeps its own copy and any involved party can read a document by CID through the console; content addressing keeps **one CID per `(shipment, DocType)`**. `scripts/ipfs-pin.js` keeps extra copies; Pinata stays optional. See `docs/IPFS_CONSORTIUM.md`. |
| D16 | **Settlement token injected; core deploys the four on-chain companions** | Core deploys the token too | Keeps the token swappable (any stablecoin) and the constructor affordable under coverage. |
| D17 | **`nonReentrant` on the internal settlement/refund** [Q19] | Guard external entry points only | The guard belongs where value leaves the contract; external callers are also protected by phase checks. |
| D18 | **Tamper-evident anchors + revocable verification** [P9] *(refined by D29)* | Strict immutability | A **live** anchor is immutable — anchoring over it reverts; certificates can be withdrawn and become invalid at examination. Corrections are not silent: they go through the role-gated, event-logged paths of D29. |
| D19 | **`ShipmentNFT` merged into `ShipmentTracker`** | Separate ERC-721 contract | The shipment record and its title share one identity (`tokenId == shipmentId`); merging removes duplicated existence checks and lets `_update` close the ERC-721 transfer surface (the separate token left `transferFrom` open, contradicting the restricted-title design). |
| D20 | **Module access control mounted on `TradeChainCore`** | Each module hard-codes `msg.sender == core` | Every companion grants its `DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE` to the core at construction; the core administers them via `setModuleRole`. One authority, and a module writer can be revoked without redeploying. |
| D21 | **Swappable `DocumentRegistry`** | Hard-wired registry address | The admin or `ROLE_REGISTRY_ADMIN` can replace the registry. Two guards keep it safe: the replacement must be bound to this core and its runtime code must match the deployment-time registry (a look-alike could otherwise forge `isValid`). Anchors snapshot their registry, so a swap never orphans in-flight documents. |
| D22 | **Bank-issued documentary credit: the bank issues and prefunds the escrow; the importer only applies** [credit rework] | Importer-funded escrow (the old `openLetterOfCredit`) | A documentary credit is the bank's undertaking, not a buyer escrow. `createOrder` records the application (beneficiary, Incoterm, sight/deferred terms); `issueLetterOfCredit(orderId)` is bank-only and pulls the credit amount from the bank, so honor is deterministic. The importer never funds the *escrow* — it settles its debt to the bank afterwards (D28). |
| D23 | **One id per trade: the order/application and its trade record are born together** (`orderId == shipmentId == tokenId`) | Keep separate order and shipment ids; issue the credit against the order id | The credit must exist before the goods do, so the application opens the trade record in `OrderPlaced` and the exporter's `ship` merely advances it. One id keeps the L/C, the compliance checks, the title token and the UI aligned. |
| D24 | **Two state dimensions: credit `Phase` × goods `Custody`** | Single linear phase (the old design paid at Incoterm milestones) | Payment follows the credit (presented → honored → paid), custody follows the goods (pickup → vessel → delivery), and they converge on `Settled` only when both are complete. Risk transfer stays Incoterm-based (EXW pickup, FOB/CIF vessel, DDP delivery) but never triggers payment. |
| D25 | **Presentation + bank examination instead of milestone payout** [credit rework] | Pay at the risk-transfer milestone | The exporter records a presentation of the stipulated documents (`presentDocuments`, compliance-checked and pre-expiry); the bank examines (`honorPresentation`, re-checked inside the module) and honors: sight pays immediately, deferred schedules `maturityAt = honoredAt + deferral`, drawn permissionlessly. |
| D26 | **The stipulated documentary set is the Incoterm's full requirement** (`presentationMask`) | Let the bank supply an arbitrary document list at issuance | The set is derived from the same `ComplianceEngine` rules that gate custody, so the credit's terms and the on-chain examination can never drift apart; it is recorded on the L/C for transparency. |
| D27 | **Expired, unused credits return to the issuing bank** [credit rework] | Refund the importer | The importer never funded the escrow. `reclaimExpiredLC` refunds the bank; if the beneficiary had shipped but never presented, the escrowed title returns to the exporter with the goods. A presented credit is "used": it can only be honored, never reclaimed. |
| D28 | **The applicant's reimbursement is an on-chain, pull-based settlement step** [credit rework] | Treat reimbursement as an off-chain arrangement between importer and bank | `reimburseIssuingBank(orderId)` (the trade's importer only) pulls `lc.amount` TradeUSD from the importer **straight to the issuing bank** once the proceeds have been released (sight: at honor; deferred: at maturity) — the moment the bank is actually out of pocket — and records `reimbursed` on the credit. Enforcement of a non-paying applicant stays legal/off-chain, as with real L/Cs, but the settlement event is provable on-chain. |
| D29 | **Authorized document replacement: a live anchor is locked, corrections are role-gated and event-logged** *(supersedes the strict one-shot anchor of D18)* | Permanent one-shot anchors (a single revoke could freeze a trade forever) | Anchoring over a **live** anchor reverts (`DocumentLocked`); a **revoked** slot is re-opened for a replacement anchor. `replaceDocument(id, docType, cid)` lets the designated role for the `DocType`, the original issuer, or the admin swap **any** document — including the invoice, packing list and B/L anchored by a milestone — while the trade is open, and re-verifies the slot. The previous CID stays in `DocumentReplaced`, so corrections are auditable, not silent; a B/L replacement also updates the title URI. |
| D30 | **The trade settles only when the proceeds are released; closed trades are final** | Mark `Settled` at honor + delivered (the earlier behavior) | A deferred credit honored after delivery was marked `Settled` before its proceeds were drawn, which made `drawDeferredPayment` unreachable and stranded the escrow. `honorPresentation` now keeps such a trade in `Honored` until `drawDeferredPayment` pays it. Symmetrically, anchoring, replacement and revocation all revert on a settled/reclaimed trade, so a closed trade's document record cannot be rewritten. |

## Consequences / trade-offs

- **Trusted verifier and trusted examiner.** Verifiers are trusted to have validated the off-chain
  content before anchoring (trusted-oracle model); the bank is trusted to examine documents in the
  real (legal) sense — the chain only proves the stipulated slots are anchored and currently valid.
- **Stablecoin dependency.** The core trusts the injected ERC-20; a malicious token is contained by
  `nonReentrant`/CEI but could censor transfers.
- **One bank role.** The demo collapses issuing/advising into a single `ROLE_BANK`; production would
  separate them (and could use multisigs).
- **Certificate of origin by the exporter.** A simplification; in practice a chamber of commerce or
  authority issues it.
- **Same-block deadline edge.** `createOrder` requires `deadline > block.timestamp`; the beneficiary
  must ship and present before the deadline (both re-checked on-chain).
- **Authorized replacement widens the trusted surface.** Since D29, a compromised issuer or
  designated role could rewrite a document CID. This is consistent with the trusted-oracle model
  (the same accounts could have anchored false content in the first place) and every change is
  event-logged with the previous CID — but it is a change the older one-shot design prevented;
  production deployments should put the role accounts behind multisigs.
- **D3 superseded.** "Buyer opens an Order, then the Seller creates the Shipment" still holds, but
  the shipment record now opens with the order (D23) and shipping additionally requires an issued
  credit (D22).
