# TradeChain — Architecture

## 1. Deployment topology

The suite is **six deployed contracts plus one inlined type library**. `TradeChainCore` is the
role authority and the single user entry point; it deploys and wires the other four in its
constructor and receives `TradeUSD` as the injected settlement token (so it is never deployed twice).
Each module's own `AccessControl` is **mounted on the core** — the core holds every module's
`DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE` and administers them via `setModuleRole`.

The workflow it orchestrates is a **bank-issued documentary credit**: the importer (applicant)
applies for a credit; the issuing bank issues it against the application and prefunds the escrow;
the named exporter (beneficiary) ships; the exporter presents the stipulated documents; the bank
examines the presentation and honors it at sight or after the agreed deferral; custody and title
follow the Incoterm independently of payment; expired, unused credits return to the bank.

```
                         +---------------------- TradeChainCore -----------------------+
                         |  AccessControl (roles)   ·   IERC721Receiver (escrow)        |
                         |  setModuleRole  ·  setDocumentRegistry  ·  documentRegistryOf|
                         +---+----------------+-----------------+---------------+------+
                   CONTROLLER |         CONTROLLER       |   view  |    CONTROLLER
                              v                          v         v              v
                      ShipmentTracker   DocumentRegistry (swappable)  ComplianceEngine  LetterOfCredit
                      (+ ERC-721 title)                                 reads: registry per anchor + tracker
                                                                        LetterOfCredit escrows TradeUSD
```

`ShipmentTracker` is both the shipment aggregate and the **ERC-721 document of title**
(`tokenId == shipmentId`). `TradeUSD`, `ShipmentTracker`, `DocumentRegistry` and `LetterOfCredit`
each own an `AccessControl` whose admin is the core, so the core can mint `TradeUSD` (role-gated),
mint/transfer the title token and write document anchors. The
ERC-721 `transferFrom`/`safeTransferFrom` surface is blocked in `ShipmentTracker._update`; only the
core's `transferTitle` (called during final delivery) can move the title. Payout/risk transfer may happen earlier for EXW/FOB/CIF; title release is a separate final-delivery action. No proxies, no upgradeable patterns.

### 1.1 Swappable DocumentRegistry

`TradeChainCore.documentRegistry` is **mutable**. `setDocumentRegistry(address)` — callable only by
`DEFAULT_ADMIN_ROLE` or `ROLE_REGISTRY_ADMIN` — replaces it. A replacement is accepted only when it
is a `DocumentRegistry` bound to this core (`core() == address(this)`) *and* its runtime codehash
equals the deployment-time registry's, so a look-alike contract cannot forge `isValid` and fake
compliance. The registry used for each anchor is snapshotted in `_docRegistryOf[id][docType]`;
`documentRegistryOf(id, docType)` returns that snapshot (or the active registry when unset) and
`ComplianceEngine` resolves it per document, so a swap never hides documents that are already
anchored and in-flight shipments keep settling.

