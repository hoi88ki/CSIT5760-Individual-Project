# TradeChain — A Decentralized International Trade & Document Tracker

> **CSIT5760 Blockchain and Smart Contracts — Individual Project**
> Student: YUNG HOI KI (21232072) · Instructor: Pritom Rajkhowa · Network: **Ethereum Sepolia Testnet**
> Repository: `https://github.com/hoi88ki/CSIT5760-Individual-Project`

TradeChain is an on-chain documentary trade-finance and supply-chain tracker built as **six
modular smart contracts**. It stores trade documents on **IPFS** (one kubo node per participant)
and verifies only their **CIDs** plus the **issuer's role** on **Ethereum**. Importers (L/C
applicants), **issuing banks**, exporters (beneficiaries), logistics providers, verifiers and the
administrator interact through **role-gated** contracts that model a **bank-issued documentary
credit**: application → issuance & escrow prefunding → shipment → presentation → examination →
honor (sight or deferred), with risk transfer and title release following the chosen Incoterm
(EXW / FOB / CIF / DDP).

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
- **The credit is issued by a bank.** The importer is the **applicant**: it applies for a credit
  naming the beneficiary, the Incoterm and the payment terms (sight or deferred). The **issuing
  bank** issues the credit against that application and prefunds the `TradeUSD` escrow — the
  named exporter can ship only after the credit is issued and operative.
- **Payment follows presentation, not milestones.** The beneficiary presents the stipulated
  documents; the bank examines them against the credit's documentary terms and the on-chain
  CID/verification state and honors a complying presentation — at sight, or after the agreed
  deferral. Expired, unused credits return to the issuing bank.
- **Risk still follows the Incoterm.** Custody milestones (pickup → vessel → delivery) move risk
  (EXW: pickup, FOB/CIF: vessel, DDP: delivery) and gate the documentary readiness of the goods,
  but they never trigger payment.
- **The e-B/L is represented on-chain.** It is an **ERC-721 document of title** owned by
  `ShipmentTracker` (one token per trade, `tokenId == trade id`) and initially escrowed by the
  core. Public token transfers are blocked; the core releases title to the importer at final
  delivery (or back to the exporter when an unused expired credit is reclaimed).

## 2. Objectives

