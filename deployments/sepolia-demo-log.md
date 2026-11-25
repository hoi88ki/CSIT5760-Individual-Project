
# Multi-account workflow demo — TradeChain on sepolia


Date: 2026-11-25T17:55:10.067Z

Core: `0x34A657C2b68CCda1b696f03dEf8c0a7a8A8728a6` · LetterOfCredit: `0xFaA7C6C17fE1043b9f354d9Bd3bA55e25199919C` · ShipmentTracker (e-B/L): `0xEcA841E1f8aF5C89C823f4A081498A45c9b11818`

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

| Importer | `ROLE_IMPORTER` | `createOrder(exporter=0x6e5c0C76…, FOB, 25000.0 tUSD, sight)` | [0x8accd2d3…](https://sepolia.etherscan.io/tx/0x8accd2d3439ab55284bda580707685f4bb7ae70c5bb1be5830c6937f815579e2) | 12211110 | 1365058 | 7.722365724917454212 |
| | | ↳ order #2 names the exporter as beneficiary | | | | |
| | | ↳ phase OrderPlaced — nothing funded yet | | | | |

## 2 · Issuance (issuing bank — funds the escrow)

| Bank | `ROLE_BANK` | `issueLetterOfCredit(order #2 — 25000.0 tUSD from the BANK)` | [0x380d50b1…](https://sepolia.etherscan.io/tx/0x380d50b1c7385b2d7b0f2ca1b94a70fe798d2dbe4e056e14c538ba5b606b00ab) | 12211111 | 749380 | 0.09999999994524262 |
| | | ↳ credit recorded with the bank as issuer | | | | |
| | | ↳ beneficiary = exporter, stipulated docs bitmask 43 | | | | |
| | | ↳ escrow funded BY THE BANK: 25000.0 tUSD in the module | | | | |
| | | ↳ phase LCIssued — the exporter may now ship | | | | |

## 3 · Shipment (exporter — only now allowed to ship)

| Exporter | `ROLE_EXPORTER` | `createShipment(invoice + packing-list CIDs anchored, title minted to the core escrow)` | [0x7d589609…](https://sepolia.etherscan.io/tx/0x7d5896091d05b1c2e21427fece2b1cf4cb83f28b6b6fc0d2b332276fd28491c4) | 12211112 | 1323902 | 0.09999999992049522 |
| | | ↳ phase Shipped | | | | |
| | | ↳ e-B/L title token escrowed by the core | | | | |

## 4 · Verifier attestation

| Verifier | `ROLE_VERIFIER` | `anchorDocument(InspectionCertificate (part of the FOB stipulated set))` | [0xfac92fc6…](https://sepolia.etherscan.io/tx/0xfac92fc67632741c9dd210693e93a8cc22c4643591e0ffc61e44aba9de8afd4d) | 12211113 | 606602 | 0.099999999969065918 |
| | | ↳ inspection certificate anchored & verified | | | | |

## 5 · Custody (logistics) — risk moves, payment does NOT

| Logistics | `ROLE_LOGISTICS` | `confirmPickup(custody PickedUp; FOB risk still with the exporter)` | [0x204d26e8…](https://sepolia.etherscan.io/tx/0x204d26e8e69fb80474b85fa462e6912a252c36873e1e479e09e39703ee553ebe) | 12211114 | 82171 | 0.09999999995691952 |
| | | ↳ custody PickedUp | | | | |
| | | ↳ FOB: risk still with the exporter | | | | |
| | | ↳ no payment at the milestone (the credit pays on honor) | | | | |
| Logistics | `ROLE_LOGISTICS` | `confirmVesselLoading(B/L anchored + title URI set; FOB risk transfers to the importer)` | [0x31b017e9…](https://sepolia.etherscan.io/tx/0x31b017e9daa165ba68cc229ba3a2a23aa88ee6194a8aa5ec689f9e7a60b091a6) | 12211115 | 1115358 | 0.09999999994018915 |
| | | ↳ custody OnVessel | | | | |
| | | ↳ FOB: risk now with the importer | | | | |
| | | ↳ title tokenURI = ipfs://<B/L CID> | | | | |
| | | ↳ still no payment — presentation comes first | | | | |

## 6 · Presentation (exporter/beneficiary)

| Exporter | `ROLE_EXPORTER` | `presentDocuments(stipulated set complete → presentation recorded)` | [0x44eb7017…](https://sepolia.etherscan.io/tx/0x44eb7017d3e0724ed30f61c6ccb9c03684068adbb07c3ad2a5c979173407ab8b) | 12211117 | 121401 | 0.099999999918674205 |
| | | ↳ phase Presented | | | | |
| | | ↳ examination preview: presentation set complete — the bank may honor | | | | |

## 7 · Examination & honor (issuing bank — sight: pays now)

| Bank | `ROLE_BANK` | `honorPresentation(examines the presentation on-chain and honors — 25000.0 tUSD to the beneficiary)` | [0x1cbdc43d…](https://sepolia.etherscan.io/tx/0x1cbdc43d8007c962c1f60c654da201b67ad4286cc06948b4ad612ddf61310cf5) | 12211118 | 267802 | 0.09999999994122559 |
| | | ↳ credit honored and paid (sight) | | | | |
| | | ↳ exporter balance +25000.0 tUSD | | | | |
| | | ↳ escrow emptied | | | | |

## 8 · Reimbursement (importer settles the credit with the issuing bank, on-chain)

| Importer | `ROLE_IMPORTER` | `reimburseIssuingBank(settles the credit on-chain — 25000.0 tUSD from the importer to the issuing bank)` | [0xf6848cf6…](https://sepolia.etherscan.io/tx/0xf6848cf6681d0fe2f5e4c3e697434e0662d84649f196d5e7699bfdbd7f0a150e) | 12211120 | 109437 | 7.722365724915812657 |
| | | ↳ credit recorded as reimbursed | | | | |
| | | ↳ bank balance +25000.0 tUSD (reimbursed) | | | | |
| | | ↳ importer balance reduced by the credit amount | | | | |

## 9 · Final delivery (importer) — title released, trade Settled

| Importer | `ROLE_IMPORTER` | `confirmFinalDelivery(custody Delivered, e-B/L title released to the importer)` | [0xb6b2e1db…](https://sepolia.etherscan.io/tx/0xb6b2e1dbdae3a4a57bb1c9d2c2281c3b55912f91823d534c4383cf5a0e6791eb) | 12211121 | 258048 | 7.722365724911941937 |
| | | ↳ custody Delivered | | | | |
| | | ↳ phase Settled (paid AND delivered) | | | | |
| | | ↳ e-B/L title now owned by the importer | | | | |

## Result


Trade #2: phase **Settled**, custody **Delivered**, credit paid **true**, reimbursed **true**, title with the **importer**.

| Party | Final ETH (gas paid from these accounts) | Final tUSD |
|---|---|---|
| Importer | 7.722365724911941937 | 985000.0 |
| Exporter | 0.099999999918674205 | 60000.0 |
| Bank | 0.09999999994122559 | 975000.0 |
| Logistics | 0.09999999994018915 | — |
| Verifier | 0.099999999969065918 | — |

