# TradeChain — Refactor Plan (align with the updated proposal)

Owner: YUNG HOI KI (21232072) · Status: **implemented** · Last updated: 2026-11-24

The submitted proposal ([`CSIT5760_Project_Proposal_21232072.pdf`](../CSIT5760_Project_Proposal_21232072.pdf)) specifies a modular suite, a
**React (Vite)** front end and IPFS document storage. This document tracks the restructure from the
previous composition-root design to the current layout, and records the later decision to merge the
title token into the shipment aggregate.

## Target contract layout (6 contracts + 1 type library)

| # | Contract | Responsibility |
|---|----------|----------------|
| 1 | `TradeChainCore.sol` | AccessControl role authority, central coordinator / single user entry point, document + milestone orchestration. |
| 2 | `LetterOfCredit.sol` | L/C state machine: funding, escrow, atomic settlement, duty, refund (reclaim). |
| 3 | `ShipmentTracker.sol` | Orders + shipment records, lifecycle `Phase`, milestone timestamps, risk holder **and the ERC-721 e-B/L document of title** (`tokenId == shipmentId`). |
| 4 | `ComplianceEngine.sol` | View-only, Incoterm-aware required-document rules and validation. |
| 5 | `DocumentRegistry.sol` | IPFS CID anchors per `(shipment, DocType)`, verification status, anchor-once-then-lock. |
| 6 | `TradeUSD.sol` | ERC-20 settlement stablecoin with **role-gated** minting. |

`contracts/libraries/TradeTypes.sol` holds the shared enums/structs (inlined at compile time, not
deployed).

## Design decisions

- **Central authority, thin modules.** `TradeChainCore` owns the user-facing `AccessControl`; companion
  contracts gate state changes with module `CONTROLLER_ROLE`s held by the core. The core administers
  those module roles with `setModuleRole`, while modules expose public views. This keeps the DApp at
  one entry-point address while deploying six distinct contracts.
- **Escrow in `LetterOfCredit`.** The importer approves the **core**, which moves `TradeUSD` into the
  `LetterOfCredit` escrow (matches the proposal).
- **No certificate NFT.** Verifier attestations are recorded as `DocRecord.verified` in
  `DocumentRegistry` (revocable).
- **No dispute module / no `Pausable`.** Settlement safety relies on `nonReentrant` + CEI + strict
  enum guards; expiry refunds stay available.
- **Duty.** Optional, may be zero; escrowed in the `LetterOfCredit` and forwarded to the treasury
  (customs stand-in) on settlement, or refunded to the payer on reclaim.
- **Per-Incoterm compliance.** Required document sets are a function of Incoterm × phase (the seven
  `DocType`s are the universe).
- **Merged title token.** `ShipmentTracker` is the shipment aggregate *and* the ERC-721 document of
  title. `tokenId == shipmentId`; the token is minted to the core, its URI is set when the B/L/AWB is
  anchored, and it is transferred to the importer only at final delivery. `_update` rejects every
  externally initiated ERC-721 transfer. Payout/risk transfer follows the Incoterm and can occur earlier.

## Phases — status

1. ✅ Contracts restructured; compiles clean (6 deployed + 1 library).
2. ✅ Hardhat suite (97 tests) → 100 % statements / **93.88 % branches** / 100 % functions / 100 % lines.
3. ✅ `scripts/` updated (`deploy`, `seed-demo`, `verify`, `ipfs-add`/`ipfs-pin` for per-role nodes).
4. ✅ React (Vite) + ethers v6 + MetaMask dashboard in `dapp/`; no-build HTML/JS console in `ui/`.
5. ✅ `README.md`, `docs/*`, `docs/PROPOSAL_UPDATES.md`, CI and `.gitignore` updated.

## Post-review adjustments (per the author's feedback)

- **No dispute module** (A.2) — removed from the design and code.
- **No `Pausable`** (B.7) — removed; settlement safety relies on `nonReentrant` + CEI + enum guards.
- **Per-role IPFS** (B.8) — one kubo node per participant; each role keeps its own copy and any
  involved party can read a document by CID through the DApp; Pinata is optional.
- **Verifier / Authorities** modelled as an authorised address whose certificate content lives on
  IPFS (A.3).
- **Per-Incoterm compliance** (A.4) instead of a fixed six-document gate.
- **`TradeUSD` role-gated mint** (A.6).
- **`ShipmentNFT` merged into `ShipmentTracker`** — one aggregate per shipment, and the ERC-721
  transfer surface is actually closed (it was open before), so "milestone-gated title" is enforced.
