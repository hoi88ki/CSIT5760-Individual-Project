# Proposal update guide — TradeChain (CSIT5760_Project_Proposal_21232072.docx)

This maps every feedback item (A.1–C.15) to the **exact place in the proposal** and the suggested
replacement text. It is written so you can apply the edits directly in Word.

Legend: **[§n]** = proposal section number · **→** = suggested wording.

---

## A. Domain / business-logic

### A.1 — "Shipment ownership" NFT conflates title / property / risk  *(point out the update needed)*
**Where:** §4 *Core Smart Contract Functions*, bullet **"Shipment Tracking and Ownership Management"**; and §5 table row **`ShipmentTracker.sol`** (the e-B/L token is merged into `ShipmentTracker`; see the merge section below).
**Current:** "represent shipment ownership through transferable NFTs" / "ERC-721 token representing shipment ownership, supporting minting and ownership transfer."
**Change to:** frame it as an **electronic Bill of Lading / document-of-title NFT**, *not* plain ownership.
> "Represent the negotiable document of title (the e-B/L) as an ERC-721 token. It is minted to, and escrowed by, `TradeChainCore`; its metadata is set when the B/L/AWB is anchored; and it is transferred to the importer at the settlement milestone. Transfer is gated by the contract according to the selected Incoterm and the shipment phase (not freely transferable)."

Add one clarifying sentence: *risk* is tracked separately (`riskHolder`, Incoterm-based) and *property/ownership* follows the sale contract, so the three concepts are not conflated.

### A.2 — Dispute resolution is under-specified / griefing risk  *(omit it)*
**Where:** §4 *Core Smart Contract Functions*, bullet **"Dispute Resolution"**; §4 *On-Chain Data* list item **"Dispute records"**; §5 `LetterOfCredit.sol` row (remove any dispute wording).
**Change:** **delete** the "Dispute Resolution" bullet and the "Dispute records" item. Keep `LetterOfCredit` as *"creation, funding, escrow, settlement, and expiry refund (cancellation)"*.
> Rationale to cite if asked: a bonded, arbitrated, time-bounded dispute mechanism was judged out of scope for this prototype; the neutrality safeguards (deadline reclaim + either-bank force-finalize) already protect against stalling.

### A.3 — Role model is missing the verifier / authorities  *(authorised address + IPFS)*
**Where:** §4 *"User Roles and Permissions"* (add a bullet after **Logistics Provider**).
**Change:** add:
> **Verifier / Authorities** — an **authorised blockchain address** (inspection body, insurer, customs) that anchors a certificate on-chain; the certificate **content is stored on IPFS** and referenced by its CID, and is tagged with the same shipment so it can be retrieved and audited later.

Also add a phrase to §5 `DocumentRegistry.sol`: "per `DocType`, records the CID, issuer, timestamp and verification status."

### A.4 — Fixed "six required documents" conflicts with the Incoterms  *(fix per Incoterm)*
**Where:** §4 bullet **"Document Compliance Verification"**; §5 row **`ComplianceEngine.sol`**.
**Current:** "checks the completeness of six required trade documents before approval" / "checks the completeness of six required trade documents".
**Change to:** treat the six as the *universe*; the **mandatory set is a function of the Incoterm and the milestone**:
> "The seven document types form the universe; the set that must be present before a milestone/payout is derived from the Incoterm and the phase — e.g. **CIF** additionally requires the Insurance Certificate, **FOB** requires the B/L and an inspection certificate, **EXW** requires neither insurance nor an inspection certificate, and **DDP** requires the Certificate of Origin and Customs Clearance (plus duty paid)."

### A.5 — Letter-of-Credit realism  *(fix)*
**Where:** §4 bullet **"Letter of Credit Management"**; §5 row **`LetterOfCredit.sol`**.
**Change to:** state who does what:
> "The **importer** funds the L/C escrow in `TradeUSD`; the **bank** role validates the documentary presentation and may **force-finalize** a stalled shipment once the objective milestones are complete; settlement is a single atomic payout to the exporter at the Incoterm risk-transfer milestone, and the escrow is refunded to the importer if the exporter never ships before the deadline."

