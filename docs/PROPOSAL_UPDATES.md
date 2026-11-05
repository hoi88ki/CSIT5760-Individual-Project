# Proposal update guide — TradeChain (CSIT5760_Project_Proposal_21232072.docx)

This maps every feedback item (A.1–C.15) to the **exact place in the proposal** and the suggested
replacement text. It is written so you can apply the edits directly in Word.

Legend: **[§n]** = proposal section number · **→** = suggested wording.

---

## A. Domain / business-logic

### A.1 — "Shipment ownership" NFT conflates title / property / risk  *(point out the update needed)*
**Where:** §4 *Core Smart Contract Functions*, bullet **"Shipment Tracking and Ownership Management"**; and §5 table row **`ShipmentNFT.sol`**.
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
> "The six document types form the universe; the set that must be present before a milestone/payout is derived from the Incoterm and the phase — e.g. **CIF** additionally requires the Insurance Certificate, **FOB** requires the B/L and an inspection certificate, **EXW** requires neither insurance nor an inspection certificate, and **DDP** requires the Certificate of Origin and Customs Clearance (plus duty paid)."

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

### B.8 — IPFS topology & confidentiality  *(consortium, one node per role)*
**Where:** §6 Technology Stack, row **"IPFS …"**; the **React (Vite)** row; §4 *Trade Document Management*; §5 `DocumentRegistry.sol`; §9 Phase 3.
**Change to:** replace the single-node / Pinata wording with a **per-role consortium** model:
> "**IPFS — one node per role (optional private swarm).** Each participant (exporter, importer, bank, logistics, verifier) runs its own kubo node. The issuing role adds the document to its own node; the on-chain record stores only the **CID** (one CID per `(shipment, DocType)`). The CID is then **replicated/pinned** to the counterparties' nodes (via a private swarm and/or IPFS Cluster / explicit pinning), so any replica can serve the same bytes. Because CIDs are content-addressed, integrity is guaranteed regardless of which node responds, and *no per-role on-chain records are needed*."

**Confirmed design (see [`IPFS_CONSORTIUM.md`](./IPFS_CONSORTIUM.md)):**
- **Replication = shared private swarm + manual pin.** Each role runs its own kubo node; nodes join
  a **private swarm** (`swarm.key`), and after a CID is anchored on-chain every counterparty that
  needs the document runs `ipfs pin add <cid>` (helper: `scripts/ipfs-pin.js`).
- **Confidentiality = private swarm only.** Retrieval is restricted to consortium members. This is
  *not* cryptographic secrecy: CIDs are public on-chain, so a leaked key or the bytes themselves
  defeat it. Encryption before pinning is out of scope.
- **Availability requires pinning** — an unpinned CID is unfetchable once its only holder is offline.
- **Pinata is dropped** in this model (single hosted provider); it remains an optional convenience.
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
> "**0 High-severity Slither findings** (Medium findings are reported and triaged manually), **≥ 90 % statement and branch coverage**." (The repo currently reaches ~98 % statements / ~87 % branch.)

---

## C. Methodology / process

### C.12 — Objectives not measurable  *(suggest change)*
**Where:** §3 Project Objectives table.
**Suggested replacements (keep the same IDs):**
- **OBJ-1** — "Implement the document registry and e-B/L token." *Success:* "Each of the six document types is anchored by its designated role; an anchored CID cannot be replaced; unauthorised anchors revert; the e-B/L token transfers to the importer only at the Incoterm-correct milestone."
- **OBJ-2** — "Implement role-based access control." *Success:* "Every privileged function reverts with `AccessControlUnauthorizedAccount`/`Unauthorized` for accounts lacking the required role; an access-control matrix test passes."
- **OBJ-3** — "Implement Incoterm-aware shipment tracking and settlement." *Success:* "All four Incoterms (EXW/FOB/CIF/DDP) settle at the correct risk-transfer milestone; DDP blocks until customs clearance and duty are complete; the required-document set is validated per Incoterm."
- **OBJ-4** — "Deploy, test and verify on Sepolia." *Success:* "All seven contracts verified on Etherscan; ≥ 90 % statement/branch coverage; 0 High Slither findings; all positive/negative/boundary tests passing."

