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

### B.8 — IPFS confidentiality  *(return to local kubo)*
**Where:** §6 Technology Stack, row **"IPFS + Pinata"**; and the **React (Vite)** row.
**Change to:** "**IPFS (local kubo node)** — stores trade documents off-chain while preserving integrity through on-chain CID references; a **local** node keeps commercially sensitive documents private. (Hosted pinning, e.g. Pinata, is an optional convenience and is documented as a trade-off.)"

### B.9 — "Immutable" vs revocation  *(see how the proposal was updated)*
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
milestone-gated title transfer, local-kubo IPFS, and no dispute module / no `Pausable`.
See [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md) for the mapping.
