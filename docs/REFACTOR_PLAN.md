# TradeChain — Refactor Plan (align with the updated proposal)

Owner: YUNG HOI KI (21232072) · Status: **implemented** · Last updated: 2026-11-05

The updated proposal (`CSIT5760_Project_Proposal_21232072.docx`) specifies **seven modular
contracts** and adds **dispute resolution**, a **React (Vite)** front end and **Pinata** IPFS.
This document tracks the restructure from the previous composition-root design to that layout.

## Target contract layout (7 contracts + 1 type library)

| # | Contract | Responsibility |
|---|----------|----------------|
| 1 | `TradeChainCore.sol` | AccessControl role authority, central coordinator / single user entry point, NFT + document orchestration, `Pausable`. |
| 2 | `LetterOfCredit.sol` | L/C state machine: funding, escrow, atomic settlement, duty, refund (reclaim), dispute hold/bond. |
| 3 | `ShipmentTracker.sol` | Orders + shipment records, lifecycle `Phase`, milestone timestamps, risk holder, dispute flag. |
| 4 | `ComplianceEngine.sol` | View-only, Incoterm-aware required-document rules and validation. |
| 5 | `DocumentRegistry.sol` | IPFS CID anchors per `(shipment, DocType)`, verification status, anchor-once-then-lock. |
| 6 | `ShipmentNFT.sol` | ERC-721 document-of-title / shipment-ownership token (milestone-gated transfer, escrowed by the core). |
| 7 | `TradeUSD.sol` | ERC-20 settlement stablecoin with **role-gated** minting. |

`contracts/libraries/TradeTypes.sol` holds the shared enums/structs (inlined at compile time, not
deployed).

## Design decisions

- **Central authority, thin modules.** `TradeChainCore` owns `AccessControl`; every other contract
  only accepts calls from the core (`onlyCore`) and exposes public views. This keeps the DApp at a
  single address while still deploying seven distinct contracts.
- **Escrow in `LetterOfCredit`.** The importer approves the **core**, which moves `TradeUSD` into the
  `LetterOfCredit` escrow (matches the proposal).
- **No certificate NFT.** The proposal's seven-contract list has no certificate token, so verifier
  attestations are recorded as `DocRecord.verified` in `DocumentRegistry` (revocable).
- **Dispute resolution.** A `Disputed` flag suspends settlement/refund. The raiser may post a bond
  (admin-set, default 0). An `ROLE_ARBITER` resolves with `Resume | Release | Refund`; the bond is
  returned to the raiser.
- **Pausable.** Admin can pause state-advancing operations; the **refund / dispute** paths stay open
  so a pause can never strand escrow.
- **Duty.** Optional, may be zero; escrowed in the `LetterOfCredit` and forwarded to the treasury
  (customs stand-in) on settlement or refunded to the payer on reclaim.
- **Per-Incoterm compliance.** Required document sets are a function of Incoterm × phase (the six
  types are the universe), fixing the proposal's fixed-six conflict.

## Phases — status

1. ✅ Contracts restructured to the seven-contract layout; compiles clean.
2. ✅ Hardhat suite rewritten (77 tests) → statements ~98 %, branches ~87 %, lines ~98 %.
3. ✅ `scripts/` updated (`deploy`, `seed-demo`, `verify`, `ipfs-add` with local kubo **and** `--pinata`).
4. ✅ React (Vite) + ethers v6 + MetaMask DApp in `dapp/` (builds via `npm run build`).
5. ✅ `README.md`, `docs/*`, `docs/PROPOSAL_UPDATES.md`, CI and `.gitignore` updated.

## Post-review adjustments (per the author's feedback)

- **No dispute module** (A.2) — removed from the design and code.
- **No `Pausable`** (B.7) — removed; settlement safety relies on `nonReentrant` + CEI + enum guards.
- **Local kubo IPFS** (B.8) — the default; Pinata is an optional `--pinata` path.
- **Verifier / Authorities** modelled as an authorised address whose certificate content lives on
  IPFS (A.3).
- **Per-Incoterm compliance** (A.4) instead of a fixed six-document gate.
- **`TradeUSD` role-gated mint** (A.6).