### C.13 — Timeline  *(ignore — noted)*
No change.

### C.14 / C.15 — Page budget & reference hygiene  *(noted)*
Optional: trim §2 and the bullet lists to fit "2–3 pages excluding references"; references are already duplicate-free.

---

## Also update §5.1 "Architecture or Workflow"

The section is currently **empty**. Insert the two diagrams from
[`docs/diagrams/TradeChain.drawio`](./diagrams/TradeChain.drawio) (pages **Architecture** and
**Workflow**), e.g. exported to PNG and embedded, or add: *"Architecture and workflow diagrams:
`docs/diagrams/TradeChain.drawio`."*

## Reference implementation status

The accompanying implementation already applies A.1–A.6, B.7, B.8, B.10 and B.11:
seven contracts (`TradeChainCore`, `LetterOfCredit`, `ShipmentTracker`, `ComplianceEngine`,
`DocumentRegistry`, `ShipmentNFT`, `TradeUSD`), role-gated minting, per-Incoterm compliance,
milestone-gated title transfer, consortium (per-role) IPFS, and no dispute module / no `Pausable`.
See [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md) for the mapping.

---

## Review of the updated proposal (v3) — remaining edits

You applied most of A.1–A.6 and B.8/B.10. The following are **still outstanding** in the current
`.docx` (each with its location):

| # | Location | What to change |
|---|----------|----------------|
| R1 | §7 last row, *Mitigation* | Remove "**Pausable circuit breakers**" — `Pausable` was dropped (B.7). |
| R2 | §7 last row, *Validation* | "0 high/medium findings" → "**0 High** findings (Medium triaged)"; "≥ 85 % branch" → "**≥ 90 %**". |
| R3 | §3 **OBJ-4** | "≥ 85 % branch coverage" → "**≥ 90 %**" (B.11: a considerably high bar). |
| R4 | §9 **Phase 2** deliverable | "≥ 85 % branch coverage, 0 high/medium Slither findings" → align to R2. |
| R5 | §9 **Phase 3** | "integrated with **Pinata IPFS SDK**" → "integrated with the **per-role kubo IPFS nodes**". |
| R6 | §6 **React (Vite)** row | "upload documents to **Pinata**" → "upload to the **role's own IPFS node**". |
| R7 | §3 **OBJ-1** | "each of the **six** document types" — the registry actually holds **seven** `DocType`s. Say "each document type" or "**seven**". Also add **Customs Clearance** to §4 *Off-Chain Data* (DDP requires it). |
| R8 | §7 **Asset Ownership Integrity** row | "Shipment ownership is represented by ERC-721 NFTs" → "The **document of title (e-B/L)** is represented by an ERC-721 NFT". |
| R9 | §4 **Incoterms Enforcement** bullet | "ownership transfer" → "**title (document-of-title) transfer**" (consistent with A.1). |
| R10 | §5.1 *Architecture or Workflow* | Still empty — insert the two pages of [`docs/diagrams/TradeChain.drawio`](./diagrams/TradeChain.drawio). |

### Clarifications — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | IPFS replication | **Private swarm + manual pin** (`scripts/ipfs-pin.js`); no IPFS Cluster. |
| 2 | Confidentiality | **Private swarm only** (consortium members); encryption out of scope. |
| 3 | Quality bar | **≥ 90 % branch/statement coverage, 0 High Slither findings** (Medium triaged). Implemented: 100 % statements / **92.6 % branch** / 100 % functions / 100 % lines; CI fails on High. |
| 4 | Document count | **Seven** `DocType`s incl. **Customs Clearance** (add it to §4's off-chain list). |
