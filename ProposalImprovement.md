# Proposal Improvement Log — `TradeChain`

This file records issues, ambiguities, inconsistencies and improvement opportunities identified
in the original project proposal **while implementing it**. Each entry gives the issue, its
impact, and the resolution adopted (or the question raised). Items are grouped by severity.

- Proposal source: `CSIT5760_Project_Proposal_21232072.docx`
- Author: YUNG HOI KI (21232072)
- Status legend: ✅ resolved in code · 📝 documented assumption · ❓ open question

---

## A. Inconsistencies between the written scope and the workflow diagram

| # | Issue | Impact | Resolution / status |
|---|-------|--------|---------------------|
| A1 | The workflow diagram shows `fileDamageClaim(evidenceCID)` and `resolveInsuranceClaim()` and states the escrow locks *"100% L/C ETH **+ Insurance Premium**"*. Neither the insurance premium nor the damage-claim functions appear in §4 *Principal functions* or in any objective. | Scope creep; the "escrow amount" semantics of `openLetterOfCredit` are ambiguous. | ❌ **Removed from scope** — the reviewer confirmed the insurance module is not required (Q2). The escrow now holds only the L/C (ERC-20). |
| A2 | The diagram calls `clearCustoms()`, but §4 lists only `anchorDocument(…, CustomsClearance)` + `payCustomsDuty()`. | Function-name / responsibility mismatch. | ✅ Treated `clearCustoms` as `anchorDocument(id, CustomsClearance, cid)` performed by the Verifier (customs officer). |
| A3 | The diagram shows a **Bill of Lading *or* Air Waybill**; §4 lists a single "Bill of Lading". | Multi-modal shipments are not modelled. | 📝 Kepler single `DocType.BillOfLading` whose CID may point to a B/L or an AWB; documented in `docs/DESIGN_DECISIONS.md`. |
| A4 | The diagram shows distinct actors (Insurer, Inspector, Customs/Police) that would need separate wallets, but §4 *Exclusions* says the demo uses **one shared verifier** among six wallets. | Actor model inconsistency. | ✅ The single `ROLE_VERIFIER` anchors all four verifier-type documents (CoO, Inspection, Insurance, Clearance), matching the "six wallets" scope. |
| A5 | Diagram step 4 says `confirmPickup()` *"Verifies Packing List CID"*, but §5 says the packing list is anchored at `createShipment`. | Timing of packing-list verification unclear. | ✅ Packing list anchored at `createShipment`; `confirmPickup` **requires** it to be present and valid. |

## B. Smart-contract interface gaps

