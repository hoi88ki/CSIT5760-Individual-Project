
# Multi-account workflow demo — TradeChain on sepolia


Date: 2026-11-28T12:23:00.808Z

Core: `0x06365Fbcedc05f1e3751D993Ef933F8c931e0651` · LetterOfCredit: `0x5944D815389E2202CFae38fcb42c1416ff92d828` · ShipmentTracker (e-B/L): `0x6e274DE9a9489112182388336A1A5995d1862380`

| Party | Role | Address |
|---|---|---|
| Importer (applicant) | ROLE_IMPORTER | `0x42687043F24511CdE610190c24505E09b60f7706` |
| Issuing bank | ROLE_BANK | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` |
| Exporter (beneficiary) | ROLE_EXPORTER | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` |
| Logistics | ROLE_LOGISTICS | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` |
| Verifier | ROLE_VERIFIER | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` |

Terms: FOB · sight · L/C 25000.0 tUSD · expiry = now + 30 days

Every transaction below is signed by the party's own key (see the Etherscan links).

| Party | Role | Action | Tx | Block | Gas | Party ETH left |
|---|---|---|---|---|---|---|

## 1 · Application (importer)

| Importer | `ROLE_IMPORTER` | `createOrder(exporter=0x6e5c0C76…, FOB, 25000.0 tUSD, sight)` | [0x32365c33…](https://sepolia.etherscan.io/tx/0x32365c334f83f40b6c07aeb9dee82cfb476f368e4d137a3599b3341bd62929a2) | 12230015 | 1364800 | 7.713863834763298304 |
| | | ↳ order #7 names the exporter as beneficiary | | | | |
| | | ↳ phase OrderPlaced — nothing funded yet | | | | |

## 2 · Issuance (issuing bank — funds the escrow)

| Bank | `ROLE_BANK` | `issueLetterOfCredit(order #7 — 25000.0 tUSD from the BANK)` | [0x089abdf9…](https://sepolia.etherscan.io/tx/0x089abdf990f1eea517cf0f530be7a56b895921d2511fcaf6def04bdde3e7fbee) | 12230017 | 648970 | 1.093372856844532591 |
| | | ↳ credit recorded with the bank as issuer | | | | |
| | | ↳ beneficiary = exporter, stipulated docs bitmask 43 | | | | |
| | | ↳ escrow funded BY THE BANK: +25000.0 tUSD (module total 25201.0) | | | | |
| | | ↳ phase LCIssued — the exporter may now ship | | | | |

## 3 · Shipment (exporter — only now allowed to ship)

| Exporter | `ROLE_EXPORTER` | `createShipment(invoice + packing-list CIDs anchored, title minted to the core escrow)` | [0xa9aba46a…](https://sepolia.etherscan.io/tx/0xa9aba46a029b9732be24df67ebe469e13c4520d0b4f0ba059825a48f2fc1b231) | 12230018 | 1419818 | 1.093434879316137807 |
| | | ↳ phase Shipped | | | | |
| | | ↳ e-B/L title token escrowed by the core | | | | |

## 4 · Verifier attestation

| Verifier | `ROLE_VERIFIER` | `anchorDocument(InspectionCertificate (part of the FOB stipulated set))` | [0x7e2fe674…](https://sepolia.etherscan.io/tx/0x7e2fe674228548c2321d21af037121d66d48071d2fe477ac69c189e71ac07c7e) | 12230019 | 606077 | 0.09564569641925882 |
| | | ↳ inspection certificate anchored & verified | | | | |

## 5 · Custody (logistics) — risk moves, payment does NOT

| Logistics | `ROLE_LOGISTICS` | `confirmPickup(custody PickedUp; FOB risk still with the exporter)` | [0xddab4fdc…](https://sepolia.etherscan.io/tx/0xddab4fdc46491d96956d3a6afe0a2f33d96418d782f150de3d12bb1f5280be6b) | 12230020 | 81682 | 1.093125639369758518 |
| | | ↳ custody PickedUp | | | | |
| | | ↳ FOB: risk still with the exporter | | | | |
| | | ↳ no payment at the milestone (the credit pays on honor) | | | | |
| Logistics | `ROLE_LOGISTICS` | `confirmVesselLoading(B/L anchored + title URI set; FOB risk transfers to the importer)` | [0xf54b07c1…](https://sepolia.etherscan.io/tx/0xf54b07c1ed8f19304e1d6de3be090f20789d6512625c07ec6c89c06cdab52166) | 12230021 | 1115332 | 1.093125639355259202 |
| | | ↳ custody OnVessel | | | | |
| | | ↳ FOB: risk now with the importer | | | | |
| | | ↳ title tokenURI = ipfs://<B/L CID> | | | | |
| | | ↳ still no payment — presentation comes first | | | | |

## 6 · Presentation (exporter/beneficiary)

| Exporter | `ROLE_EXPORTER` | `presentDocuments(stipulated set complete → presentation recorded)` | [0x617f2a82…](https://sepolia.etherscan.io/tx/0x617f2a8237efc44bd7912bc800075c720e83f8a49b17fd31cb565707619e2410) | 12230022 | 121581 | 1.093434879314557254 |
| | | ↳ phase Presented | | | | |
| | | ↳ examination preview: presentation set complete — the bank may honor | | | | |

## 7 · Examination & honor (issuing bank — sight: pays now)

| Bank | `ROLE_BANK` | `honorPresentation(examines the presentation on-chain and honors — 25000.0 tUSD to the beneficiary)` | [0xdce1e48c…](https://sepolia.etherscan.io/tx/0xdce1e48cdc792f4b19d978f2f47d28f84f4c91cb1d2f75375328a97abec17636) | 12230023 | 276499 | 1.093372856840938104 |
| | | ↳ credit honored and paid (sight) | | | | |
| | | ↳ exporter balance +25000.0 tUSD | | | | |
| | | ↳ escrow debited by the payout (module total 201.0) | | | | |

## 8 · Reimbursement (importer settles the credit with the issuing bank, on-chain)

| Importer | `ROLE_IMPORTER` | `reimburseIssuingBank(settles the credit on-chain — 25000.0 tUSD from the importer to the issuing bank)` | [0x3653c362…](https://sepolia.etherscan.io/tx/0x3653c36279fc465cf16000021bd2a8ca9958c4ad6af0a1600837c9bf418e2cd2) | 12230024 | 105570 | 7.713863834761925894 |
| | | ↳ credit recorded as reimbursed | | | | |
| | | ↳ bank balance +25000.0 tUSD (reimbursed) | | | | |
| | | ↳ importer balance reduced by the credit amount | | | | |

## 9 · Final delivery (importer) — title released, trade Settled

| Importer | `ROLE_IMPORTER` | `confirmFinalDelivery(custody Delivered, e-B/L title released to the importer)` | [0x811c3088…](https://sepolia.etherscan.io/tx/0x811c30885f75ad9d8b039a1fcd65c8b44a3bf7741bee09ba06f04c587549f218) | 12230025 | 146617 | 7.713863834760019873 |
| | | ↳ custody Delivered | | | | |
| | | ↳ phase Settled (paid AND delivered) | | | | |
| | | ↳ e-B/L title now owned by the importer | | | | |

## Result


Trade #7: phase **Settled**, custody **Delivered**, credit paid **true**, reimbursed **true**, title with the **importer**.

| Party | Final ETH (gas paid from these accounts) | Final tUSD |
|---|---|---|
| Importer | 7.713863834760019873 | 949900.0 |
| Exporter | 1.093434879314557254 | 60000.0 |
| Bank | 1.093372856840938104 | 999799.0 |
| Logistics | 1.093125639355259202 | — |
| Verifier | 0.09564569641925882 | — |

