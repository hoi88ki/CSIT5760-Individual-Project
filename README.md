# TradeChain — A Decentralized International Trade & Document Tracker

> **CSIT5760 Blockchain and Smart Contracts — Individual Project**
> Student: YUNG HOI KI (21232072) · Instructor: Pritom Rajkhowa · Network: **Ethereum Sepolia Testnet**
> Repository: `https://github.com/hoi88ki/CSIT5760-Individual-Project`

TradeChain is an on-chain documentary trade-finance and supply-chain tracker. It pins trade
documents on **IPFS** and verifies only their immutable **CIDs** plus **third-party
attestations** on **Ethereum**. Exporters, importers, carriers, banks, inspection bodies,
insurers and customs officers interact through **role-gated smart contracts**, while the core
contract acts as an **automated Letter-of-Credit (L/C) examining bank** that releases a
**100% atomic payout at the exact milestone where risk transfers under the chosen Incoterm**
(EXW / FOB / CIF / DDP).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Motivation](#2-motivation)
3. [Project Objectives](#3-project-objectives)
4. [System Architecture](#4-system-architecture)
   - [Contract Map](#41-contract-map)
   - [Roles](#42-roles)
   - [Document Types & Anchor Authority](#43-document-types--anchor-authority)
   - [Tokens](#44-tokens)
   - [Shipment Lifecycle (State Machine)](#45-shipment-lifecycle-state-machine)
   - [Incoterm Settlement & Document Matrix](#46-incoterm-settlement--document-matrix)
   - [End-to-End Flow](#47-end-to-end-flow)
5. [Repository Structure](#5-repository-structure)
6. [Technology Stack](#6-technology-stack)
7. [Getting Started](#7-getting-started)
8. [Security Considerations](#8-security-considerations)
9. [Testing Plan](#9-testing-plan)
10. [CI / Static Analysis](#10-ci--static-analysis)
11. [Project Roadmap & Progress Log](#11-project-roadmap--progress-log)
12. [Proposal Deviations & Improvements](#12-proposal-deviations--improvements)
13. [Open Questions](#13-open-questions)
14. [References](#14-references)
15. [License](#15-license)

---

## 1. Overview

International trade of general merchandise still relies on manually reconciling a bundle of
paper documents — commercial invoice, packing list, certificate of origin, inspection and
insurance certificates, bill of lading / air waybill, and customs clearance attestation —
against a Letter of Credit whose payment terms follow ICC **Incoterms® 2020**. This paper
reconciliation takes **5–10 days** of bank inspection, adds **1–3%** in fees, and remains
vulnerable to forgery (e.g. duplicate bills of lading) and to missing certificates discovered
only after cargo arrival.

TradeChain removes the trusted intermediary for the *verification and settlement* step:

- **Documents stay off-chain** (IPFS). Only immutable **CIDs** are checked on-chain — O(1) gas
  per document, no bulky calldata.
- **Attestations become tokens.** Inspection bodies, insurers and customs officers anchor
  certificates as **verifiable, revocable ERC-721 NFTs** that are checked at payout.
- **Title becomes a token.** The **Bill of Lading is an ERC-721 eB/L** escrowed by the core
  contract and released to the Buyer at final delivery.
- **Payout follows risk.** The contract validates the Incoterm-mandated document set and
  executes a **100% atomic payout** exactly when risk transfers.

## 2. Motivation

A conventional database can record the same facts, but it cannot provide the **credible
neutrality** that the settlement requires without a trusted operator: either party (or a single
bank) can stall or censor the release of funds. TradeChain encodes:

- **Objective, machine-checkable release conditions** (required document set per Incoterm).
- **Neutrality safeguards** — permissionless reclaim if the Seller never ships, and
  either-bank force-finalize if the Buyer withholds confirmation.
- **Tamper-evidence** — document slots are immutable once anchored; certificate NFTs are
  revocable (burn) so a withdrawn attestation is immediately visible on-chain.

## 3. Project Objectives

| ID | Measurable objective | Success criterion |
|----|----------------------|-------------------|
| **OBJ-1** | Implement an ERC-721 **eB/L title token**, an **IPFS document registry** (7 `DocType`s), and **verifiable certificate NFTs** for third-party attestations. | Every document is anchored only by its designated role; verifier attestations mint unrevoked certificate NFTs; unauthorized calls revert. |
| **OBJ-2** | Implement a **Smart L/C settlement module** with atomic payout and neutrality safeguards (permissionless expired-L/C reclaim; either-bank force-finalize). | Funds release only at the Incoterm-mandated milestone; the Buyer, the Seller, and no single bank together can stall settlement. |
| **OBJ-3** | Deliver automated **security analysis, testing, and a verified Sepolia deployment**. | ≥ 90% statement/branch coverage; no High/Medium Slither findings; contracts verified on Etherscan. |

## 4. System Architecture

### 4.1 Contract Map

The design uses **one storage layout, modular source files, and a single deployment address**
(no proxies, no upgradeable patterns).

| Component | Type | Responsibility |
|-----------|------|----------------|
| `ShipmentState` | abstract (storage base) | Shared `Shipment`/`DocRecord` structs, `Incoterm`/`Phase`/`DocType` enums, custom errors, role constants, escrow/bookkeeping mappings. |
| `DocumentRegistry` | abstract module | `DocType` × `DocRecord{cid, issuer, timestamp, locked, certId}`; per-`DocType` issuer checks; anchor-once-then-lock; triggers `TradeCertNFT` minting for verifier types. |
| `SettlementModule` | abstract module | Orders → shipments, ERC-20 L/C escrow, `_triggerAtomicPayout()` (`nonReentrant`, strict CEI), per-Incoterm required-document bitmask, duty escrow, `riskHolder` tracking, deadline reclaim, either-bank force-finalize. |
| `TradeChainCore` | concrete (composition root) | Single entry point for all functions; inherits every module; deploys and **owns** the standalone `EBLToken` and `TradeCertNFT`. |
| `EBLToken` | standalone ERC-721 | `ERC721URIStorage` eB/L title token, escrowed by the core until settlement. |
| `TradeCertNFT` | standalone ERC-721 | Verifiable certificate token; minted **only** through the authorized `anchorDocument()` path; revocation = burn. |

**Inheritance graph**

```
AccessControl (OZ v5)
      │
ShipmentState (abstract) ── ReentrancyGuard (OZ v5)
      │
DocumentRegistry (abstract)
      │
SettlementModule (abstract)
      │
TradeChainCore (concrete)  ──deploys──►  EBLToken
                           ──deploys──►  TradeCertNFT
```

### 4.2 Roles

All authorisation is enforced with OpenZeppelin `AccessControl`. The deployer is the
`DEFAULT_ADMIN_ROLE` and grants the six operational roles used by the demo (six wallets).

| Role | Constant | Typical holder |
|------|----------|----------------|
| Seller / Exporter | `ROLE_SELLER` | Exporter wallet |
| Buyer / Importer | `ROLE_BUYER` | Importer wallet |
| Carrier / Logistics | `ROLE_CARRIER` | Shipping line / freight forwarder |
| Issuing bank | `ROLE_ISSUING_BANK` | Buyer's bank |
| Advising bank | `ROLE_ADVISING_BANK` | Seller's bank |
| Verifier | `ROLE_VERIFIER` | Shared inspector / insurer / customs officer (trusted-oracle model) |

Any call with a missing role reverts with `Unauthorized(...)`. Admin can batch-grant roles via
`grantRoles(bytes32[] roles, address[] accounts)`.

### 4.3 Document Types & Anchor Authority

| `DocType` | Index | Designated anchor role | Certificate NFT? |
|-----------|:-----:|------------------------|:----------------:|
| `CommercialInvoice` | 0 | Seller (at `createShipment`) | no |
| `PackingList` | 1 | Seller (at `createShipment`) | no |
| `CertificateOfOrigin` | 2 | Seller (via `anchorDocument`) | no |
| `InspectionCertificate` | 3 | Verifier / inspection body | **yes** |
| `InsuranceCertificate` | 4 | Verifier / insurer | **yes** |
| `BillOfLadingOrAWB` | 5 | Carrier (via `confirmVesselLoading`) | no |
| `CustomsClearance` | 6 | Verifier / customs officer | **yes** |

Rules:

- **Anchor-once-then-lock** — a second anchor for the same `(shipment, DocType)` reverts with
  `DocumentLocked`. A CID can never be replaced after anchoring.
- The invoice + packing list are anchored by `createShipment()`; the B/L (or AWB) is anchored by
  `confirmVesselLoading()` (which also updates the eB/L `tokenURI`); the certificate of origin +
  the three verifier types are anchored by `anchorDocument()`.
- Every verifier-type anchor **mints a `TradeCertNFT`** to the issuer. Burning the NFT (revoke)
  makes the document invalid at payout.

### 4.4 Tokens

| Token | Standard | Purpose |
|-------|----------|---------|
| `EBLToken` | ERC-721 (`ERC721URIStorage`) | Bill-of-Lading **title**. Minted to the core contract (escrow) and transferred to the Buyer at final delivery. |
| `TradeCertNFT` | ERC-721 | Verifiable certificate attestations. Minted only by the core inside `anchorDocument()`; revocation = burn. |
| **ERC-20 stablecoin** | ERC-20 (`SafeERC20`) | L/C escrow (`openLetterOfCredit`) and customs duty (`payCustomsDuty`). A `MockERC20` (6-decimal, USDC-like) is used on test networks; any stablecoin can be injected at deployment. |

### 4.5 Shipment Lifecycle (State Machine)

```
   Buyer createOrder()   Seller createShipment()      Buyer openLetterOfCredit()
   Order ─────────────────────────► Created ───────────────────────────────────────► LCFunded
                                                                                       │
                                            confirmPickup()  (EXW ⇒ payout)            │
                          ┌────────────────────────────────────────────────────────────┘
                          ▼
                      PickedUp ──confirmVesselLoading(blCid)──► LoadedOnVessel
                          │                                   (FOB/CIF ⇒ payout)
                          │                                            │
                          │                                            │ confirmFinalDelivery()
                          │                                            │ (DDP ⇒ payout)
                          ▼                                            ▼
                  ┌─────────────────────────  _maybeSettle()  ──────────────────────────┐
                  │                                                                     │
                  └────────────────────────────► Delivered ─────► Settled               │
                                                                                        │
   LCFunded + deadline passed + never shipped:  reclaimExpiredLC() ──► Reclaimed ◄───────┘
```

**Terminal / settlement semantics**

- `Settled` is reached when **both** the eB/L title has been transferred **and** the L/C has
  been paid (this can happen at different milestones for different Incoterms).
- `Reclaimed` is terminal: the Buyer's escrow is returned because the Seller never shipped
  before the deadline.
- `riskHolder` is initialised to the **Seller** and flips to the **Buyer** at the risk-transfer
  milestone (used by the insurance module).

### 4.6 Incoterm Settlement & Document Matrix

`requireDocuments(id, bitmask)` is evaluated on every transition and again at payout. The table
shows the **payout trigger** and the **mandatory document set** enforced there.

| Incoterm | Risk transfers | Payout trigger | Mandatory documents at payout |
|----------|----------------|----------------|-------------------------------|
| **EXW** | at pickup | `confirmPickup` → **PickedUp** | Invoice + PackingList |
| **FOB** | on vessel | `confirmVesselLoading` → **LoadedOnVessel** | + InspectionCertificate + BillOfLading |
| **CIF** | on vessel | `confirmVesselLoading` → **LoadedOnVessel** | + InspectionCertificate + BillOfLading + InsuranceCertificate |
| **DDP** | at destination | `confirmFinalDelivery` → **Delivered** | + InspectionCertificate + BillOfLading + CertificateOfOrigin + CustomsClearance **and duty paid** |

Payout is **100 % of the escrowed L/C amount**, transferred atomically to the **Seller**, under a
strict checks-effects-interactions pattern guarded by `nonReentrant`.

### 4.7 End-to-End Flow

```
Seller            createShipment(term, lcAmount, deadline, invoiceCID, packingListCID)
Buyer             openLetterOfCredit(id) {value: lcAmount}
Verifier          anchorDocument(id, CertificateOfOrigin | Inspection | Insurance | Clearance, cid)
Carrier           confirmPickup(id)
Carrier           confirmVesselLoading(id, blCid)          → anchors B/L, updates eB/L tokenURI
Seller/Buyer      payCustomsDuty(id) (Seller under DDP, Buyer otherwise)
Buyer             confirmFinalDelivery(id)                 → transfers eB/L title, DDP payout
anyone            reclaimExpiredLC(id)                     → after deadline, if never shipped
Issuing/Advising  forceFinalizeDelivery(id)                → if the Buyer withholds confirmation
```

## 5. Repository Structure

```
.
├── contracts/
│   ├── core/
│   │   ├── ShipmentState.sol          # storage base: structs, enums, errors, roles
│   │   ├── DocumentRegistry.sol       # 7 DocTypes, anchor-once-then-lock, cert minting
│   │   └── SettlementModule.sol       # orders, ERC-20 escrow, atomic payout, reclaim, force-finalize
│   ├── tokens/
│   │   ├── EBLToken.sol               # ERC-721 eB/L title token
│   │   └── TradeCertNFT.sol           # ERC-721 certificate token (revocation = burn)
│   ├── mocks/
│   │   ├── MockERC20.sol              # 6-decimal demo stablecoin
│   │   ├── MaliciousReentrancy.sol    # adversarial settlement token (reentrancy test)
│   │   └── TradeChainHarness.sol      # test harness exposing internal guards
│   └── TradeChainCore.sol             # composition root / single entry point
├── test/
│   ├── helpers/fixture.js              # fixtures, role wiring, CID constants
│   ├── Order.test.js                   # createOrder / createShipment / openLetterOfCredit
│   ├── DocumentRegistry.test.js        # anchoring, certificate NFTs, revocation
│   ├── AccessControl.test.js           # role & state-machine matrix
│   ├── Incoterms.e2e.test.js           # happy-path E2E for EXW / FOB / CIF / DDP
│   ├── Neutrality.test.js              # reclaim / force-finalize
│   ├── Reentrancy.test.js              # adversarial token
│   ├── Tokens.test.js                  # EBLToken & TradeCertNFT units
│   ├── Views.test.js                   # getters, doc masks, token views
│   └── Harness.test.js                 # unreachable payout guards
├── scripts/
│   ├── deploy.js                       # deploy core + tokens, wire roles
│   ├── seed-demo.js                    # drive a full EXW→FOB→CIF→DDP demo
│   ├── verify.js                       # Etherscan verification helper
│   └── ipfs-add.js                     # local kubo IPFS upload → CIDv1
├── dapp/                               # minimal one-page role dashboard (ethers v6, no build)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DESIGN_DECISIONS.md
│   └── SECURITY.md
├── .github/workflows/ci.yml            # compile + test + coverage + Slither
├── .solhint.json
├── hardhat.config.js
├── slither.config.json
├── .env.example
├── ProposalImprovement.md              # issues found in the original proposal
├── QUESTIONS.md                        # open questions / assumptions
└── README.md
```

## 6. Technology Stack

| Technology / version | Purpose | Rationale |
|----------------------|---------|-----------|
| **Solidity `^0.8.24`** (compiled with 0.8.28 / Cancun) | Smart contract development | Custom errors, packed structs, built-in overflow checks; 0.8.28 supplies the `mcopy` builtin OpenZeppelin v5.6 needs. |
| **Hardhat + Mocha/Chai + `solidity-coverage` + `hardhat-gas-reporter`** | Tests, coverage, gas profiling | De-facto standard local EVM suite; maps directly to the success criteria. |
| **OpenZeppelin Contracts v5** | `ERC721URIStorage`, `AccessControl`, `ReentrancyGuard`, `SafeERC20` | Audited building blocks avoid re-implementing known vulnerabilities. |
| **IPFS (local kubo node)** | Off-chain document PDFs + certificate metadata | Bulky files stay off-chain; only immutable CIDs are checked on-chain (constant-bounded gas). Local node keeps documents private and independently verifiable. |
| **Slither & Solhint** | Static security analysis | Automatic detection of reentrancy, access-control and storage mistakes. |
| **GitHub Actions CI** | Compile + test + coverage + Slither on every push | Continuous, citable evidence for the security/coverage criteria. |
| **Ethers.js v6 (static dashboard)** | Minimal one-page role dashboard | Mature wallet-connect stack, no build step; scope kept minimal to protect the contract grade. |
| **Ethereum Sepolia Testnet** | Deployment + Etherscan verification | Public, well-supported testnet for a verifiable end-to-end demo. |

## 7. Getting Started

### Prerequisites

- Node.js ≥ 18 (developed on Node 26)
- npm
- (optional) [Slither](https://github.com/crytic/slither) via `pipx install slither-analyzer`
- (optional) [kubo (IPFS)](https://docs.ipfs.tech/install/) for local document pinning
- (optional) a Sepolia RPC URL + funded deployer key for deployment

### Install & compile

```bash
npm install
npx hardhat compile
```

### Test

```bash
npx hardhat test                 # full suite
npx hardhat test test/Incoterms.e2e.test.js
```

### Coverage & gas

```bash
npx hardhat coverage
REPORT_GAS=true npx hardhat test
```

Current result: **67 tests passing · statements 100 % · branches 95.93 % · functions 100 % · lines 100 %**
(mocks excluded from the denominator via `.solcover.js`).

### Lint & static analysis

```bash
npx solhint "contracts/**/*.sol"
pipx run slither . --config-file slither.config.json
```

### Deploy to Sepolia

```bash
cp .env.example .env             # fill SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY
npx hardhat run scripts/deploy.js --network sepolia
npx hardhat run scripts/verify.js  --network sepolia
```

### Minimal DApp (no build step)

```bash
npx hardhat node                                              # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # copy the core address
node dapp/server.js                                           # terminal 2 → http://localhost:5173
```

Paste the core address into the dashboard and select a role account. With a local node the
unlocked accounts are used directly; MetaMask is picked up automatically when present.

## 8. Security Considerations

| Risk | Attack / failure scenario | Mitigation | Validation method |
|------|---------------------------|------------|-------------------|
| **Documentary fraud** | Payout attempted without the mandatory B/L, Inspection, Insurance (CIF) or Clearance certificate; a CID replaced after funding | `requireDocuments(bitmask)` on every transition; document slots **immutable once anchored** | Negative tests assert exact `MissingMandatoryDocument(DocType)` / `DocumentLocked()` reverts |
| **Unauthorized attestations** | Exporter self-signs a regulatory certificate or forges a certificate NFT | Certificates mint **only** inside the per-`DocType`-authorized `anchorDocument()` path | Access-control matrix test: every unauthorized role / `DocType` and mint reverts |
| **Reentrancy** | Malicious payee re-enters during payout | OZ `nonReentrant` + strict **CEI** (state finalised before transfers) | `slither --detect reentrancy-eth` clean; `MaliciousReentrancy.sol` fails to extract funds |
| **Settlement stall** | Buyer withholds `confirmFinalDelivery()`; Seller never ships; one bank refuses to release | Shipment deadline + reclaim by Buyer / issuing bank / admin; **either** bank can force-finalize at objective completion | Timeout tests; payout succeeds independently from each bank wallet |
| **Revoked attestation** | A verifier revokes a certificate after it was relied upon | Certificate burn makes the document invalid before payout; check at `_triggerAtomicPayout` | Test: burn a required cert → payout reverts |

## 9. Testing Plan

| Test category | Representative scenario | Expected evidence |
|---------------|-------------------------|-------------------|
| **Happy-path E2E (4 Incoterms)** | Full flow per Incoterm incl. certificate NFTs and the DDP clearance gate | Atomic payout at the exact milestone in the matrix; `EBLToken` transfers to Buyer |
| **Negative & boundary** | Omit each required document (incl. Clearance for DDP); insufficient token allowance; empty `""` CID; duplicate anchoring; unauthorized uploads / mints | Deterministic custom-error reverts; zero funds move |
| **Neutrality & timeout** | Reclaim only after expiry; force-finalize reverts until objective-complete; per-bank release | No single party can stall settlement |
| **Access control** | Exhaustive role × function × `DocType` matrix | `Unauthorized` / `AccessControlUnauthorizedAccount` reverts |
| **Security & coverage** | `MaliciousReentrancy`, Slither + `solidity-coverage` in CI | No High/Medium findings; ≥ 90 % branch/statement coverage |

## 10. CI / Static Analysis

`.github/workflows/ci.yml` runs on every push / PR:

1. `npm ci`
2. `npx hardhat compile`
3. `npx solhint "contracts/**/*.sol"`
4. `npx hardhat test`
5. `npx hardhat coverage` (uploaded as an artifact)
6. Slither (`--fail-high`) on contracts

Slither & Solhint reports are retained as build artifacts for the security criterion.

## 11. Project Roadmap & Progress Log

| Phase | Planned activities | Target date | Deliverable | Status |
|-------|--------------------|-------------|-------------|--------|
| **Phase 0** | Repo skeleton, README, tooling, CI | Week 1 (9–18 Nov) | This repository, compiling project | ✅ done (started early) |
| **Phase 1** | Implement all contracts (registry, cert NFT, settlement) + tests | Week 1 (9–18 Nov) | Compiling, tested contracts | ✅ done |
| **Phase 2** | Slither remediation, malicious-contract simulations, coverage ≥ 90 % | Week 2 (19–24 Nov) | Coverage & Slither reports in CI | 🟡 coverage 100 %/95.9 % reached; Slither pending CI run |
| **Phase 3** | Minimal role dashboard (local IPFS + ethers v6); deploy/verify on Sepolia; demo video + final report | Week 3 (25–29 Nov) | Verified contracts, demo, final report | 🟡 dashboard + local demo done; Sepolia deploy/video/report pending |

**Progress log** — see the Git history (`git log --oneline`) for the per-commit record.

## 12. Proposal Deviations & Improvements

Issues and ambiguities discovered while implementing the original proposal are tracked in
[`ProposalImprovement.md`](./ProposalImprovement.md). Each entry states the issue, the impact,
and the resolution adopted.

## 13. Open Questions

Assumptions made to avoid blocking the work are recorded in [`QUESTIONS.md`](./QUESTIONS.md).

## 14. References

1. W. Entriken, D. Shirley, J. Evans, N. Sachs, "EIP-721: Non-Fungible Token Standard," Ethereum Foundation, 2018.
2. OpenZeppelin, "OpenZeppelin Contracts Documentation (v5.x)," 2024.
3. Nomic Foundation, "Hardhat Documentation," 2024.
4. Protocol Labs, "IPFS Documentation — Content Addressing and CIDs," 2024.
5. J. Feist, G. Grieco, A. Groce, "Slither: A Static Analysis Framework For Smart Contracts," WETSEB, 2019.
6. International Chamber of Commerce (ICC), *Incoterms® 2020 Rules*, ICC Publication No. 723E, 2020.

## 15. License

Released under the [MIT License](./LICENSE).
