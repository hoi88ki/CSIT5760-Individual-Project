# TradeChain — Architecture

## 1. Deployment topology

The suite is **seven deployed contracts plus one inlined type library**. `TradeChainCore` is the
role authority and the single user entry point; it deploys and wires the other six in its
constructor (`TradeUSD` is passed in as the settlement token so it is never deployed twice).

```
                         +---------------------- TradeChainCore -----------------------+
                         |  AccessControl (roles)   ·   IERC721Receiver (escrow)        |
                         +---+---------------+---------------+---------------+----------+
                    onlyCore |        onlyCore |        view  |      onlyCore | controller
                             v                 v              v               v
                     ShipmentTracker   DocumentRegistry  ComplianceEngine  LetterOfCredit   ShipmentNFT
                                                              reads:  registry + tracker
                                                              LetterOfCredit escrows TradeUSD, calls compliance
```

`TradeUSD` and `ShipmentNFT` each own an `AccessControl` whose admin is the core, so the core can
mint `TradeUSD` (role-gated) and mint/transfer the title NFT. No proxies, no upgradeable patterns.

Deploy-time wiring (all performed in `TradeChainCore`'s constructor):

| Contract | Constructor argument(s) |
|----------|-------------------------|
| `ShipmentNFT` | `core` |
| `ShipmentTracker` | `core` |
| `DocumentRegistry` | `core` |
| `ComplianceEngine` | `registry`, `tracker` |
| `LetterOfCredit` | `core`, `token`, `tracker`, `compliance`, `treasury` (= core initially) |
| `TradeChainCore` | `token` (an ERC-20, e.g. `TradeUSD`) |

## 2. Storage

| Contract | Mapping / field | Value |
|----------|-----------------|-------|
| `ShipmentTracker` | `_orders[orderId]` | `Order{importer, exporter, term, deadline, lcAmount, shipmentId, fulfilled}` |
| `ShipmentTracker` | `_shipments[id]` | `Shipment{orderId, exporter, importer, term, phase, timestamps, lcAmount, riskHolder}` |
| `DocumentRegistry` | `_documents[id][docType]` | `DocRecord{cid, issuer, timestamp, verified}` |
| `LetterOfCredit` | `_lcs[id]` | `LC{amount, funded, paid, reclaimed, dutyAmount, dutyPaid, dutyPayer}` |

Ids are monotonic (`_nextOrderId`, `_nextShipmentId`, starting at 1); shipment ids also double as
`ShipmentNFT` token ids.

## 3. Public API (via `TradeChainCore`)

| Function | Caller | Preconditions | Effect |
|----------|--------|---------------|--------|
| `createOrder(exporter, term, lcAmount, deadline)` | Importer | future deadline, non-zero amount | opens order #n |
| `createShipment(orderId, invoiceCID, packingCID)` | ordered Exporter | order unfulfilled, before deadline | shipment + invoice/packing anchors + title NFT minted to core |
| `openLetterOfCredit(id)` | Importer (buyer) | phase `Created`, token approved | escrows the L/C in `TradeUSD` (in `LetterOfCredit`) |
| `anchorDocument(id, docType, cid)` | per-DocType role | phase ≥ `LCFunded`, anchorable type | anchors once; verified |
| `confirmPickup(id)` | Logistics | phase `LCFunded`, pickup docs present | → `PickedUp`; risk→importer; **EXW pays** |
| `confirmVesselLoading(id, blCid)` | Logistics | phase `PickedUp`, loading docs present | anchors B/L, sets NFT URI → `LoadedOnVessel`; **FOB/CIF pay** |
| `payCustomsDuty(id, amount)` | Exporter (DDP) / Importer | not paid, phase ≤ `Delivered` | escrows duty (0 allowed) |
| `confirmFinalDelivery(id)` | Importer (buyer) | phase `LoadedOnVessel`, delivery docs present | → `Delivered`, transfers title; **DDP pays** |
| `forceFinalizeDelivery(id)` | Bank | phase `LoadedOnVessel`, docs complete | same, bypassing a stalling importer |
| `reclaimExpiredLC(id)` | Importer / Bank / admin | past deadline, phase `LCFunded` | refunds escrow → `Reclaimed` |
| `revokeDocument(id, docType)` | issuer or admin | document exists, verified | clears `verified` (invalid at payout) |

**Views:** `getOrder`, `getShipment`, `getDocument`, `getLC`, `orderCount`, `shipmentCount`,
`hasValidDocument`, `payoutPhaseOf`, `requiredDocumentsAt`, `isCompliant`, plus companion-address
getters (`settlementToken`, `shipmentNFT`, `shipmentTracker`, `documentRegistry`,
`complianceEngine`, `letterOfCredit`).

## 4. Document validity

`DocumentRegistry.isValid(id, docType)` is true iff a CID is anchored **and** `verified` (not
revoked). `ComplianceEngine.firstMissing` walks the required bitmask for the shipment's Incoterm ×
phase and reverts with `MissingMandatoryDocument` on the first gap.

## 5. Payout engine

`LetterOfCredit.settle(id, exporter)` is the only path that moves the L/C:

1. `nonReentrant` + strict checks-effects-interactions.
2. Verifies the shipment is funded, at the exact risk-transfer phase (from `ComplianceEngine`),
   holds every mandatory document, and (DDP) has duty paid.
3. Sets `paid`, then `safeTransfer`s the L/C to the exporter (and the duty to the treasury).

## 6. Off-chain layer — consortium IPFS (one node per role)

Documents and certificate metadata live on **IPFS**. Each participant (exporter, importer, bank,
logistics, verifier) runs its **own kubo node**; the issuing role uploads to its own node and the
resulting **CID** is anchored on-chain. The CID is then **replicated/pinned** to the counterparties'
nodes (optionally via a private swarm and/or IPFS Cluster). Because CIDs are content-addressed,
every replica serves the same bytes, so there is exactly **one CID per `(shipment, DocType)`** and
**no contract change** is needed for this topology.

Only CIDs are stored on-chain, so gas is constant-bounded per document and independent of file
size. `scripts/ipfs-add.js` (with `--api <multiaddr>`) and the DApp's per-role node field
(`src/ipfs.js`) target the active role's node. The React DApp reads on-chain state and calls the
core directly.

**Limitations.** CIDs are public on-chain, so per-role nodes give ownership/availability, not
confidentiality — use a private swarm and/or encrypt before pinning for sensitive documents.
Availability depends on replication: an unpinned CID is unfetchable once its only holder is offline.
