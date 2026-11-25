
# Multi-account workflow demo — TradeChain on sepolia


Date: 2026-11-25T15:20:39.471Z

Core: `0xCcE6bd88756759B8A02318a61d37e15BB1781520` · LetterOfCredit: `0xCC67ec9baed27A00f0f1DD7AaBEa194fcbeb8abd` · ShipmentTracker (e-B/L): `0x377fe5827EEa210e8AF670E7D61196F75f371feF`

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

| Importer | `ROLE_IMPORTER` | `createOrder(exporter=0x6e5c0C76…, FOB, 25000.0 tUSD, sight)` | [0x646490c2…](https://sepolia.etherscan.io/tx/0x646490c295dbddb0f7c18d71c63557ed299fc31cd966b807318d918d5f59431e) | 12210371 | 1364849 | 7.72236572497082317 |
| | | ↳ order #2 names the exporter as beneficiary | | | | |
| | | ↳ phase OrderPlaced — nothing funded yet | | | | |

## 2 · Issuance (issuing bank — funds the escrow)

| Bank | `ROLE_BANK` | `approve(core 0xCcE6bd88…, max tUSD)` | [0x235e05c2…](https://sepolia.etherscan.io/tx/0x235e05c275a306a3670945bf0ec617badd251cd51427466ea2e93d3dc2bce59b) | 12210372 | 128628 | 0.09999999999742744 |
| | | ↳ escrow allowance in place | | | | |
| Bank | `ROLE_BANK` | `issueLetterOfCredit(order #2 — 25000.0 tUSD from the BANK)` | [0xb1cd5557…](https://sepolia.etherscan.io/tx/0xb1cd55575fc0561c96e7d7b2f81f165353b71838a217b2dc7274e75d14c91631) | 12210373 | 749088 | 0.09999999998244568 |
| | | ↳ credit recorded with the bank as issuer | | | | |
| | | ↳ beneficiary = exporter, stipulated docs bitmask 43 | | | | |
| | | ↳ escrow funded BY THE BANK: 25000.0 tUSD in the module | | | | |
| | | ↳ phase LCIssued — the exporter may now ship | | | | |

## 3 · Shipment (exporter — only now allowed to ship)

| Exporter | `ROLE_EXPORTER` | `createShipment(invoice + packing-list CIDs anchored, title minted to the core escrow)` | [0x6ca11836…](https://sepolia.etherscan.io/tx/0x6ca11836db3a6232cce7cb8ec37e07605a958d499dc689d2067272da0ec47325) | 12210374 | 1422515 | 0.0999999999715497 |
| | | ↳ phase Shipped | | | | |
| | | ↳ e-B/L title token escrowed by the core | | | | |

## 4 · Verifier attestation

| Verifier | `ROLE_VERIFIER` | `anchorDocument(InspectionCertificate (part of the FOB stipulated set))` | [0xbdaf15f0…](https://sepolia.etherscan.io/tx/0xbdaf15f07ffda0370002910fcf924c4f9c159a9f8694505b7e9814a8f2ffed33) | 12210375 | 606471 | 0.09999999998787058 |
| | | ↳ inspection certificate anchored & verified | | | | |

## 5 · Custody (logistics) — risk moves, payment does NOT

| Logistics | `ROLE_LOGISTICS` | `confirmPickup(custody PickedUp; FOB risk still with the exporter)` | [0x100ad83a…](https://sepolia.etherscan.io/tx/0x100ad83ade4c5b33783fa7de60aa445568b714708b4042b7b7b1fde84600bc88) | 12210376 | 80976 | 0.09999999999838048 |
| | | ↳ custody PickedUp | | | | |
| | | ↳ FOB: risk still with the exporter | | | | |
| | | ↳ no payment at the milestone (the credit pays on honor) | | | | |
| Logistics | `ROLE_LOGISTICS` | `confirmVesselLoading(B/L anchored + title URI set; FOB risk transfers to the importer)` | [0x8002e6e2…](https://sepolia.etherscan.io/tx/0x8002e6e281e0b31c124fe5dcd03b527571673bf34408855de3deb729b2162d0d) | 12210378 | 1113273 | 0.09999999997611502 |
| | | ↳ custody OnVessel | | | | |
| | | ↳ FOB: risk now with the importer | | | | |
| | | ↳ title tokenURI = ipfs://<B/L CID> | | | | |
| | | ↳ still no payment — presentation comes first | | | | |

## 6 · Presentation (exporter/beneficiary)

| Exporter | `ROLE_EXPORTER` | `presentDocuments(stipulated set complete → presentation recorded)` | [0x6c09a091…](https://sepolia.etherscan.io/tx/0x6c09a0913fd8ee98d7b801f65f15eedd2394e45d0a1f2e44aa2d101c9c7ad59e) | 12210379 | 119579 | 0.099999999969038541 |
| | | ↳ phase Presented | | | | |
| | | ↳ examination preview: presentation set complete — the bank may honor | | | | |

## 7 · Examination & honor (issuing bank — sight: pays now)

| Bank | `ROLE_BANK` | `honorPresentation(examines the presentation on-chain and honors — 25000.0 tUSD to the beneficiary)` | [0x628633a6…](https://sepolia.etherscan.io/tx/0x628633a6d01946b122926cf3b95c55759c78b0241bfb4ad1fb5302aebe7af457) | 12210380 | 265483 | 0.099999999976605054 |
| | | ↳ credit honored and paid (sight) | | | | |
| | | ↳ exporter balance +25000.0 tUSD | | | | |
| | | ↳ escrow emptied | | | | |

## 8 · Final delivery (importer) — title released, trade Settled

| Importer | `ROLE_IMPORTER` | `confirmFinalDelivery(custody Delivered, e-B/L title released to the importer)` | [0x69ff0b49…](https://sepolia.etherscan.io/tx/0x69ff0b4990b044f6b1385036adbe062d6cb751bbbbacb26110648b9e53db64a1) | 12210381 | 244128 | 7.722365724965452354 |
| | | ↳ custody Delivered | | | | |
| | | ↳ phase Settled (paid AND delivered) | | | | |
| | | ↳ e-B/L title now owned by the importer | | | | |

## Result


Trade #2: phase **Settled**, custody **Delivered**, credit paid **true**, title with the **importer**.

| Party | Final ETH (gas paid from these accounts) | Final tUSD |
|---|---|---|
| Importer | 7.722365724965452354 | 10000.0 |
| Exporter | 0.099999999969038541 | 35000.0 |
| Bank | 0.099999999976605054 | 975000.0 |
| Logistics | 0.09999999997611502 | — |
| Verifier | 0.09999999998787058 | — |