| # | Issue | Impact | Resolution / status |
|---|-------|--------|---------------------|
| B1 | `createShipment(term, lcAmount, deadline, invoiceCID, packingListCID)` has **no `buyer` argument**, so it is unspecified how the Buyer is determined. | Cannot wire the Buyer to the shipment. | ✅ Resolved per the reviewer (Q1): the **Buyer opens an `Order`** (`createOrder`) and the **named Seller creates the Shipment** from it (`createShipment(orderId, …)`); the Buyer is fixed at order time. |
| B2 | `openLetterOfCredit(id){value}` escrows only the L/C amount, but the diagram adds an insurance premium to escrow. | Ambiguous escrow target. | ❌ N/A — the insurance premium was removed from scope (Q2). |
| B3 | `payCustomsDuty(id)` has **no amount parameter and no duty quote**, so the expected duty is unspecified. | The DDP clearance gate can be satisfied with an arbitrary amount (e.g. 1 wei). | ✅ Now `payCustomsDuty(id, amount)` and **zero duty is accepted** for duty-free destinations (Q3/Q11); a quoted-duty improvement is proposed below (B3-improvement). |
| B4 | `anchorDocument(id, DocType, cid)` is described as covering CoO / Inspection / Insurance / Clearance, yet OBJ-1 claims an IPFS registry of **7 DocTypes**. | Unclear whether all 7 are anchorable through it. | ✅ Registry stores all 7; `anchorDocument()` handles **CoO (Seller) + the 3 verifier types**, while invoice/packing are set at `createShipment` and the B/L/AWB at `confirmVesselLoading` (Q4). |
| B5 | It is not specified **who may revoke** a `TradeCertNFT` ("revocation = burn"). | Access-control gap on a security-relevant action. | ✅ `revokeCertificate(id, DocType)` is callable by the original issuer (that `DocType`'s authorised role) or the admin. |
| B6 | "Either-bank `forceFinalizeDelivery` once all **objective** milestones are complete" — "objective completion" is undefined, and final delivery is inherently physical/subjective. | Neutrality guarantee cannot be implemented precisely. | ✅ Defined "objective completion" = `LoadedOnVessel` reached **and** the full delivery document set anchored (**+** duty paid for DDP). Either bank may call independently. ❓ |
| B7 | `reclaimExpiredLC` does not state which states permit reclaim (e.g. after pickup but before loading). | Could let parties claw back funds after risk transferred. | ✅ Restricted to `LCFunded` (Seller never shipped) only; after any milestone the payout path takes over. |
| B8 | `deadline` units are unspecified (timestamp vs block number vs calendar date). | Timeout logic ambiguous. | ✅ Unix timestamp (`uint64`), compared with `block.timestamp`. |
| B9 | The eB/L mint timing is ambiguous: title is "escrowed by the core until settlement", yet loading "anchors the B/L and updates `EBLToken.tokenURI`". | Cannot mint and set URI cleanly. | ✅ Mint the `EBLToken` to the core at `createShipment`; set its `tokenURI` at `confirmVesselLoading`; transfer to Buyer at final delivery. |

## C. Naming / modelling issues

| # | Issue | Impact | Resolution / status |
|---|-------|--------|---------------------|
| C1 | §5 names the component **`ShipmentState` (storage base)** *and* a **`ShipmentState` enum** — the same identifier for a contract and an enum. | The proposed code as written cannot compile. | ✅ The storage-base contract is `ShipmentState`; the lifecycle enum is named **`Phase`** (documented deviation). |
| C2 | `Incoterm`/`DocType`/state names appear without a canonical source file. | Modular boundaries are unclear. | ✅ Enums live in `ShipmentState.sol` and are inherited by every module. |
| C3 | "O(1) gas per upload" for a CID string is inaccurate — storing a string is proportional to its byte length (a CID is ~46–59 bytes). | Slightly misleading performance claim. | 📝 Reworded as "constant-bounded / one storage slot-set per document"; the point (independent of document size) still holds. |

## D. Evaluation / methodology issues

| # | Issue | Impact | Resolution / status |
|---|-------|--------|---------------------|
| D1 | "≥90 % **statement/branch** coverage" — `solidity-coverage` reports lines, statements, branches and functions; the criterion does not name which is authoritative. | Success criterion ambiguity. | 📝 Target **all four ≥ 90 %**, with branches prioritised. |
| D2 | "no High/Medium Slither findings" — Slither severity is heuristic and depends on the detector set/version. | Reproducibility. | ✅ Pinned Slither config (`slither.config.json`) and CI fails only on **High** (documented), reporting Medium for manual triage. |
| D3 | The workflow diagram's "100% Atomic L/C Payout" is a single ETH transfer, but real L/Cs settle in fiat and may be partial. | Scope/realism. | ✅ Adopted an **ERC-20 stablecoin** settlement token (Q8) with a single 100 % payout (Q9); a 6-decimal `MockERC20` is used on test networks. |
| D4 | References [5] and [7] are duplicates (same Slither paper). | Reference hygiene. | 📝 Noted; deduplicate in the final report. |

## E. Process / logistics issues

| # | Issue | Impact | Resolution / status |
|---|-------|--------|---------------------|
| E1 | The proposal's submission date is **6 Nov 2026**, but the work plan's Phase 1 starts **9 Nov 2026** (after submission). | No slack before the plan starts. | 📝 Work was started early (this repository predates Phase 1). |
| E2 | Repository URL in the proposal is `…/CSIT5760-Individual-Project`, while the local project folder is `CSIT5760/Project`. | Mismatch between declared URL and workspace. | ❓ Confirm the final repository name/URL before submission. |
| E3 | The security table's "Validation method" claims `slither --detect reentrancy-eth clean`, but no `.solhint`/Slither config or CI was specified as a deliverable in the work plan. | Missing concrete artifacts. | ✅ Added `slither.config.json`, `.solhint.json`, and `.github/workflows/ci.yml`. |

---

## F. Reviewer-driven changes (from `QUESTIONS.md` answers)

The following changes were made specifically in response to the reviewer's answers. They
supersede the original proposal text where they conflict.

| Q | Change applied |
|---|----------------|
| Q1 | Added an **`Order`** stage: the **Buyer** calls `createOrder(seller, term, lcAmount, deadline)`; the named **Seller** calls `createShipment(orderId, invoiceCID, packingListCID)`. The Buyer is fixed at order creation, removing the ambiguity in B1. |
| Q2 | **Removed the insurance module** (premium escrow, `fileDamageClaim`, `resolveInsuranceClaim`). |
| Q3, Q11 | `payCustomsDuty(id, amount)` now **accepts zero duty** for duty-free destinations; duty remains an escrowed step for DDP. |
| Q4 | Adopted the reviewer's `DocType` table and order (CoO = Seller, no NFT; Inspection/Insurance/Clearance = Verifier + NFT; B/L/AWB = Carrier). |
| Q8 | Switched settlement from **native ETH** to an **ERC-20 stablecoin** (`SafeERC20`; `MockERC20` for demos). |
| Q10 | `reclaimExpiredLC` is now restricted to the **Buyer, issuing bank or admin** (no longer permissionless). |
| Q12 | Switched IPFS tooling from Pinata to a **local kubo node** (`scripts/ipfs-add.js`). |
| Q13 | **No document encryption**; local/restricted access only. |
| Q18 | Delivered a **working (simple) dashboard** (`dapp/`) that runs without a build step. |
| Q20 | Repository name/URL to be updated by the author later. |

---

## Proposed improvements (not required, recommended)

1. **B3-improvement — quoted duty.** Let the Verifier anchor the `CustomsClearance` document
   together with a signed duty quote, and require `msg.value == quotedDuty` on
   `payCustomsDuty`. Removes the "1 wei satisfies the gate" weakness.
2. **Pull-payment option.** Use a withdraw-pattern escrow instead of `call` to avoid griefing by
   a payee contract that reverts on receive (currently a reverted transfer rolls back the whole
   transaction, which is safe but can strand settlement if the Seller's wallet is a hostile
   contract).
3. **Multi-signature banks.** Model each bank as an m-of-n multisig for force-finalize.
4. **Document hash-pinning.** Store `keccak256(cid)` as well as the CID to make the on-chain
   anchor resilient to metadata tampering and to enable cheap equality checks.
5. **ERC-20 settlement token.** Implement the stretch goal with OZ `SafeERC20` and a mock stable
   coin so the demo reflects fiat-denominated L/Cs.

---

_Last updated: 2026-11-05 (initial implementation pass)._

---

## G. Update for the revised proposal (7-contract restructure)

The proposal was rewritten (`CSIT5760_Project_Proposal_21232072.docx`) with a seven-contract design.
A second review produced `docs/PROPOSAL_UPDATES.md`, which lists the exact proposal locations to edit
and the suggested wording (feedback items A.1–C.15). Resolutions adopted in code:

| Item | Resolution |
|------|------------|
| A.1 | e-B/L **document-of-title** NFT, escrowed by the core and transferred at the Incoterm-correct milestone (not a free "ownership" token). |
| A.2 | **Dispute module omitted** (out of scope; reclaim + force-finalize remain). |
| A.3 | **Verifier / Authorities** added as an authorised address; certificate content on IPFS. |
| A.4 | **Per-Incoterm/phase** required-document set (`ComplianceEngine`). |
| A.5 | L/C roles clarified: importer funds the escrow, bank validates + force-finalizes. |
| A.6 | `TradeUSD` minting is **`MINTER_ROLE`-gated**. |
| B.7 | **`Pausable` removed.** |
| B.8 | **Local kubo IPFS** is the default (Pinata optional). |
| B.9 | Wording: **tamper-evident, append-only anchors + verifier-controlled revocation**. |
| B.10 | Reentrancy mitigation documented to include **ERC-721 receiver hooks**. |
| B.11 | Bar kept high (**≥ 90 %** coverage; 0 High Slither). |

See `docs/DESIGN_DECISIONS.md` (D1–D18) and `docs/REFACTOR_PLAN.md`.
