# Open Questions & Working Assumptions — `TradeChain`

> Per the project instruction, questions are collected here **instead of interrupting the
> conversation**. Each question is paired with the **assumption** that was adopted so that
> implementation could proceed without blocking. Anything marked *(confirm)* should be verified
> with the instructor before the final submission.

_Last updated: 2026-11-05._

---

## 1. Scope & interfaces

| # | Question | Working assumption | Answer |
|---|----------|--------------------|--------|
| Q1 | `createShipment(...)` has no `buyer` parameter. Who is the Buyer and when is it fixed? *(confirm)* | The **caller of `openLetterOfCredit(id)` becomes the Buyer**. The Seller creates the shipment; the Importer funds it. | The buyer should create the order first before create Shipment |
| Q2 | Should the insurance premium and `fileDamageClaim`/`resolveInsuranceClaim` (shown in the diagram but absent from §4) be in scope? | **Yes, but optional** — implemented in a separate `InsuranceModule` so it never blocks the core L/C flow. | Insurance Module is not required, the architecture is not latest |
| Q3 | `payCustomsDuty(id)` has no amount. Must `msg.value` match a quoted duty? | Accepted any `msg.value > 0` and recorded it. A quoted-duty improvement is proposed in `ProposalImprovement.md` (B3). | Please also accept CustomsDuty = 0 for some places that have no duty, or just remove the function |
| Q4 | `anchorDocument` — exactly which of the 7 `DocType`s may it anchor? | Only the **4 verifier types** (CoO, Inspection, Insurance, Clearance). Invoice + packing list are set in `createShipment`; the B/L is set in `confirmVesselLoading`. | Please refer to below Table |
``` 
    CommercialInvoice,      // 0 — Seller    (at createShipment)
    PackingList,            // 1 — Seller    (at createShipment)
    CertificateOfOrigin,    // 2 — Seller    (anchorDocument)
    InspectionCertificate,  // 3 — VERIFIER (inspection body) → mints TradeCertNFT
    InsuranceCertificate,   // 4 — VERIFIER (insurer)           → mints TradeCertNFT
    BillOfLadingOrAWB,      // 5 — Carrier   (at confirmVesselLoading; drives EBLToken.tokenURI)
    CustomsClearance        // 6 — VERIFIER (customs officer)   → mints TradeCertNFT 
``` 

| Q5 | Who may burn (revoke) a `TradeCertNFT`? | The **original issuer** of that `DocType` (its authorised role) or the **admin**. | It depends, but looks fine right now |
| Q6 | What does "all objective milestones are complete" mean for either-bank `forceFinalizeDelivery`? *(confirm)* | `LoadedOnVessel` reached **and** the full delivery document set anchored (**+** duty paid for DDP). | You can design, just document well and avoid any security issue/dispute |
| Q7 | Can an expired L/C be reclaimed after the goods were picked up? | **No.** Reclaim is allowed only from `LCFunded` (Seller never shipped), preserving the risk-transfer guarantee. | Agree |

## 2. Economics & settlement

| # | Question | Working assumption | Answer |
|---|----------|--------------------|--------|
| Q8 | Is settlement in native ETH or an ERC-20 (stablecoin)? | **Native ETH.** A mock ERC-20 settlement token is a stretch goal (`OZ SafeERC20` is already integrated). | If possible, i might prefer stablecoin contract |
| Q9 | Are partial payouts or instalments in scope? | **No.** A single **100 % atomic payout** at the risk-transfer milestone, as stated. | Agree |
| Q10 | Who pays gas for `reclaimExpiredLC`? | Anyone (permissionless); the caller pays gas and cannot profit. | I think only the issuer (bank), the owner (buyer), admin could do |
| Q11 | Is the customs duty refunded on expiry-reclaim? | **Yes** — refunded to whoever paid it (`dutyPayer`). | Please see if include duty in the project, some country have no import duty |

## 3. Data & storage

| # | Question | Working assumption | Answer |
|---|----------|--------------------|--------|
| Q12 | Which IPFS pinning service? | **Pinata** (per proposal). The contracts only consume CIDs, so the choice is not consensus-critical. | I prefer something that run local, so i can verify |
| Q13 | Should document contents be encrypted (commercial confidentiality)? | **Out of scope** for this version; only CIDs are stored. Noted as future work. | No need encrypt, i temperaory frame as local/restricted access |
| Q14 | Should the eB/L be tradeable/transferable by the holder before delivery? | **No.** The core escrows it and releases it to the Buyer at final delivery. | Agree |
| Q15 | Are documents identified by `ipfs://<cid>` or bare CID? | Bare **CIDv1 string** stored on-chain; the `ipfs://` prefix is applied in the DApp layer. | Agree |

## 4. Evaluation & deployment

| # | Question | Working assumption | Answer |
|---|----------|--------------------|--------|
| Q16 | Which coverage metric is authoritative for "≥ 90 %"? | Target **all four** (statements, branches, functions, lines) ≥ 90 %, prioritising branches. | I prefer as far as possible |
| Q17 | Sepolia only, or also a local hardhat network for the demo? | Both — full suite on the local Hardhat network; the demo is deployed/verified on Sepolia. | Agree, you can use hardhat to test |
| Q18 | Is a hosted DApp required, or is a local dashboard acceptable? | A **local minimal role dashboard** is acceptable; hosting is optional. | hosting optional, but i need a working interface, can be a simple one |
| Q19 | Should we implement `nonReentrant` on the internal `_triggerAtomicPayout` (as the proposal says) or on the external entry points? | On the **internal payout function** (as written), because that is where value leaves the contract; external functions are additionally protected by state-machine guards. | Agree |
| Q20 | Repository name: the proposal URL is `CSIT5760-Individual-Project` but the local folder is `CSIT5760/Project`. *(confirm)* | Assume the GitHub URL is authoritative; the local folder name is cosmetic. | I will change later |

---

### How to answer

Please annotate the relevant row above (e.g. `Q1: …`) or reply inline. Anything not answered will
keep the stated working assumption.