| ID | Objective | Success criterion |
|----|-----------|-------------------|
| **OBJ-1** | Document registry + e-B/L token | Each document type is anchored by its designated role; anchored CIDs cannot be silently replaced; public title-token transfers are blocked and the token is released to the importer only at final delivery. |
| **OBJ-2** | Role-based access control | Every privileged function reverts for accounts lacking the required role (the bank issues, examines and honors; only the named beneficiary ships and presents); an access-control matrix test passes. |
| **OBJ-3** | Incoterm-aware tracking & settlement | The credit's stipulated document set and custody gates follow the Incoterm; DDP blocks honor until clearance + duty; risk transfers at the Incoterm milestone independently of payment. |
| **OBJ-4** | Deploy, test & verify | Contracts deployed and source-verified (see [§7](#7-sepolia-deployment-verified)); ≥ 90 % branch coverage; 0 High Slither findings; positive/negative/boundary tests passing. |

## 3. System Architecture

### 3.1 Contract map (6 contracts + 1 type library)

| # | Component | Type | Responsibility |
|---|-----------|------|----------------|
| 1 | `TradeChainCore` | concrete (coordinator) | `AccessControl` role authority + single user entry point; deploys/wires the companions; holds the modules' own access control; owns the swappable `DocumentRegistry`; orchestrates the credit workflow (application → issuance → shipment → presentation → honor) and custody. |
| 2 | `LetterOfCredit` | module | Documentary-credit state machine: bank issuance & `TradeUSD` escrow prefunding, presentation, examination honor (sight/deferred), deferred draw, duty, expiry reclaim to the bank. |
| 3 | `ShipmentTracker` | module + ERC-721 | Applications (orders) + trade records — one shared id — with the credit lifecycle `Phase`, goods `Custody`, risk holder and e-B/L title token (`tokenId == trade id`); only the core moves the title. |
| 4 | `ComplianceEngine` | view module | Incoterm-aware rules: custody-gate masks and the stipulated presentation set; resolves the registry that holds each anchor. |
| 5 | `DocumentRegistry` | module | Per-`(trade, DocType)` CID anchors, verification status, anchor-once-then-lock; **swappable** by the admin or `ROLE_REGISTRY_ADMIN`. |
| 6 | `TradeUSD` | ERC-20 | Settlement stablecoin with **role-gated** minting. |

`contracts/libraries/TradeTypes.sol` holds the shared enums/structs (inlined, not deployed).

**How they connect**

```
                    +----------------------- TradeChainCore (AccessControl) -----------------------+
   roles grant ---> |  ROLE_EXPORTER · IMPORTER · BANK · LOGISTICS · VERIFIER · REGISTRY_ADMIN      |
                    |                (+ DEFAULT_ADMIN · setModuleRole · setDocumentRegistry)        |
                    +------+---------------+----------------+---------------+-----------+-----------+
                           | CONTROLLER    | CONTROLLER     | view          | CONTROLLER
                           v               v                v               v
                     ShipmentTracker  DocumentRegistry  ComplianceEngine  LetterOfCredit
                      (+ ERC-721 title)   (swappable)        | reads        | escrows
                                                             +--------------+--> TradeUSD
```

Companion contracts accept state changes **only from the core** — their mutators are gated by a
`CONTROLLER_ROLE` that only the core holds, and that role is administered by the core's own
`AccessControl` (`setModuleRole`) — and they expose public views, so the DApp interacts with a single
address while six contracts are deployed.
`ShipmentTracker` is also the ERC-721 document of title (`tokenId == shipmentId`); `_update` rejects
every externally initiated ERC-721 transfer, so the holder cannot move the title — only the core's
`transferTitle` does, at the settlement milestone.

### 3.2 Roles

`AccessControl`, granted by the admin via `grantRoles(bytes32[], address[])`:

| Role | Typical holder |
|------|----------------|
| `ROLE_EXPORTER` | Exporter / beneficiary of the credit |
| `ROLE_IMPORTER` | Importer / L/C applicant |
| `ROLE_BANK` | **Issuing bank** (issues, prefunds, examines, honors) |
| `ROLE_LOGISTICS` | Carrier / freight forwarder |
| `ROLE_VERIFIER` | Inspection body, insurer, customs (authorised address) |
| `ROLE_REGISTRY_ADMIN` | The party allowed to replace the active `DocumentRegistry` |
| `DEFAULT_ADMIN_ROLE` | Administrator / deployer |

Each companion module also carries its own `AccessControl` **mounted on the core**: the core is
granted `DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE` on `ShipmentTracker`, `DocumentRegistry`,
`LetterOfCredit` and `TradeUSD` (and the admin role on the read-only `ComplianceEngine`), so the
modules' writers are administered from this single authority via `TradeChainCore.setModuleRole`.

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

### 3.3.1 Swappable `DocumentRegistry`

The active registry is **not hard-wired**: `TradeChainCore.setDocumentRegistry(address)` replaces it,
and only `DEFAULT_ADMIN_ROLE` or `ROLE_REGISTRY_ADMIN` may call it. Two guards keep the swap safe:

- the replacement must be a `DocumentRegistry` **bound to this core** (`registry.core() == core`), and
- its runtime code must **match the deployment-time registry** (`extcodehash` check), so a look-alike
  contract cannot forge `isValid` and fake compliance.

The registry used for each anchor is **snapshotted** per `(shipment, DocType)`, so replacing the
registry never orphans documents that are already anchored: `ComplianceEngine` resolves the registry
that actually holds each anchor through the core, and in-flight shipments keep settling.

### 3.4 Credit & custody lifecycle (two state dimensions)

```
 createOrder()          issueLetterOfCredit()      createShipment()       presentDocuments()
 ──────────────► OrderPlaced ──────────────► LCIssued ──────────────► Shipped ───────────► Presented
 (importer       (bank issues +              (named exporter          (beneficiary;
  applies)        prefunds escrow)            ships; docs anchored)    stipulated set)
                                                                                            │
                                                    honorPresentation() (bank examines)     │
                                                    sight ⇒ pays now · deferred ⇒ maturity  ▼
                                                                                       Honored
                                                                                            │
        Reclaimed ◄── reclaimExpiredLC()        Delivered ◄── confirmFinalDelivery() ───────┤
      (expired, unused                          (importer/bank; title released)             │
       credit → bank)                                  │                                    │
                                                       ▼                                    │
                                                    Settled ◄───────────────────────────────┘
                                              (honored/paid AND delivered)

 custody (goods):  AtExporter ─confirmPickup─► PickedUp ─confirmVesselLoading─► OnVessel ──► Delivered
 risk (Incoterm):  EXW → importer at pickup · FOB/CIF → importer on vessel · DDP → importer at delivery
```

- `Settled` = the credit has paid **and** custody is delivered. Payment and delivery can happen in
  either order; whichever completes last settles the trade.
- `Reclaimed` is terminal: an expired, **unused** credit returns its escrow to the issuing bank. If
  the beneficiary had shipped but never presented, the escrowed title returns to the exporter.
- A recorded presentation is "use": the credit can then only be honored (or refused off-chain),
  never reclaimed.
- Deferred credits: `honor` schedules `maturityAt = honoredAt + deferredDays`; anyone can call
  `drawDeferredPayment` at maturity.

### 3.5 Incoterm documentary matrix

`ComplianceEngine` derives two document sets from the Incoterm: the **custody gates**
(`requiredMask(term, custody)`, evaluated at pickup/loading/delivery) and the **stipulated
presentation set** (`presentationMask(term)` — the same full requirement per Incoterm, recorded on
the credit at issuance and re-examined by the bank before honoring).

| Incoterm | Risk transfers | Stipulated presentation set (bank examines) |
|----------|----------------|---------------------------------------------|
| **EXW** | at pickup | Invoice + PackingList + BillOfLading |
| **FOB** | on vessel | + InspectionCertificate |
| **CIF** | on vessel | + InspectionCertificate + InsuranceCertificate |
| **DDP** | at destination | + InspectionCertificate + BillOfLading + CertificateOfOrigin + CustomsClearance **and duty paid** |

Honor transfers **100 % of the escrowed credit** to the beneficiary under a strict
checks-effects-interactions pattern guarded by `nonReentrant` (the escrow was prefunded by the bank
at issuance, so the undertaking is deterministic).

### 3.6 End-to-end flow

```
Importer   createOrder(exporter, term, lcAmount, deadline, sight|deferred)   → application (no funds move)
Bank       issueLetterOfCredit(orderId)                                     → TradeUSD escrowed BY THE BANK,
                                                                            documentary terms recorded → operative
Exporter   createShipment(orderId, invoiceCID, packingCID)                  → only after issuance; title NFT minted (escrow)
Verifier   anchorDocument(id, CertificateOfOrigin | Inspection | Insurance | Clearance, cid)
Logistics  confirmPickup(id)                          → custody; EXW risk transfer (no payment)
Logistics  confirmVesselLoading(id, blCid)            → anchors B/L, sets title URI; FOB/CIF risk (no payment)
Exporter   payCustomsDuty(id, amount)   (DDP; 0 allowed) — before the bank honors
Exporter   presentDocuments(id)                       → records the presentation (compliance-checked, pre-expiry)
Bank       honorPresentation(id)                      → examines; sight pays now, deferred schedules maturity
Anyone     drawDeferredPayment(id)                    → after maturity (deferred credits)
Importer   confirmFinalDelivery(id)                   → releases title; Settled when paid
Importer/Bank/Admin  reclaimExpiredLC(orderId)        → expired UNUSED credit returns to the issuing bank
Bank       forceFinalizeDelivery(id)                  → if the importer withholds after loading
```

## 4. Repository Structure

```
.
├── contracts/
│   ├── TradeChainCore.sol              # coordinator, AccessControl, single entry point
│   ├── core/
│   │   ├── ShipmentTracker.sol         # applications/trades, credit phase × custody + e-B/L ERC-721
│   │   ├── DocumentRegistry.sol        # CID anchors + verification status
│   │   ├── ComplianceEngine.sol        # Incoterm-aware required-document rules
│   │   └── LetterOfCredit.sol          # bank-issued credit: escrow, presentation honor, duty, reclaim
│   ├── tokens/
│   │   └── TradeUSD.sol                # ERC-20 stablecoin (role-gated mint)
│   ├── libraries/TradeTypes.sol        # shared enums/structs
│   └── mocks/MaliciousReentrancy.sol   # adversarial settlement token (tests only)
├── test/                               # 130-test Hardhat suite
│   ├── helpers/fixture.js
│   ├── Order.test.js · DocumentRegistry.test.js · ComplianceEngine.test.js
│   ├── Incoterms.e2e.test.js · Neutrality.test.js · AccessControl.test.js
│   ├── RegistrySwap.test.js · Modules.test.js · Reentrancy.test.js · Tokens.test.js · Views.test.js
├── scripts/
│   ├── deploy.js                       # deploy + wire the six contracts + roles
│   ├── smoke.js                        # post-deployment check: one full sight credit on the live core
│   ├── seed-demo.js                    # drive the credit workflow: issue → ship → present → honor → deliver
│   ├── verify.js                       # Etherscan verification helper
│   ├── ipfs-add.js                     # upload to a role's kubo node → CIDv1
│   └── ipfs-pin.js                     # keep a counterparty's own copy of a CID
├── dapp/                               # React (Vite) + ethers v6 + MetaMask dashboard
│   └── src/ipfs.js · src/App.jsx       # upload + document-viewer (retrieve by CID from a node)
├── ui/                                 # single-file HTML/JS console (no build step)
│   └── index.html                      # credit/custody stepper, flow guide, all workflow/admin actions
├── docs/
│   ├── FRONTENDS.md                    # MetaMask setup, account/network behavior, troubleshooting
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
npx hardhat test                     # 130 passing
npx hardhat coverage                 # 100 % stmts · 98.76 % branch · 100 % funcs · 100 % lines
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

A step-by-step **multi-account simulation of the whole L/C workflow** (application → bank issuance
→ shipment → presentation → honor → delivery, plus deferred maturity and expiry reclaim) is in
[`docs/FRONTENDS.md`](./docs/FRONTENDS.md).
```

Paste the `TradeChainCore` address and click **Connect MetaMask / Load**. MetaMask prompts for
account access; select an account that has the role required for the action, and confirm the network
matches the deployment. The app listens for account/network changes. If MetaMask is unavailable, the
configured JSON-RPC endpoint is used (Hardhat exposes unlocked local accounts; other endpoints are
normally read-only). See [`dapp/README.md`](./dapp/README.md) and the [frontend guide](./docs/FRONTENDS.md).

### Plain HTML console (`ui/`) — no build step

A single-file dashboard that walks the **whole credit workflow**: credit/custody stepper, a
per-Incoterm flow guide ticked off against on-chain state, document table with validity/issuer/CID,
L/C viewer (issuing bank, beneficiary, presentation/honor state, maturity), title-NFT viewer, and
`setModuleRole`).

```bash
npx hardhat node                                        # terminal 1 (optional, local demo)
npx hardhat run scripts/deploy.js --network localhost
python -m http.server 8090                              # terminal 2  (or: npx serve)
# open http://127.0.0.1:8090/ui/index.html
```

- Opens pre-set to the verified Sepolia deployment without opening a wallet permission prompt. It
  uses a previously authorized MetaMask account if one exists; otherwise it is read-only. Click
  **Connect wallet** to authorize MetaMask for transactions, then choose the active authorized account
  from the header menu (or use the test-only in-memory key only with a local Hardhat node). Account and
  network changes are reflected by the console.
- `ethers` is vendored locally (`ui/ethers.umd.min.js`), so it also works offline.
- Transactions are queued, so clicking two actions in quick succession cannot race on the nonce.

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

Deployed and **source-verified** on **Ethereum Sepolia** (chainId 11155111) on **25 November 2026** —
all six contracts of the bank-issued documentary-credit suite; record in
[`deployments/sepolia.json`](./deployments/sepolia.json). Every contract's source is published on
Etherscan (append `#code` to each address).

| Contract | Address |
|----------|---------|
| `TradeChainCore` | [`0xCcE6bd88756759B8A02318a61d37e15BB1781520`](https://sepolia.etherscan.io/address/0xCcE6bd88756759B8A02318a61d37e15BB1781520#code) |
| `ShipmentTracker` (e-B/L ERC-721) | [`0x377fe5827EEa210e8AF670E7D61196F75f371feF`](https://sepolia.etherscan.io/address/0x377fe5827EEa210e8AF670E7D61196F75f371feF#code) |
| `DocumentRegistry` (swappable) | [`0x6115942cc4573eC2690EEC4546166a8714595FC8`](https://sepolia.etherscan.io/address/0x6115942cc4573eC2690EEC4546166a8714595FC8#code) |
| `ComplianceEngine` | [`0x343DFC53883256DB9441387CCfC5aa4BFe0d164e`](https://sepolia.etherscan.io/address/0x343DFC53883256DB9441387CCfC5aa4BFe0d164e#code) |
| `LetterOfCredit` | [`0xCC67ec9baed27A00f0f1DD7AaBEa194fcbeb8abd`](https://sepolia.etherscan.io/address/0xCC67ec9baed27A00f0f1DD7AaBEa194fcbeb8abd#code) |
| `TradeUSD` (ERC-20) | [`0xFf50c22D889C1D19F791565853c1FB4Ba4387475`](https://sepolia.etherscan.io/address/0xFf50c22D889C1D19F791565853c1FB4Ba4387475#code) |

Deployer: `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664`. In this demo deployment, the five
operational roles initially point to the deployer address (one account can play every party); the
admin can assign distinct wallets with `grantRoles`.

Creation transactions: `TradeUSD`
`0x6424e260a396ef74faeb00a0b66a61b76bd02a68f7e2d7469868c6b4e3c33f8f` (block 12207628) and
`TradeChainCore`
`0x87108ef9524d0125e283cab0140cc8e6278abfcd71c4456947fffb91e71d8399` (block 12207629) — the core's
transaction also created the four companion contracts in its constructor.

A post-deployment smoke test (`scripts/smoke.js`) drove one complete sight credit against this
deployment on-chain: application → bank issuance (25,000 tUSD escrowed) → shipment → custody (no
payment at milestones) → presentation → examination/honor (paid) → delivery → `Settled` with the
title released.

> The 22 November 2026 deployment
> ([archived record](./deployments/sepolia-2026-11-22.json)) predates this rework: its on-chain code
> still implements the earlier importer-funded escrow with milestone payouts and is kept only as
> historical evidence (superseding the 5 November 2026 suite,
> [archived record](./deployments/sepolia-2026-11-05.json)).

| Contract | Address |
|----------|---------|
| `TradeChainCore` | [`0x0372C1F622c6b46919a70a89EF85306565Eb98C5`](https://sepolia.etherscan.io/address/0x0372C1F622c6b46919a70a89EF85306565Eb98C5#code) |
| `ShipmentTracker` (e-B/L ERC-721) | [`0x41edc2FF37b7ce6Da9aD27d1aabDa703e2989539`](https://sepolia.etherscan.io/address/0x41edc2FF37b7ce6Da9aD27d1aabDa703e2989539#code) |
| `DocumentRegistry` (swappable) | [`0x9eCE26443f9647D1Cb715aB7971B5554a964695e`](https://sepolia.etherscan.io/address/0x9eCE26443f9647D1Cb715aB7971B5554a964695e#code) |
| `ComplianceEngine` | [`0x259684bb5c5b9198FffA4502248611C356844761`](https://sepolia.etherscan.io/address/0x259684bb5c5b9198FffA4502248611C356844761#code) |
| `LetterOfCredit` | [`0xdC6Ee51c61226CC0E42C76921e94C011196A0650`](https://sepolia.etherscan.io/address/0xdC6Ee51c61226CC0E42C76921e94C011196A0650#code) |
| `TradeUSD` (ERC-20) | [`0x2C262BE7C837E0236FC0346Ad70d6e86ECCb445d`](https://sepolia.etherscan.io/address/0x2C262BE7C837E0236FC0346Ad70d6e86ECCb445d#code) |

Deployer: `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664`. In this demo deployment, the five
operational roles initially point to the deployer address; the admin can assign distinct wallets with
`grantRoles`.

Creation transactions: `TradeUSD` `0x513ec4fc6d3cae33aa88b022dc31f087937c92cef53f62b3849c6b1209fc4509`
(block 12186124) and `TradeChainCore` `0x034ee59f424030c31e8d38f4c4ed41b94b9979f351b169fb2dfa62581851d4d3`
(block 12186125) — the core's transaction also created the four companion contracts in its constructor.

> This deployment supersedes the 5 November 2026 suite
> ([archived record](./deployments/sepolia-2026-11-05.json)); the earlier contracts implement the
> pre-swap registry design and are kept only as historical evidence.

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

- [ ] `compile` → `Compiled 39 Solidity files successfully`
- [ ] `test` → `130 passing`
- [ ] `coverage` → **100 % statements · 98.76 % branch · 100 % functions · 100 % lines** (mocks excluded)
- [ ] `solhint` → no errors

### B. Local end-to-end demo (all four Incoterms)

```bash
npx hardhat node                                              # terminal 1
npx hardhat run scripts/deploy.js --network localhost         # terminal 2
npx hardhat run scripts/seed-demo.js --network localhost
```

- [ ] `seed-demo` prints the `EXW`, `FOB`, `CIF`, `DDP` (sight) and `CIF` (deferred +3d) flows plus an
      expired-credit reclaim, ending with `All documentary-credit flows completed.`
- [ ] Each flow shows: application → L/C issued by the **bank** (escrow funded) → shipment → documents
      → custody (no payment at milestones) → presentation → examination/honor → delivery → `Settled`
- [ ] The deferred flow schedules the payout and draws it after maturity; the reclaim returns the
      funds to the issuing bank

### C. React DApp / HTML console

```bash
cd dapp && npm install && npm run dev     # http://localhost:5173
# or, without a build step:
python -m http.server 8090                # → http://127.0.0.1:8090/ui/index.html
```

- [ ] Paste the local `TradeChainCore` address → **Connect MetaMask / Load** (or connect to local RPC)
- [ ] As the **importer**: `createOrder` (application with sight/deferred terms)
- [ ] As the **bank**: approve TradeUSD, then `issueLetterOfCredit` (escrow funded by the bank)
- [ ] As the **exporter**: `createShipment` (refused before issuance), then `presentDocuments`
- [ ] As the **verifier/logistics**: anchor certificates, `confirmPickup`, `confirmVesselLoading`
- [ ] As the **bank**: `honorPresentation`; as the **importer**: `confirmFinalDelivery` → `Settled`
- [ ] **Shipment viewer** shows phase/custody + document flags; **Document viewer** opens a CID
- [ ] `ui/index.html` → the credit/custody stepper advances and the flow guide ticks each step off

A full click-by-click, multi-account walkthrough is in [`docs/FRONTENDS.md`](./docs/FRONTENDS.md).

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
npx hardhat run scripts/smoke.js  --network sepolia
```

- [ ] All six contracts show `Successfully verified contract <Name> on the block explorer`
- [ ] The addresses in [§7](#7-sepolia-deployment-verified) open with `#code` on Sepolia Etherscan
- [ ] `smoke.js` prints `SMOKE TEST PASSED`: one sight credit driven end-to-end on the live core
      (application → bank issuance → shipment → custody → presentation → honor → `Settled`)

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
| **Documentary fraud** | Honor without a mandatory document; CID replaced after issuance | Presentation compliance-checked, re-examined inside `LetterOfCredit.honor`; `DocumentRegistry` anchor-once-then-lock | Negative tests assert `MissingMandatoryDocument` / `DocumentLocked` |
| **Shipping without a credit** | The exporter ships before the bank has issued an operative credit | `createShipment` requires phase `LCIssued` and the named beneficiary | `Order.test.js`, `AccessControl.test.js` |
| **Unauthorized attestation** | Exporter self-signs a certificate | Certificates anchor only through the per-`DocType` role check | Access-control matrix test |
| **Unauthorized honor** | A non-bank (or the beneficiary) honors its own presentation | `honorPresentation` is bank-gated; the module re-checks compliance independently | `AccessControl.test.js`, `Modules.test.js` |
| **Unauthorized title transfer** | Holder endorses/moves the e-B/L before final delivery | `ShipmentTracker._update` rejects every public ERC-721 transfer; only the core can `transferTitle` | `Tokens.test.js` (public `transferFrom` reverts) |
| **Reentrancy** | Malicious ERC-20 callback / ERC-721 receiver hook re-enters settlement | `nonReentrant` on `LetterOfCredit.honor`/`drawDeferred`/`reclaim` + strict CEI + `SafeERC20` | `Reentrancy.test.js` (adversarial token pays out exactly once) |
| **Settlement stall** | Importer withholds delivery; bank stalls a deferred payout; exporter never ships | `forceFinalizeDelivery` (bank); permissionless `drawDeferredPayment` at maturity; expired unused credits reclaim to the issuing bank | `Neutrality.test.js` |
| **Revoked attestation** | Verifier revokes a relied-upon certificate | `DocumentRegistry.revoke` clears `verified`; presentation requires validity and the bank re-examines | `DocumentRegistry` revocation tests |
| **Stranded duty escrow** | Duty escrowed after the proceeds were released would never reach the treasury | `payCustomsDuty` reverts `LCAlreadySettled`; DDP duty must be paid before honor | `AccessControl.test.js` |
| **Unauthorized milestone** | Wrong role advances custody / mints tokens | `onlyRole` + per-trade beneficiary/importer checks | `AccessControl.test.js` |
| **Stablecoin inflation** | Anyone mints `TradeUSD` | `mint` is `MINTER_ROLE`-gated (core/admin only) | `Tokens.test.js` |
| **Forged compliance via a swapped registry** | A look-alike "registry" that answers `isValid == true` is swapped in, releasing the escrow with no documents | `setDocumentRegistry` requires a registry bound to this core *and* matching the deployment-time runtime codehash; only the admin or `ROLE_REGISTRY_ADMIN` may swap | `RegistrySwap.test.js` (`RegistryInvalidCode`) |
| **Orphaned documents after a registry swap** | Replacing the registry would hide previously anchored documents and stall in-flight trades | The core snapshots the registry per `(trade, DocType)`; `ComplianceEngine` resolves the registry that holds each anchor | `RegistrySwap.test.js` ("routes new anchors … while old anchors keep resolving") |

## 10. Testing & Coverage

| Category | Representative scenario | Evidence |
|----------|-------------------------|----------|
| Happy-path E2E | Full credit flow per Incoterm (sight and deferred) incl. certificate anchors, the DDP clearance/duty gate and delivery | Honor pays the beneficiary; title transfers to the importer; `Settled` |
| Negative & boundary | Ship before issuance; present before expiry/with a missing document; honor without duty; draw before maturity; insufficient allowance; empty CID; duplicate anchoring | Deterministic custom-error reverts |
| Neutrality & timeout | Reclaim (to the bank) only after expiry and only if unused; force-finalize; permissionless maturity draw | No single party can stall settlement |
| Access control | Exhaustive role × function matrix (bank issues/honors; only the beneficiary ships/presents) | `Unauthorized` / `AccessControlUnauthorizedAccount` |
| Modules | Internal guards reached directly (issuance/presentation/honor/draw/reclaim ordering, duty forwarding, reclaim window) | `Modules.test.js` |
| Security | Adversarial settlement token (sight honor and deferred draw); Slither + coverage in CI | Single payout; no High findings |

Current result: **130 tests passing · 100 % statements · 98.76 % branches · 100 % functions ·
100 % lines** (mocks excluded via `.solcover.js`).

## 11. CI / Static Analysis

`.github/workflows/ci.yml` runs on every push / PR: `npm ci` → compile → `solhint` → `hardhat test`
→ `hardhat coverage` (artifact) → Slither (`--fail-high`). Slither appears because it appears in the
security criteria and its report is retained as a build artifact.

## 12. Roadmap & Progress Log

| Phase | Activities | Deliverable | Status |
|-------|------------|-------------|--------|
| **Phase 1** | Develop the six contracts + tests | Compiling, tested suite | ✅ done (130 tests) |
| **Phase 2** | Security review, adversarial tests, coverage | ≥ 90 % branch coverage, Slither report | ✅ done (100 % stmts / 98.76 % branch) |
| **Phase 3** | Sepolia deploy + verify, DApp + flow console, report | Verified contracts, DApp, report | ✅ done **deploy + verify done · report drafted** (`CSIT5760_Final_Project_Report_21232072.docx`) |
| **Phase 4** | Bank-issued documentary-credit rework (order → issuance → shipment → presentation → honor) | Reworked contracts, tests, UIs, scripts, docs; UI-simulated multi-account walkthrough | ✅ done (this change; see `CHANGES.md` and `TODO.md`) |

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