### A.6 — `TradeUSD` open minting  *(fix)*
**Where:** §5 row **`TradeUSD.sol`**.
**Change to:** "ERC-20 stablecoin with **role-gated minting** (`MINTER_ROLE`; only the admin/deployer and the core may mint). Used for the L/C escrow and customs duty."

---

## B. Security & architecture

### B.7 — `Pausable` conflict  *(remove if needed → removed)*
**Where:** §7 Security Considerations, last row mitigation list (the "Malicious receiver hooks …" row).
**Change:** delete "**Pausable circuit breakers**" from the mitigation list (the prototype relies on `nonReentrant` + CEI + enum state guards; a pausable admin could instead *cause* a settlement stall).

### B.8 — IPFS topology  *(one node per role)*
**Where:** §6 Technology Stack, row **"IPFS …"**; the **React (Vite)** row; §4 *Trade Document Management*; §5 `DocumentRegistry.sol`; §9 Phase 3.
**Change to:** replace the single-node / Pinata wording with a **per-role** model:
> "**IPFS — one node per role.** Each participant (exporter, importer, bank, logistics, verifier) runs its own kubo node and keeps its own copy. The issuing role adds the document to its own node; the on-chain record stores only the **CID** (one CID per `(shipment, DocType)`). Any involved party can read the document by its CID through the DApp; because CIDs are content-addressed, integrity is guaranteed regardless of which node responds, and *no per-role on-chain records are needed*."

**Confirmed design (see [`IPFS_CONSORTIUM.md`](./IPFS_CONSORTIUM.md)):**
- **Each role keeps its own copy.** Each role runs its own kubo node; a counterparty that needs a
  document can pull it onto its own node with `ipfs pin add <cid>` (helper: `scripts/ipfs-pin.js`).
- **Access is through the DApp.** Any involved party reads a document by its CID by pointing the
  DApp's *Document viewer* at the node that holds a copy.
- **Confidentiality is out of scope.** CIDs are public on-chain; the model gives consortium retrieval
  by convention, not cryptographic secrecy. Restricting the swarm or encrypting is optional.
- **Availability** depends on a copy existing somewhere — a CID whose only holder is offline (and
  that no counterparty copied) cannot be fetched.
- **Pinata is optional** (single hosted provider); it is not part of this model.
- **No contract change is required** — the contracts store only CIDs and are agnostic to the topology.

**Other values confirmed with the author:** the proposal should state **≥ 90 % statement/branch
coverage with 0 High Slither findings** (Medium triaged), and **seven** document types including
**Customs Clearance**.

### B.9 — "Immutable" vs revocation  *(see how the proposal was updated)*
> Note: this item is about on-chain **wording** (immutability vs revocation), not IPFS. It pairs
> with B.8 but does not affect the storage topology.
**Where:** §3 OBJ-1; §4 *On-Chain Data* list (first item); §5 `DocumentRegistry.sol`.
**Change to:** replace "immutable on-chain records" with:
> "**tamper-evident, append-only** anchors (a document CID can never be silently replaced — an already-anchored slot is locked), with **verifier-controlled revocation** for certificates so a withdrawn attestation is immediately visible on-chain."

### B.10 — Reentrancy wording  *(fix)*
**Where:** §7 Security Considerations, row **"Smart Contract Vulnerabilities (Reentrancy, Unchecked Calls & State Bypass)"**.
**Change:** add the NFT receiver hook to the attack surface and the mitigation:
> "…malicious ERC-20 hooks (`_update`/transfer callbacks) **and ERC-721 receiver hooks (`onERC721Received`)** could trigger reentrancy… Mitigations: OpenZeppelin `ReentrancyGuard` (`nonReentrant`) on the escrow settlement function, strict **checks-effects-interactions** ordering (state is finalised before any external transfer), `SafeERC20`, and strict enum state guards with `AccessControl`."

