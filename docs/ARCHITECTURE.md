# TradeChain — Architecture

## 1. Deployment topology

One `TradeChainCore` (single address, no proxies) owns two standalone ERC-721 tokens that it
deploys in its constructor:

```
        ┌──────────────────────────── Deployer (DEFAULT_ADMIN_ROLE) ───────────────────────────┐
        │ grants ROLE_SELLER/BUYER/CARRIER/ISSUING_BANK/ADVISING_BANK/VERIFIER                   │
        ▼                                                                                       │
 ┌──────────────────────────────┐        owns        ┌──────────────┐   owns   ┌───────────────┐
 │        TradeChainCore        │───────────────────►│   EBLToken   │          │ TradeCertNFT  │
 │  (composition root, 1 addr)  │────────────────────┼──────────────┼─────────►│               │
 └───────────────┬──────────────┘                    └──────────────┘          └───────────────┘
                 │ SafeERC20
                 ▼
        ┌──────────────────┐
        │ Settlement token │  (ERC-20 stablecoin, e.g. 6-decimal USDC-like MockERC20 on testnet)
        └──────────────────┘
```

`TradeChainCore is SettlementModule` → `DocumentRegistry` → `ShipmentState` → `AccessControl`,
`ReentrancyGuard`. All modules share **one storage layout**.

## 2. Storage

| Mapping / field | Key | Value |
|-----------------|-----|-------|
| `_orders` | `orderId` | `Order{buyer, seller, term, deadline, lcAmount, shipmentId, fulfilled}` |
| `_shipments` | `shipmentId` | `Shipment{…, phase, lcFunded, lcPaid, dutyPaid, titleTransferred, riskHolder, …}` |
| `_documents` | `(shipmentId, DocType)` | `DocRecord{cid, issuer, timestamp, locked, certId}` |
| `_nextOrderId` / `_nextShipmentId` | — | monotonic counters (ids start at 1) |

`DocRecord.locked` enforces **anchor-once-then-lock**; `certId` links a verifier document to its
`TradeCertNFT`.

## 3. Public API

### Roles (`AccessControl`)

`ROLE_SELLER`, `ROLE_BUYER`, `ROLE_CARRIER`, `ROLE_ISSUING_BANK`, `ROLE_ADVISING_BANK`,
`ROLE_VERIFIER` (+ `DEFAULT_ADMIN_ROLE`). `grantRoles(bytes32[], address[])` batch-grants.

### Lifecycle functions

| Function | Caller | Preconditions | Effect |
|----------|--------|---------------|--------|
| `createOrder(seller, term, lcAmount, deadline)` | Buyer | future deadline, non-zero amount | opens order #n |
| `createShipment(orderId, invoiceCID, packingListCID)` | ordered Seller | order unfulfilled, before deadline | creates shipment, anchors invoice+packing, mints eB/L to core |
| `openLetterOfCredit(id)` | shipment Buyer | phase `Created`, token approved | escrows L/C in core |
| `anchorDocument(id, docType, cid)` | per-DocType role | phase ≥ `LCFunded`, anchorable type | anchors once; verifier types mint `TradeCertNFT` |
| `confirmPickup(id)` | Carrier | phase `LCFunded`, pickup docs present | → `PickedUp`; risk→Buyer; **EXW pays** |
| `confirmVesselLoading(id, blCid)` | Carrier | phase `PickedUp`, loading docs present | anchors B/L, sets eB/L URI → `LoadedOnVessel`; **FOB/CIF pay** |
| `payCustomsDuty(id, amount)` | Seller (DDP) / Buyer | not paid, phase ≤ `Delivered` | escrows duty (0 allowed) |
| `confirmFinalDelivery(id)` | shipment Buyer | phase `LoadedOnVessel`, delivery docs present | → `Delivered`, transfers eB/L; **DDP pays** |
| `forceFinalizeDelivery(id)` | either bank | phase `LoadedOnVessel`, docs complete | same as above, bypassing a stalling Buyer |
| `reclaimExpiredLC(id)` | Buyer / issuing bank / admin | past deadline, phase `LCFunded` | refunds escrow → `Reclaimed` |
| `revokeCertificate(id, docType)` | issuer or admin | cert exists | burns cert (document invalid at payout) |

### Views

`getOrder`, `getShipment`, `getDocument`, `orderCount`, `shipmentCount`, `hasValidDocument`,
`payoutPhaseOf(term)`, `requiredDocumentsAt(id, phase)`, `settlementToken()`, `eblToken()`,
`certNFT()`.

## 4. Document validity

`_hasValidDocument(id, docType)` is true iff a CID is anchored **and**, for a verifier type
(`InspectionCertificate`, `InsuranceCertificate`, `CustomsClearance`), the linked certificate
still exists (unrevoked). `_requireDocuments(id, mask)` walks the bitmask and reverts with
`MissingMandatoryDocument(id, docType)` on the first gap.

## 5. Payout engine

`_triggerAtomicPayout(id)` is the *only* path that moves the L/C:

1. `nonReentrant` + strict checks-effects-interactions.
2. Verifies the shipment is funded, at the exact risk-transfer phase, holds every mandatory
   document, and (DDP) has duty paid.
3. Sets `lcPaid`, moves `riskHolder` to the Buyer and emits `AtomicLCPayoutExecuted`
   **before** the `safeTransfer` to the Seller.

## 6. Off-chain layer

Documents and certificate metadata live on **IPFS** (local kubo node via
`scripts/ipfs-add.js`, per Q12). Only CIDs are stored on-chain, so gas is constant-bounded per
document and independent of file size. The dashboard (`dapp/`) reads on-chain state and calls
the contract directly.
