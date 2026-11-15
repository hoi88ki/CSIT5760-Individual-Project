# TradeChain — Architecture

## 1. Deployment topology

The suite is **six deployed contracts plus one inlined type library**. `TradeChainCore` is the
role authority and the single user entry point; it deploys and wires the other four in its
constructor and receives `TradeUSD` as the injected settlement token (so it is never deployed twice).

```
                         +---------------------- TradeChainCore -----------------------+
                         |  AccessControl (roles)   ·   IERC721Receiver (escrow)        |
                         +---+---------------+---------------+---------------+----------+
                    onlyCore |        onlyCore |        view  |      onlyCore
                             v                 v              v               v
                     ShipmentTracker   DocumentRegistry  ComplianceEngine  LetterOfCredit
                     (+ ERC-721 title)
                                                              reads:  registry + tracker
                                                              LetterOfCredit escrows TradeUSD, calls compliance
```

`ShipmentTracker` is both the shipment aggregate and the **ERC-721 document of title**
(`tokenId == shipmentId`). `TradeUSD` and `ShipmentTracker` each own an `AccessControl` whose admin
is the core, so the core can mint `TradeUSD` (role-gated) and mint/transfer the title token. The
ERC-721 `transferFrom`/`safeTransferFrom` surface is blocked in `ShipmentTracker._update`; only the
core's `transferTitle` (called at settlement) can move the title. No proxies, no upgradeable patterns.

Deploy-time wiring (all performed in `TradeChainCore`'s constructor):

| Contract | Constructor argument(s) |
|----------|-------------------------|
| `ShipmentTracker` | `core` (also grants `CONTROLLER_ROLE` for the title token) |
| `DocumentRegistry` | `core` |
| `ComplianceEngine` | `registry`, `tracker` |
| `LetterOfCredit` | `core`, `token`, `tracker`, `compliance`, `treasury` (= core initially) |
| `TradeChainCore` | `token` (an ERC-20, e.g. `TradeUSD`) |

## 2. Storage

| Contract | Mapping / field | Value |
|----------|-----------------|-------|
| `ShipmentTracker` | `_orders[orderId]` | `Order{importer, exporter, term, deadline, lcAmount, shipmentId, fulfilled}` |
| `ShipmentTracker` | `_shipments[id]` | `Shipment{orderId, exporter, importer, term, phase, timestamps, lcAmount, riskHolder}` |
| `ShipmentTracker` | `_owners[tokenId]` / `_tokenURIs[tokenId]` | ERC-721 title owner + `ipfs://<B/L CID>` (`tokenId == shipmentId`) |
| `DocumentRegistry` | `_documents[id][docType]` | `DocRecord{cid, issuer, timestamp, verified}` |
| `LetterOfCredit` | `_lcs[id]` | `LC{amount, funded, paid, reclaimed, dutyAmount, dutyPaid, dutyPayer}` |

Ids are monotonic (`_nextOrderId`, `_nextShipmentId`, starting at 1); shipment ids also double as
`ShipmentTracker` token ids.

## 3. Public API (via `TradeChainCore`)

| Function | Caller | Preconditions | Effect |
|----------|--------|---------------|--------|
| `createOrder(exporter, term, lcAmount, deadline)` | Importer | future deadline, non-zero amount | opens order #n |
| `createShipment(orderId, invoiceCID, packingCID)` | ordered Exporter | order unfulfilled, before deadline | shipment + invoice/packing anchors + title token minted to core |
| `openLetterOfCredit(id)` | Importer (buyer) | phase `Created`, token approved | escrows the L/C in `TradeUSD` (in `LetterOfCredit`) |
| `anchorDocument(id, docType, cid)` | per-DocType role | phase ≥ `LCFunded`, anchorable type | anchors once; verified |
| `confirmPickup(id)` | Logistics | phase `LCFunded`, pickup docs present | → `PickedUp`; **EXW**: risk→importer and pays |
| `confirmVesselLoading(id, blCid)` | Logistics | phase `PickedUp`, loading docs present | anchors B/L, sets title `tokenURI` → `LoadedOnVessel`; **FOB/CIF**: risk→importer and pay |
| `payCustomsDuty(id, amount)` | Exporter (DDP) / Importer | not paid, phase ≤ `Delivered`, L/C not yet paid | escrows duty (0 allowed); reverts `LCAlreadySettled` after payout |
| `confirmFinalDelivery(id)` | Importer (buyer) | phase `LoadedOnVessel`, delivery docs present | → `Delivered`, transfers title; **DDP**: risk→importer and pays |
| `forceFinalizeDelivery(id)` | Bank | phase `LoadedOnVessel`, docs complete | same, bypassing a stalling importer |
| `reclaimExpiredLC(id)` | Importer / Bank / admin | past deadline, phase `LCFunded` | refunds escrow → `Reclaimed` |
| `revokeDocument(id, docType)` | issuer or admin | document exists, verified | clears `verified` (invalid at payout) |

**Views:** `getOrder`, `getShipment`, `getDocument`, `getLC`, `orderCount`, `shipmentCount`,
`hasValidDocument`, `payoutPhaseOf`, `requiredDocumentsAt`, `isCompliant`, plus companion-address
getters (`settlementToken`, `shipmentTracker`, `documentRegistry`,
`complianceEngine`, `letterOfCredit`). The title token is read through `ShipmentTracker`
(`ownerOf`, `tokenURI`, `exists`).

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

## 6. Off-chain layer — per-role IPFS (one node per participant)

Documents and certificate metadata live on **IPFS**. Each participant (exporter, importer, bank,
logistics, verifier) runs its **own kubo node** and **keeps its own copy**; the issuing role uploads
to its own node and the resulting **CID** is anchored on-chain. Any involved party can then read the
document through the DApp by pointing at the node that holds a copy. Because CIDs are
content-addressed, every copy serves the same bytes, so there is exactly **one CID per
`(shipment, DocType)`** and **no contract change** is needed for this topology.

Only CIDs are stored on-chain, so gas is constant-bounded per document and independent of file
size. `scripts/ipfs-add.js` (with `--api <multiaddr>`) uploads to a role's node; the DApp's
per-role node field (`src/ipfs.js`) targets the active role's node for both **upload** and
**retrieval** (`ipfs cat`); and `scripts/ipfs-pin.js` lets a counterparty keep its own copy of a
CID. The React DApp reads on-chain state and calls the core directly. Setup and the
upload/retrieve flow are in [`IPFS_CONSORTIUM.md`](./IPFS_CONSORTIUM.md).

**Limitations.** CIDs are public on-chain, so per-role nodes give *consortium-only retrieval* by
convention, not cryptographic secrecy — restrict the swarm or encrypt the file before upload if
stronger confidentiality is required. Availability depends on a copy existing somewhere: a CID whose
only holder is offline (and that no counterparty copied) cannot be fetched.