### B.11 — Metric consistency  *(a considerably high bar is enough)*
**Where:** §7 last row; §8 Testing Plan; §9 Work Plan Phase 2.
**Change to:** align on one clearly-high bar:
> "**0 High-severity Slither findings** (Medium findings are reported and triaged manually), **≥ 90 % statement and branch coverage**." (The repo reaches 100 % statements / **93.08 % branch**.)

---

## C. Methodology / process

### C.12 — Objectives not measurable  *(suggest change)*
**Where:** §3 Project Objectives table.
**Suggested replacements (keep the same IDs):**
- **OBJ-1** — "Implement the document registry and e-B/L token." *Success:* "Each of the seven document types is anchored by its designated role; an anchored CID cannot be replaced; unauthorised anchors revert; the e-B/L token transfers to the importer only at the Incoterm-correct milestone."
- **OBJ-2** — "Implement role-based access control." *Success:* "Every privileged function reverts with `AccessControlUnauthorizedAccount`/`Unauthorized` for accounts lacking the required role; an access-control matrix test passes."
- **OBJ-3** — "Implement Incoterm-aware shipment tracking and settlement." *Success:* "All four Incoterms (EXW/FOB/CIF/DDP) settle at the correct risk-transfer milestone; DDP blocks until customs clearance and duty are complete; the required-document set is validated per Incoterm."
- **OBJ-4** — "Deploy, test and verify on Sepolia." *Success:* "All six contracts verified on Etherscan; ≥ 90 % statement/branch coverage; 0 High Slither findings; all positive/negative/boundary tests passing."

### C.13 — Timeline  *(ignore — noted)*
No change.

### C.14 / C.15 — Page budget & reference hygiene  *(noted)*
Optional: trim §2 and the bullet lists to fit "2–3 pages excluding references"; references are already duplicate-free.

---

## Also update §5.1 "Architecture or Workflow"

The section now holds the **Architecture** diagram from
[`docs/diagrams/TradeChain.drawio`](./diagrams/TradeChain.drawio) (exported to
`TradeChain-Architecture.png`). The **Workflow** diagram is intentionally deferred to the final
report.

## Reference implementation status

The accompanying implementation already applies A.1–A.6, B.7, B.8, B.10 and B.11:
six contracts (`TradeChainCore`, `LetterOfCredit`, `ShipmentTracker`, `ComplianceEngine`,
`DocumentRegistry`, `TradeUSD`), role-gated minting, per-Incoterm compliance, milestone-gated title
transfer, consortium (per-role) IPFS, and no dispute module / no `Pausable`. The e-B/L ERC-721
document of title is **inside `ShipmentTracker`** (`tokenId == shipmentId`), so there is no separate
`ShipmentNFT` contract. See [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md) for the mapping.

---

## Merging `ShipmentNFT` into `ShipmentTracker` (6 contracts)

**Answer: yes — and it is the better design.** The shipment record and its document of title share
one identity (`tokenId == shipmentId`); the separate NFT contract stored only an owner and a URI,
both facets of the shipment. Merging:

- removes a duplicated existence check and a whole class of "NFT exists but shipment missing" bugs;
- lets one contract own the shipment aggregate (metadata + lifecycle + title);
- **fixes a real gate**: the standalone ERC-721 inherited OpenZeppelin's public `transferFrom`, so the
  owner could move the title freely (contradicting "not freely transferable"). The merged
  `ShipmentTracker` overrides `_update` and rejects every externally initiated transfer; only the
  core's `transferTitle` moves the title at the settlement milestone.

The implementation, tests, scripts and diagrams are already updated; the proposal needs the edits
below (the diagram already shows **6 contracts**).

### Exact proposal edits for the merge