Deploy-time wiring (all performed in `TradeChainCore`'s constructor):

| Contract | Constructor argument(s) |
|----------|-------------------------|
| `ShipmentTracker` | `core` (also grants `CONTROLLER_ROLE` for the title token) |
| `DocumentRegistry` | `core` |
| `ComplianceEngine` | `directory` (= core), `registry`, `tracker` |
| `LetterOfCredit` | `core`, `token`, `tracker`, `compliance`, `treasury` (= core initially) |
| `TradeChainCore` | `token` (an ERC-20, e.g. `TradeUSD`) |

## 2. Storage

| Contract | Mapping / field | Value |
|----------|-----------------|-------|
| `ShipmentTracker` | `_orders[id]` | `Order{id, importer (applicant), exporter (beneficiary), term, paymentTerm, deferredDays, deadline, lcAmount}` |
| `ShipmentTracker` | `_shipments[id]` | `Shipment{id, orderId, counterparties, term, paymentTerm, deferredDays, phase, custody, timestamps, deadline, lcAmount, riskHolder}` — created with the order, same id |
| `ShipmentTracker` | `_owners[tokenId]` / `_tokenURIs[tokenId]` | ERC-721 title owner + `ipfs://<B/L CID>` (`tokenId == trade id`) |
| `DocumentRegistry` | `_documents[id][docType]` | `DocRecord{cid, issuer, timestamp, verified}` |
| `TradeChainCore` | `_docRegistryOf[id][docType]` | registry that holds that anchor (snapshot) |
| `LetterOfCredit` | `_lcs[id]` | `LC{issuingBank, beneficiary, amount, term, deferredDays, requiredDocs, issued, presented, honored, maturityAt, paid, reclaimed, reimbursed, duty…}` |

The order (application) and its trade record share one monotonic id (`_nextId`, starting at 1);
the id is also the `ShipmentTracker` token id. The credit lifecycle lives on the shared record, so
`getShipment(id)` exists from the moment the importer applies — before the bank has issued.

## 3. Public API (via `TradeChainCore`)

| Function | Caller | Preconditions | Effect |
|----------|--------|---------------|--------|
| `createOrder(exporter, term, lcAmount, deadline, paymentTerm, deferredDays)` | Importer (applicant) | future deadline, non-zero amount, sight⇒0 deferral / deferred⇒≥1 | opens application #n; trade record in `OrderPlaced` |
| `issueLetterOfCredit(orderId)` | **Issuing bank** | phase `OrderPlaced`, deadline ahead, bank has a token allowance | pulls `lcAmount` from the **bank** into escrow, records beneficiary + documentary terms → `LCIssued` (operative) |
| `createShipment(orderId, invoiceCID, packingCID)` | **named** Exporter | phase `LCIssued`, before expiry | anchors invoice + packing list, mints the title to the core → `Shipped` |
| `presentDocuments(id)` | Exporter | phase `Shipped`, before expiry, stipulated set complete & verified | records the presentation → `Presented` |
| `honorPresentation(id)` | **Bank** | presented, stipulated set still valid on-chain, (DDP) duty paid | examines; sight: pays now; deferred: schedules `maturityAt` → `Honored` |
| `drawDeferredPayment(id)` | anyone after maturity | honored, not paid, `block.timestamp ≥ maturityAt` | releases the proceeds → `Settled` if delivered |
| `reimburseIssuingBank(orderId)` | Importer (the trade's applicant) | credit `paid` (proceeds released), not already reimbursed | pulls `lc.amount` TradeUSD from the importer **to the issuing bank** on-chain; `LC.reimbursed = true` |
| `anchorDocument(id, docType, cid)` | per-DocType role | phase ≥ `Shipped`, anchorable type, slot missing or revoked | anchors verified; a live anchor is locked, a revoked slot is re-anchored |
| `replaceDocument(id, docType, cid)` | designated role for the `DocType`, original issuer, or admin | trade not `Settled`/`Reclaimed`, document exists | replaces the CID (any type, incl. invoice/packing/B/L), re-verifies it; the previous CID stays in `DocumentReplaced`; a B/L replacement updates the title URI |
| `confirmPickup(id)` | Logistics | phase `Shipped`, custody `AtExporter`, pickup docs present | custody → `PickedUp`; **EXW**: risk→importer. No payment. |
| `confirmVesselLoading(id, blCid)` | Logistics | phase `Shipped`, custody `PickedUp`, loading docs present | anchors B/L, sets title `tokenURI`, custody → `OnVessel`; **FOB/CIF**: risk→importer. No payment. |
| `payCustomsDuty(id, amount)` | Exporter (DDP) / Importer | phase ≤ `Delivered`, credit not paid | escrows duty (0 allowed) |
| `confirmFinalDelivery(id)` | Importer | custody `OnVessel`, delivery docs present | custody → `Delivered`, transfers title; `Settled` if paid |
| `forceFinalizeDelivery(id)` | Bank | same | same, bypassing a stalling importer |
| `reclaimExpiredLC(orderId)` | Importer / Bank / admin | past expiry, credit unused (never presented, never honored) | refunds escrow to the **issuing bank** → `Reclaimed`; a shipped-but-unpresented title returns to the exporter |
| `revokeDocument(id, docType)` | issuer or admin | document exists, verified | clears `verified` (invalid at examination) and re-opens the slot for a replacement anchor |
| `setDocumentRegistry(registry)` | admin or `ROLE_REGISTRY_ADMIN` | bound to this core, matching runtime codehash | swaps the active registry; `DocumentRegistryReplaced` |
| `setModuleRole(module, role, account, granted)` | admin | module is a core companion | grants/revokes a module role; `ModuleRoleSet` |

**Views:** `getOrder`, `getShipment`, `getDocument`, `getLC`, `orderCount`, `shipmentCount`,
`hasValidDocument`, `documentRegistryOf`, `presentationDocuments(id)`, `examinePresentation(id)`
(bank's examination preview); the custody-gate masks are read through `ComplianceEngine`
(`requiredForShipment(id, custody)`, `isCompliant(id, term, custody)`), plus
companion-address getters (`settlementToken`, `shipmentTracker`, `documentRegistry`,
`complianceEngine`, `letterOfCredit`). The title token is read through `ShipmentTracker`
(`ownerOf`, `tokenURI`, `exists`).

## 4. Document validity

`DocumentRegistry.isValid(id, docType)` is true iff a CID is anchored **and** `verified` (not
revoked). `ComplianceEngine` exposes two kinds of checks:

- **Custody gates** — `requiredMask(term, custody)` walks a per-checkpoint bitmask (pickup →
  loading → delivery) so goods cannot advance with incomplete paperwork;
- **The stipulated presentation set** — `presentationMask(term)` is the credit's full documentary
  requirement per Incoterm. `firstMissingPresentation` returns the first gap and backs the core's
  `examinePresentation` preview and the bank's honor-time examination.

Because the active registry is swappable, the engine resolves the registry that holds each anchor
through the core (`documentRegistryOf`) and falls back to the deployment-time registry, so a
registry swap never changes the validity of documents that are already anchored.

## 5. Honor engine

`LetterOfCredit` is the only contract that moves the credit's value, and it is prefunded by the
**issuing bank** at issuance:

1. `issue(...)` records the credit (bank, beneficiary, amount, sight/deferred, documentary terms)
   after the core has pulled the tokens from the bank.
2. `honor(id, beneficiary)` re-examines the presentation on-chain (stipulated set valid, DDP duty
   paid), then either pays at sight or schedules `maturityAt`. Strict
   checks-effects-interactions + `nonReentrant`.
3. `drawDeferred(id, beneficiary)` releases the proceeds at maturity (the core exposes it
   permissionlessly — a stalled bank cannot withhold a deterministic undertaking).
4. `reimburse(id)` settles the applicant's debt on-chain: once the proceeds are released, the
   credit pulls `amount` TradeUSD from the importer straight to the issuing bank and records
   `reimbursed` (the bank is out of pocket only between release and reimbursement).
5. `reclaim(id)` returns the funds of an expired, unused credit to the issuing bank.
6. `_release` pays the beneficiary and forwards any escrowed duty to the treasury.

## 6. Off-chain layer — per-role IPFS (one node per participant)

Documents and certificate metadata live on **IPFS**. Each participant (exporter, importer, bank,
logistics, verifier) runs its **own kubo node** and **keeps its own copy**; the issuing role uploads
to its own node and the resulting **CID** is anchored on-chain. Any involved party can then read the
document through the console by pointing at the node that holds a copy. Because CIDs are
content-addressed, every copy serves the same bytes, so there is exactly **one CID per
`(shipment, DocType)`** and **no contract change** is needed for this topology.

Only CIDs are stored on-chain, so gas is constant-bounded per document and independent of file
size. `scripts/ipfs-add.js` (with `--api <multiaddr>`) uploads to a role's node; the console's
per-role **IPFS node** field targets the active role's node for both **upload** and **retrieval**
(`ipfs cat`); and `scripts/ipfs-pin.js` lets a counterparty keep its own copy of a CID. The console
reads on-chain state and calls the core directly. Setup and the
upload/retrieve flow are in [`IPFS_CONSORTIUM.md`](./IPFS_CONSORTIUM.md).

**Limitations.** CIDs are public on-chain, so per-role nodes give *consortium-only retrieval* by
convention, not cryptographic secrecy — restrict the swarm or encrypt the file before upload if
stronger confidentiality is required. Availability depends on a copy existing somewhere: a CID whose
only holder is offline (and that no counterparty copied) cannot be fetched.
