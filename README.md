# TradeChain — A Decentralized International Trade & Document Tracker

> **CSIT5760 Blockchain and Smart Contracts — Individual Project**
> Student: YUNG HOI KI (21232072) · Instructor: Pritom Rajkhowa · Network: **Ethereum Sepolia Testnet**
> Repository: `https://github.com/hoi88ki/CSIT5760-Individual-Project`

TradeChain is an on-chain documentary trade-finance and supply-chain tracker built as **six
modular smart contracts**. It stores trade documents on **IPFS** (one kubo node per participant)
and verifies only their **CIDs** plus the **issuer's role** on **Ethereum**. Exporters, importers,
banks, logistics providers, verifiers/authorities and the administrator interact through
**role-gated** contracts, and the suite acts as an automated **Letter-of-Credit examining bank**
that releases a **100 % atomic payout at the exact milestone where risk transfers under the chosen
Incoterm** (EXW / FOB / CIF / DDP).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Objectives](#2-objectives)
3. [System Architecture](#3-system-architecture)
4. [Repository Structure](#4-repository-structure)
5. [Technology Stack](#5-technology-stack)
6. [Getting Started](#6-getting-started)
7. [Sepolia Deployment (verified)](#7-sepolia-deployment-verified)
8. [Step-by-step Verification Walkthrough](#8-step-by-step-verification-walkthrough)
9. [Security Considerations](#9-security-considerations)
10. [Testing & Coverage](#10-testing--coverage)
11. [CI / Static Analysis](#11-ci--static-analysis)
12. [Roadmap & Progress Log](#12-roadmap--progress-log)
13. [Proposal Updates & Design Decisions](#13-proposal-updates--design-decisions)
14. [References](#14-references)
15. [License](#15-license)

---

## 1. Overview

International trade of general merchandise relies on a bundle of paper documents — commercial
invoice, packing list, certificate of origin, inspection and insurance certificates, bill of
lading / air waybill, and customs clearance — reconciled against a Letter of Credit whose payment
terms follow ICC **Incoterms® 2020**. This reconciliation is slow, expensive, and vulnerable to
forgery. TradeChain removes the trusted intermediary for the *verification and settlement* step:

- **Documents stay off-chain** (IPFS). Only **CIDs** are anchored on-chain.
- **Attestations are role-gated.** Inspection/insurance/customs certificates can only be anchored
  by the authorised verifier address, and can be revoked (invalidating them at payout).
- **Title becomes a token.** The e-B/L is an **ERC-721 document of title** owned by
  `ShipmentTracker` (one token per shipment, `tokenId == shipmentId`), escrowed by the core and
  released to the importer at the Incoterm-correct milestone.
- **Payout follows risk.** The contract validates the Incoterm-mandated document set and executes a
  **100 % atomic payout** exactly when risk transfers.

## 2. Objectives

| ID | Objective | Success criterion |
|----|-----------|-------------------|
| **OBJ-1** | Document registry + e-B/L token | Each document type is anchored by its designated role; anchored CIDs are locked (never silently replaced); the title NFT transfers to the importer at the Incoterm-correct milestone. |
| **OBJ-2** | Role-based access control | Every privileged function reverts for accounts lacking the required role; an access-control matrix test passes. |
| **OBJ-3** | Incoterm-aware tracking & settlement | EXW/FOB/CIF/DDP settle at the correct risk-transfer milestone; DDP blocks until clearance + duty; the required-document set is validated per Incoterm. |
| **OBJ-4** | Deploy, test & verify on Sepolia | Six contracts **deployed and verified** on Etherscan (see [§7](#7-sepolia-deployment-verified)); ≥ 90 % branch coverage; 0 High Slither findings; positive/negative/boundary tests passing. |

## 3. System Architecture

### 3.1 Contract map (6 contracts + 1 type library)

| # | Component | Type | Responsibility |
|---|-----------|------|----------------|
| 1 | `TradeChainCore` | concrete (coordinator) | `AccessControl` role authority + single user entry point; deploys/wires the companions; orchestrates documents, milestones, settlement. |
| 2 | `LetterOfCredit` | module | L/C state machine: funding, `TradeUSD` escrow, customs duty, atomic payout, expiry refund (reclaim). |
| 3 | `ShipmentTracker` | module + ERC-721 | Orders + shipment records, lifecycle `Phase`, milestone timestamps, risk holder **and the e-B/L document-of-title token** (`tokenId == shipmentId`, milestone-gated transfer). |
| 4 | `ComplianceEngine` | view module | Incoterm-aware required-document rules and validation. |
| 5 | `DocumentRegistry` | module | Per-`(shipment, DocType)` CID anchors, verification status, anchor-once-then-lock. |
| 6 | `TradeUSD` | ERC-20 | Settlement stablecoin with **role-gated** minting. |

`contracts/libraries/TradeTypes.sol` holds the shared enums/structs (inlined, not deployed).

**How they connect**

```
                    +----------------------- TradeChainCore (AccessControl) -----------------------+
   roles grant ---> |  ROLE_EXPORTER · IMPORTER · BANK · LOGISTICS · VERIFIER   (+ DEFAULT_ADMIN)   |
                    +------+---------------+---------------+---------------+-----------+-----------+
                           | onlyCore      | onlyCore       | view          | onlyCore
                           v               v                v               v
                     ShipmentTracker  DocumentRegistry  ComplianceEngine  LetterOfCredit
                                                              | reads        | escrows
                                                              +--------------+--> TradeUSD
```

Companion contracts accept state changes **only from the core** (`onlyCore`) and expose public
views, so the DApp interacts with a single address while six contracts are deployed.
`ShipmentTracker` is also the ERC-721 document of title (`tokenId == shipmentId`); `_update` rejects
every externally initiated ERC-721 transfer, so the holder cannot move the title — only the core's
`transferTitle` does, at the settlement milestone.

### 3.2 Roles

`AccessControl`, granted by the admin via `grantRoles(bytes32[], address[])`:

| Role | Typical holder |
|------|----------------|
| `ROLE_EXPORTER` | Exporter / seller |
| `ROLE_IMPORTER` | Importer / buyer |
| `ROLE_BANK` | Issuing / advising bank |
| `ROLE_LOGISTICS` | Carrier / freight forwarder |
| `ROLE_VERIFIER` | Inspection body, insurer, customs (authorised address) |
| `DEFAULT_ADMIN_ROLE` | Administrator / deployer |

### 3.3 Document types & anchor authority

| `DocType` | Index | Designated anchor role | Anchored at |
|-----------|:-----:|------------------------|-------------|
| `CommercialInvoice` | 0 | Exporter | `createShipment` |
| `PackingList` | 1 | Exporter | `createShipment` |
| `CertificateOfOrigin` | 2 | Exporter | `anchorDocument` |
| `InspectionCertificate` | 3 | Verifier | `anchorDocument` |
| `InsuranceCertificate` | 4 | Verifier | `anchorDocument` |
| `BillOfLadingOrAWB` | 5 | Logistics | `confirmVesselLoading` |
| `CustomsClearance` | 6 | Verifier | `anchorDocument` |

Anchors are **anchor-once-then-lock**; a CID can never be replaced. The issuer (or the admin) may
**revoke** a document, which invalidates it at compliance time.

### 3.4 Shipment lifecycle (state machine)

```
  createOrder()      createShipment()        openLetterOfCredit()
  ─────────────► Created ──────────────────► LCFunded ──confirmPickup()──► PickedUp
                 (importer)   (exporter)       (importer)   EXW ⇒ payout        │
                                                                                │ confirmVesselLoading(blCid)
                                                                                ▼
                        Delivered ◄──── confirmFinalDelivery() ──────────── LoadedOnVessel
                        (DDP ⇒ payout)      (importer / bank)   (FOB / CIF ⇒ payout)
                             │
                             ▼
                          Settled

  LCFunded + deadline passed + never shipped:  reclaimExpiredLC() ──► Reclaimed
```

- `Settled` = payout complete **and** title transferred.
- `Reclaimed` is terminal: the importer's escrow is returned because the exporter never shipped.
- `riskHolder` starts at the exporter and moves to the importer at the risk-transfer milestone.

### 3.5 Incoterm settlement & document matrix

`ComplianceEngine.requiredMask(term, phase)` is evaluated on every transition and again at payout.

| Incoterm | Risk transfers | Payout trigger | Mandatory documents at payout |
|----------|----------------|----------------|-------------------------------|
| **EXW** | at pickup | `confirmPickup` → `PickedUp` | Invoice + PackingList |
| **FOB** | on vessel | `confirmVesselLoading` → `LoadedOnVessel` | + Inspection + BillOfLading |
| **CIF** | on vessel | `confirmVesselLoading` → `LoadedOnVessel` | + Inspection + BillOfLading + Insurance |
| **DDP** | at destination | `confirmFinalDelivery` → `Delivered` | + Inspection + BillOfLading + CertificateOfOrigin + CustomsClearance **and duty paid** |

Payout is **100 % of the escrowed L/C amount**, transferred atomically to the exporter under a
strict checks-effects-interactions pattern guarded by `nonReentrant`.

### 3.6 End-to-end flow

```
Importer   createOrder(exporter, term, lcAmount, deadline)
Exporter   createShipment(orderId, invoiceCID, packingCID)      → title NFT minted (escrow)
Importer   openLetterOfCredit(id)                                → TradeUSD escrowed
Verifier   anchorDocument(id, CertificateOfOrigin | Inspection | Insurance | Clearance, cid)
Logistics  confirmPickup(id)
Logistics  confirmVesselLoading(id, blCid)                       → anchors B/L, sets title URI
Exporter   payCustomsDuty(id, amount)   (DDP; 0 allowed)
Importer   confirmFinalDelivery(id)                              → transfers title, DDP payout
Importer/Bank/Admin  reclaimExpiredLC(id)                        → after deadline, if never shipped
Bank       forceFinalizeDelivery(id)                             → if the importer withholds
```

## 4. Repository Structure

```
.
├── contracts/
│   ├── TradeChainCore.sol              # coordinator, AccessControl, single entry point
│   ├── core/
│   │   ├── ShipmentTracker.sol         # orders, shipments, phase/milestones + e-B/L ERC-721
│   │   ├── DocumentRegistry.sol        # CID anchors + verification status
│   │   ├── ComplianceEngine.sol        # Incoterm-aware required-document rules
│   │   └── LetterOfCredit.sol          # escrow, settlement, duty, reclaim
│   ├── tokens/
│   │   └── TradeUSD.sol                # ERC-20 stablecoin (role-gated mint)
│   ├── libraries/TradeTypes.sol        # shared enums/structs
│   └── mocks/MaliciousReentrancy.sol   # adversarial settlement token (tests only)
├── test/                               # 84-test Hardhat suite
│   ├── helpers/fixture.js
│   ├── Order.test.js · DocumentRegistry.test.js · ComplianceEngine.test.js
│   ├── Incoterms.e2e.test.js · Neutrality.test.js · AccessControl.test.js
│   ├── Modules.test.js · Reentrancy.test.js · Tokens.test.js · Views.test.js
├── scripts/
│   ├── deploy.js                       # deploy + wire the six contracts + roles
│   ├── seed-demo.js                    # drive a full EXW→FOB→CIF→DDP demo
│   ├── verify.js                       # Etherscan verification helper
│   ├── ipfs-add.js                     # upload to a role's kubo node → CIDv1
│   └── ipfs-pin.js                     # keep a counterparty's own copy of a CID
├── dapp/                               # React (Vite) + ethers v6 + MetaMask dashboard
│   └── src/ipfs.js · src/App.jsx       # upload + document-viewer (retrieve by CID from a node)
├── docs/
│   ├── ARCHITECTURE.md · DESIGN_DECISIONS.md · SECURITY.md
│   ├── IPFS_CONSORTIUM.md              # per-role nodes, upload/retrieve flow
│   ├── REFACTOR_PLAN.md                # 6-contract restructure plan
│   ├── PROPOSAL_UPDATES.md             # proposal ↔ implementation mapping
│   └── diagrams/TradeChain.drawio      # architecture diagram (+ PNG used in the proposal)
├── deployments/                        # deployment records (Sepolia committed; localhost ignored)
├── .github/workflows/ci.yml
├── hardhat.config.js · .solhint.json · slither.config.json · .solcover.js
├── CHANGES.md                          # change history + open clarifications
└── README.md
```

## 5. Technology Stack

| Technology | Purpose | Rationale |
|------------|---------|-----------|
| **Solidity `^0.8.24`** (compiled 0.8.28 / Cancun) | Smart contracts | Custom errors, packed structs, checked arithmetic. |
| **Hardhat + Mocha/Chai + `solidity-coverage` + `hardhat-gas-reporter`** | Tests, coverage, gas | De-facto standard local EVM suite. |
| **OpenZeppelin Contracts v5** | `ERC721URIStorage`, `ERC20`, `AccessControl`, `ReentrancyGuard`, `SafeERC20` | Audited building blocks. |
| **IPFS — one node per participant** | Off-chain documents + certificate metadata | Each role keeps its own copy; any involved party reads a document by CID through the DApp. Only CIDs reach the chain. Hosted Pinata only as a convenience. |
| **Slither & Solhint** | Static analysis | Automatic detection of reentrancy/access-control issues. |
| **GitHub Actions CI** | Compile + test + coverage + Slither | Citable evidence for the security/coverage criteria. |
| **React (Vite) + Ethers.js v6 + MetaMask** | Role dashboard | Wallet-connect stack; uploads to a role's kubo node, reads documents back by CID, triggers core workflows. |
| **Ethereum Sepolia Testnet** | Deployment + Etherscan verification | Public, verifiable end-to-end demo. |

## 6. Getting Started

### Prerequisites
- Node.js ≥ 18 (developed on Node 26) · npm
- (optional) [Slither](https://github.com/crytic/slither) via `pipx install slither-analyzer`
- (optional) [kubo (IPFS)](https://docs.ipfs.tech/install/) for local document upload/retrieval
- (optional) a Sepolia RPC URL + funded deployer key (see `.env.example`)

### Install, compile, test

```bash
npm install
npx hardhat compile
npx hardhat test                     # 84 passing
npx hardhat coverage                 # 100 % stmts · 92.74 % branch · 100 % funcs · 100 % lines
npm run gas                          # optional gas report
```

### Lint & static analysis

```bash
npx solhint "contracts/**/*.sol"
pipx run slither . --config-file slither.config.json
```

### Deploy & verify on Sepolia

```bash
cp .env.example .env             # fill SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY
npx hardhat run scripts/deploy.js --network sepolia
npx hardhat run scripts/verify.js  --network sepolia
```

> Verification uses a single **Etherscan V2** API key (`etherscan.apiKey`). The previous
> per-network key map is deprecated.
> Set role wallets (optional, distinct addresses) with `TRADECHAIN_EXPORTER` … `TRADECHAIN_VERIFIER`
> before deploying; otherwise every role defaults to the deployer on a single-account network.

### React DApp

```bash
npx hardhat node                                              # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # copy the core address
cd dapp && npm install && npm run dev                         # terminal 2 → http://localhost:5173
```

Paste the core address, choose a role account, and walk the numbered panels. See
[`dapp/README.md`](./dapp/README.md).

### Off-chain documents (per-role IPFS)

Each role runs its own kubo node and keeps its own copy; the DApp's **IPFS node** field targets the
active role's node for **upload** and for **retrieval** (Document viewer):

```bash
node scripts/ipfs-add.js path/to/invoice.pdf                                 # default node (:5001)
node scripts/ipfs-add.js path/to/invoice.pdf --api /ip4/127.0.0.1/tcp/5011   # a specific role node
ipfs cat bafy... --api /ip4/127.0.0.1/tcp/5011                               # read from a role node
node scripts/ipfs-pin.js bafy... --api /ip4/127.0.0.1/tcp/5011               # keep your own copy
node scripts/ipfs-add.js path/to/invoice.pdf --pinata                        # optional hosted
```

See [`docs/IPFS_CONSORTIUM.md`](./docs/IPFS_CONSORTIUM.md) for per-role node setup and the
upload/retrieve flow.

## 7. Sepolia Deployment (verified)

Deployed and verified on **Ethereum Sepolia** (chainId 11155111); record in
[`deployments/sepolia.json`](./deployments/sepolia.json). Every contract's source is published on
Etherscan (append `#code` to each address).

| Contract | Address |
|----------|---------|
| `TradeChainCore` | [`0x2975F0E166A15e13dFb64efD6d55578DEef861Be`](https://sepolia.etherscan.io/address/0x2975F0E166A15e13dFb64efD6d55578DEef861Be#code) |
| `ShipmentTracker` (e-B/L ERC-721) | [`0x9f85F3dca79BEEC07Fb50350637d1AA181BBF926`](https://sepolia.etherscan.io/address/0x9f85F3dca79BEEC07Fb50350637d1AA181BBF926#code) |
| `DocumentRegistry` | [`0xFf79f12350DD6061A36d7268f5Ccb51764caA301`](https://sepolia.etherscan.io/address/0xFf79f12350DD6061A36d7268f5Ccb51764caA301#code) |
| `ComplianceEngine` | [`0xC62187D99Fd6115eE8010d263230e305907b4ca5`](https://sepolia.etherscan.io/address/0xC62187D99Fd6115eE8010d263230e305907b4ca5#code) |
| `LetterOfCredit` | [`0x980A395218D6349a501508e4264b8b868c6F42AA`](https://sepolia.etherscan.io/address/0x980A395218D6349a501508e4264b8b868c6F42AA#code) |
| `TradeUSD` (ERC-20) | [`0x1a2372BAEfb7bF6F50cafE08cc62EB32BB327ac4`](https://sepolia.etherscan.io/address/0x1a2372BAEfb7bF6F50cafE08cc62EB32BB327ac4#code) |

Deployer: `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664`.

## 8. Step-by-step Verification Walkthrough

Run these later to confirm every claim. Each step lists the expected result.

### A. Local build, tests, coverage

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat coverage
npx solhint "contracts/**/*.sol"
```

- [ ] `compile` → `Compiled 37 Solidity files successfully`
- [ ] `test` → `84 passing`
- [ ] `coverage` → **100 % statements · 92.74 % branch · 100 % functions · 100 % lines** (mocks excluded)
- [ ] `solhint` → no errors

### B. Local end-to-end demo (all four Incoterms)

```bash
npx hardhat node                                              # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # terminal 2
npx hardhat run scripts/seed-demo.js --network localhost
```

- [ ] `seed-demo` prints the `EXW`, `FOB`, `CIF`, `DDP` flows and ends with
      `All four Incoterm flows completed.`
- [ ] For each flow the final line is `title NFT owner: 0x…` = the importer's address
- [ ] `EXW` settles at `PickedUp`, `FOB`/`CIF` at `LoadedOnVessel`, `DDP` at `Delivered`

### C. React DApp

```bash
cd dapp && npm install && npm run dev     # http://localhost:5173
```

- [ ] Paste the local `TradeChainCore` address → **Connect / Load**
- [ ] Panel 1 → `createOrder` then `createShipment`
- [ ] Panel 2 → `openLetterOfCredit`, anchor certificates, upload a file (CID fills in)
- [ ] Panel 3 → milestones; **Shipment viewer** shows phase + document flags
- [ ] **Document viewer** → open an anchored CID from the node that holds it

### D. Off-chain documents (per-role IPFS)

```bash
# start one kubo daemon per role (distinct API ports), or a single node for a quick check
node scripts/ipfs-add.js ./some.pdf --api /ip4/127.0.0.1/tcp/5001     # issuing role uploads
ipfs cat <cid> --api /ip4/127.0.0.1/tcp/5011                          # another role reads it
```

- [ ] The CID produced on one node is readable from another node (or through the DApp viewer)
- [ ] The same bytes always produce the same CID (content addressing)

### E. Sepolia (already deployed & verified — re-check any time)

```bash
npx hardhat run scripts/verify.js --network sepolia
```

- [ ] All six contracts show `Successfully verified contract <Name> on the block explorer`
- [ ] The addresses in [§7](#7-sepolia-deployment-verified) open with `#code` on Sepolia Etherscan

### F. Objective → evidence map

| Objective | Where it is evidenced |
|-----------|-----------------------|
| OBJ-1 | §8-B (title owner = importer); §8-A (`DocumentRegistry`/lock tests); §3.3 |
| OBJ-2 | §8-A (`AccessControl.test.js` matrix); §9 threat table |
| OBJ-3 | §8-B (four Incoterm flows, DDP duty gate); §3.5 |
| OBJ-4 | §7 + §8-E (all six verified); §8-A coverage; §11 CI |

## 9. Security Considerations

| Risk | Attack / failure scenario | Mitigation | Validation |
|------|---------------------------|------------|------------|
| **Documentary fraud** | Payout without a mandatory document; CID replaced after funding | Per-milestone `requireCompliant`; `DocumentRegistry` anchor-once-then-lock | Negative tests assert `MissingMandatoryDocument` / `DocumentLocked` |
| **Unauthorized attestation** | Exporter self-signs a certificate | Certificates anchor only through the per-`DocType` role check | Access-control matrix test |
| **Unauthorized title transfer** | Holder endorses/moves the e-B/L before settlement | `ShipmentTracker._update` rejects every public ERC-721 transfer; only the core can `transferTitle` | `Tokens.test.js` (public `transferFrom` reverts) |
| **Reentrancy** | Malicious ERC-20 callback / ERC-721 receiver hook re-enters settlement | `nonReentrant` on `LetterOfCredit.settle`/`refund` + strict CEI + `SafeERC20` | `Reentrancy.test.js` (adversarial token pays out exactly once) |
| **Settlement stall** | Importer withholds delivery; exporter never ships | Deadline reclaim (importer/bank/admin); either **bank** can `forceFinalizeDelivery` | `Neutrality.test.js` |
| **Revoked attestation** | Verifier revokes a relied-upon certificate | `DocumentRegistry.revoke` clears `verified`; checked at compliance time | `DocumentRegistry` revocation tests |
| **Unauthorized milestone** | Wrong role advances the shipment / mints tokens | `onlyRole` + per-shipment importer/exporter checks | `AccessControl.test.js` |
| **Stablecoin inflation** | Anyone mints `TradeUSD` | `mint` is `MINTER_ROLE`-gated (core/admin only) | `Tokens.test.js` |

## 10. Testing & Coverage

| Category | Representative scenario | Evidence |
|----------|-------------------------|----------|
| Happy-path E2E | Full flow per Incoterm incl. certificate anchors and the DDP clearance gate | Payout at the exact milestone; title transfers to the importer |
| Negative & boundary | Omit each required document; insufficient allowance; empty CID; duplicate anchoring; unauthorized anchors | Deterministic custom-error reverts |
| Neutrality & timeout | Reclaim only after expiry; force-finalize; per-bank release | No single party can stall settlement |
| Access control | Exhaustive role × function matrix | `Unauthorized` / `AccessControlUnauthorizedAccount` |
| Modules | Internal guards reached directly (funding/duty/settlement ordering, reclaim window) | `Modules.test.js` |
| Security | Adversarial settlement token; Slither + coverage in CI | Single payout; no High findings |

Current result: **84 tests passing · 100 % statements · 92.74 % branches · 100 % functions ·
100 % lines** (mocks excluded via `.solcover.js`).

## 11. CI / Static Analysis

`.github/workflows/ci.yml` runs on every push / PR: `npm ci` → compile → `solhint` → `hardhat test`
→ `hardhat coverage` (artifact) → Slither (`--fail-high`). Slither appears because it appears in the
security criteria and its report is retained as a build artifact.

## 12. Roadmap & Progress Log

| Phase | Activities | Deliverable | Status |
|-------|------------|-------------|--------|
| **Phase 1** | Develop the six contracts + tests | Compiling, tested suite | ✅ done |
| **Phase 2** | Security review, adversarial tests, coverage | ≥ 90 % branch coverage, Slither report | ✅ done (100 % stmts / 92.74 % branch) |
| **Phase 3** | Sepolia deploy + verify, React DApp, demo video, report | Verified contracts, DApp, report | 🟡 **deploy + verify done**; video/report pending |

Progress log: see `git log --oneline` and [`CHANGES.md`](./CHANGES.md).

## 13. Proposal Updates & Design Decisions

- [`docs/PROPOSAL_UPDATES.md`](./docs/PROPOSAL_UPDATES.md) — proposal ↔ implementation mapping.
- [`docs/REFACTOR_PLAN.md`](./docs/REFACTOR_PLAN.md) — the restructure design.
- [`docs/DESIGN_DECISIONS.md`](./docs/DESIGN_DECISIONS.md) · [`docs/SECURITY.md`](./docs/SECURITY.md).
- [`CHANGES.md`](./CHANGES.md) — change history and open clarifications.

## 14. References

1. W. Entriken, D. Shirley, J. Evans, N. Sachs, "EIP-721: Non-Fungible Token Standard," 2018.
2. OpenZeppelin, "OpenZeppelin Contracts Documentation (v5.x)," 2024.
3. Nomic Foundation, "Hardhat Documentation," 2024.
4. Protocol Labs, "IPFS Documentation — Content Addressing and CIDs," 2024.
5. J. Feist, G. Grieco, A. Groce, "Slither: A Static Analysis Framework For Smart Contracts," WETSEB, 2019.
6. International Chamber of Commerce (ICC), *Incoterms® 2020 Rules*, ICC Publication No. 723E, 2020.

## 15. License

Released under the [MIT License](./LICENSE).