| # | Location | Find / change to |
|---|----------|------------------|
| M1 | §3 **OBJ-4** | "All **seven** contracts verified" → "All **six** contracts verified". |
| M2 | §5 table | **Delete** the `ShipmentNFT.sol` row. |
| M3 | §5 `ShipmentTracker.sol` row | Replace with: "*Orders, shipment records, lifecycle milestones **and the e-B/L document of title**. One ERC-721 token per shipment (`tokenId = shipmentId`) is minted to, and escrowed by, `TradeChainCore`; its `tokenURI` is set when the B/L/AWB is anchored; and it is transferred to the importer at the settlement milestone. Public ERC-721 transfers are rejected, so title moves only through the core at the Incoterm-correct milestone.*" Purpose: "*Shipment lifecycle tracking + digital document of title (e-B/L).*" |
| M4 | §9 **Phase 1** | "Develop the **7** modular contracts" → "Develop the **6** modular contracts"; `^0.8.20` → `^0.8.24`. |
| M5 | §9 **Phase 3** | "Deploy and verify all **7** contracts" → "all **6** contracts". |
| M6 | §7 **Smart Contract Vulnerabilities** row | "cross-contract calls to **`ShipmentNFT.sol`** (ERC-721)" → "**`ShipmentTracker.sol`** (ERC-721 title)". |
| M7 | §4 **Shipment Tracking and Ownership Management** bullet | Append: "*The title token lives inside `ShipmentTracker` (`tokenId = shipmentId`); holders cannot transfer it directly.*" |
| M8 | §5.1 | Insert the updated **Architecture** diagram (6 contracts); the Workflow diagram is deferred to the report. |

## Review of the updated proposal (v4)

### Already fixed in v4

| # | Location | Status |
|---|----------|--------|
| R1 | §7 *Mitigation* — "Pausable circuit breakers" | ✅ removed |
| R2 | §7 *Validation* — 90 % branch, 0 High | ✅ fixed |
| R3 | §3 OBJ-4 — ≥ 90 % branch | ✅ fixed |
| R5 | §9 Phase 3 — "per-role kubo IPFS nodes" | ✅ fixed |
| R6 | §6 React row — "role's own IPFS node" | ✅ fixed |
| R7 | §3 OBJ-1 / §4 Off-Chain — seven types + Customs Clearance | ✅ fixed |
| R8 | §7 *Asset Ownership Integrity* — e-B/L | ✅ fixed |
| R9 | §4 *Incoterms Enforcement* — title transfer | ✅ fixed |

### v4 review items — now resolved in the final proposal

The author applied every v4 item. The final proposal now reads: §9 Phase 2 = "≥ 90 %
branch coverage, 0 high Slither findings" (gas-benchmark claim dropped); §6 = "IPFS (per-role kubo
nodes)"; §9 Phase 3 = "per-role kubo IPFS nodes ... off-chain document uploads"; §5.1 = the
Architecture diagram; §8 = "the document of title is transferred via NFT"; §4 On-Chain Data =
"e-B/L title ownership"; §5 = "IPFS CIDs" and "expiry refund"; "negotiable" removed; title
transfers described as holder-restricted.

### Clarifications — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | IPFS replication | **Per-role kubo nodes; each role keeps its own copy.** Any involved party reads a document by CID through the DApp; a counterparty may keep an extra copy with `scripts/ipfs-pin.js`. |
| 2 | Confidentiality | Out of scope (public CIDs); the model gives consortium retrieval by convention, not cryptographic secrecy. Restricting the swarm / encrypting is optional. |
| 3 | Quality bar | **≥ 90 % branch/statement coverage, 0 High Slither findings** (Medium triaged). Implemented: 100 % statements / **93.08 % branch** / 100 % functions / 100 % lines; CI fails on High. |
| 4 | Document count | **Seven** `DocType`s incl. **Customs Clearance**. |
| 5 | `ShipmentTracker` + `ShipmentNFT` | **Merge into one** (`tokenId == shipmentId`); title transfer gated in `_update`. |
