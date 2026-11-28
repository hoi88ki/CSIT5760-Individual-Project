# TradeChain — Security Notes

## 1. Trust model

- **Roles are trusted.** `AccessControl` roles are granted by the admin. Verifiers follow a
  **trusted-oracle** model: they are trusted to have validated off-chain content before anchoring.
  The **issuing bank is a trusted examiner**: the contract can prove that every stipulated document
  slot is anchored and currently verified, but it cannot read IPFS contents, assess documentary
  wording, or apply UCP 600/ISBP discrepancy rules — honoring is the bank's role-gated decision.
- **Docs are tamper-evident, not private.** Only CIDs are on-chain. A **live** anchor is immutable —
  anchoring over it reverts. Corrections go through role-gated paths that are fully audited:
  `replaceDocument` (designated role, original issuer or admin) swaps a CID and emits
  `DocumentReplaced` with the previous CID, and a revoked slot can be re-anchored. Verification can
  be revoked and is re-checked at examination time. Closed trades (settled/reclaimed) reject
  anchoring, replacement and revocation, so their record stays final.
- **The settlement token is trusted.** `TradeUSD` is injected; a malicious token cannot break
  `nonReentrant`/CEI (proved by `MaliciousReentrancy`), but could censor transfers.
- **Only the core mutates.** Every companion's mutators are gated by a `CONTROLLER_ROLE` that only
  the core holds, and each module's `AccessControl` is mounted on the core (the core holds
  `DEFAULT_ADMIN_ROLE` and administers module roles via `setModuleRole`), so module state can only
  change through the role-gated facade.
- **The escrow is bank money.** The issuing bank — never the importer — prefunds the credit at
  issuance, which makes the honor undertaking deterministic (100% cash-collateralised). Real L/Cs
  are contingent obligations backed by credit lines; this is a teaching model. The applicant's
  **reimbursement is settled on-chain** (`reimburseIssuingBank`, possible once the proceeds are
  released) and recorded on the credit; *enforcing* a non-paying applicant remains off-chain.
- **The document registry is swappable, and the swap is guarded.** `setDocumentRegistry` accepts
  only a registry bound to this core whose runtime code matches the deployment-time registry, so a
  look-alike contract cannot forge `isValid` for compliance. Anchors snapshot their registry, so a
  swap never hides already-anchored documents.
- **Title transfer is core-only.** The e-B/L ERC-721 lives in `ShipmentTracker`; `_update` rejects
  every externally initiated transfer, so the holder cannot bypass the milestone gate with
  `transferFrom`/`safeTransferFrom`. Only the core's `transferTitle` moves the title (at final
  delivery — or back to the exporter when an unused expired credit is reclaimed).

## 2. Threat table

| Threat | Failure scenario | Mitigation (code) | Evidence (tests) |
|--------|------------------|-------------------|------------------|
| **Documentary fraud** | Honor without a mandatory document; CID replaced after issuance | `ComplianceEngine.requirePresentationCompliant` at presentation **and** re-examined inside `LetterOfCredit.honor`; `DocumentRegistry` replacement is role-gated (designated role, original issuer or admin), refused once the trade settles, and every swap is logged with the previous CID (`DocumentReplaced`) | `Incoterms.e2e`, `DocumentRegistry`, `ComplianceEngine`, `Modules` |
| **Shipping without a credit** | The exporter ships before the bank has issued an operative credit | `createShipment` requires phase `LCIssued` (set only by bank issuance); the named-beneficiary check blocks any other exporter | `Order`, `AccessControl` |
| **Unauthorized attestation** | Exporter self-signs a certificate | Per-`DocType` role check in `TradeChainCore.anchorDocument` | `DocumentRegistry`, `AccessControl` |
| **Revoked attestation** | Certificate revoked after being relied upon | `DocumentRegistry.revoke` clears `verified`; presentation requires validity and the bank re-examines before honoring | `DocumentRegistry` revocation tests, `Incoterms.e2e` ("revoked … refuse") |
| **Unauthorized honor** | A non-bank (or the beneficiary) honors its own presentation | `honorPresentation` is `ROLE_BANK`-gated; the module re-checks compliance independently of the core | `AccessControl`, `Modules` |
| **Reentrancy** | Malicious ERC-20 transfer callback / ERC-721 receiver hook | `nonReentrant` on `LetterOfCredit.honor`/`drawDeferred`/`reclaim` + strict CEI + `SafeERC20` | `Reentrancy.test.js` (sight honor and deferred draw) |
| **Stablecoin inflation** | Anyone mints `TradeUSD` | `mint` is `MINTER_ROLE`-gated | `Tokens.test.js` |
| **Settlement stall (importer)** | Importer withholds delivery | Either bank may `forceFinalizeDelivery` | `Neutrality` |
| **Settlement stall (bank, deferred)** | The bank never triggers the maturity payout | `drawDeferredPayment` is permissionless after `maturityAt` — the undertaking is deterministic; a deferred credit honored after delivery stays `Honored` (never `Settled`) until the draw pays it, so the proceeds can never be stranded | `Incoterms.e2e` (deferred flow, drawn by a third party) |
| **Closed-trade tampering** | Anchoring, replacing or revoking a document after the trade settled/reclaimed, rewriting the record of a finished trade | `anchorDocument`, `replaceDocument` and `revokeDocument` all run `_requireActive` — a closed trade is final | `DocumentRegistry`, `Incoterms.e2e` (closed-trade guards) |
| **Settlement stall (exporter)** | The exporter never ships | Expired unused credit is reclaimed **to the issuing bank** (importer/bank/admin may trigger) | `Neutrality` |
| **Applicant reimbursement default** | The importer never pays the bank back after the proceeds are released | The debt is recorded on-chain (`LC.reimbursed` flag + `LCReimbursed` event; `reimburseIssuingBank` is importer-only and pull-based); non-payment is a legal/credit-line matter, as with real L/Cs | `Incoterms.e2e`, `Modules` |
| **Stranded duty escrow** | Duty escrowed *after* the proceeds were released would never reach the treasury | `payCustomsDuty` reverts `LCAlreadySettled` once `LetterOfCredit.isPaid(id)`; DDP duty must be paid before honor | `AccessControl.test.js`, `Incoterms.e2e` (DDP gate) |
| **Unauthorized milestone** | Wrong role advances custody / mints the title | `onlyRole` + per-trade beneficiary/importer checks + custody guards | `AccessControl` |
| **Unauthorized title transfer** | Holder sells/endorses the e-B/L before final delivery | `ShipmentTracker._update` rejects public ERC-721 transfers; only the core can `transferTitle` | `Tokens.test.js` (public `transferFrom` reverts) |
| **Forged compliance via a swapped registry** | A look-alike "registry" answering `isValid == true` is swapped in, releasing the escrow with no documents | `setDocumentRegistry` requires a registry bound to this core *and* matching the deployment-time runtime codehash; only the admin or `ROLE_REGISTRY_ADMIN` may swap | `RegistrySwap.test.js` (`RegistryInvalidCode`) |
| **Orphaned documents after a registry swap** | Replacing the registry would hide previously anchored documents and stall in-flight trades | The core snapshots the registry per `(trade, DocType)`; `ComplianceEngine` resolves the registry that holds each anchor | `RegistrySwap.test.js` ("routes new anchors … while old anchors keep resolving") |
| **Bad input** | Empty CID, zero/oversized payment, past deadline, deferral/term mismatch | Custom-error guards + allowance failures (`InvalidDeferral`, `CreditExpired`, …) | `Order`, `DocumentRegistry`, `Modules` |
| **Integer overflow** | Counter/amount overflow | Solidity 0.8 checked arithmetic | compiler default |

## 3. Static analysis

- **Solhint** (`solhint:recommended`).
- **Slither** in CI (`fail-on: high`) with `slither.config.json`; mocks/dependencies filtered.

## 4. Test & coverage evidence

```
npx hardhat test        # 143 passing
npx hardhat coverage    # statements 100% · branches 96.89% · functions 100% · lines 100%
```

Mocks are excluded from the coverage denominator via `.solcover.js`.

## 5. Known limitations & future work

- **Trusted examination.** On-chain examination proves only that required document slots are
  anchored and currently verified. The contract cannot read IPFS contents, assess documentary
  wording, or make UCP 600/ISBP discrepancy decisions; the bank remains a trusted examiner.
- **No refusal / discrepancy notices.** A timely, compliant presentation locks the credit until the
  bank honors it — there is no on-chain refusal path (UCP 600 Art. 16). If the bank stalls, funds
  and title stay escrowed; refusal/discrepancy notices are future work.
- **100% cash prefunding.** The bank prefunds every credit, making the undertaking deterministic
  but unlike real contingent L/Cs backed by credit lines or collateral.
- **Deferred terms are elapsed calendar time after acceptance.** Banking-day calendars, holidays,
  formal presentation windows, amendments, partial drawings and negotiation/confirmation are future
  work.
- **Reclaim covers only unused credits.** A credit whose beneficiary shipped but never presented
  returns its funds to the bank and the title to the exporter; a *presented* credit is "used" and
  can only be honored (or refused off-chain).
- **Duty is unquoted.** `payCustomsDuty` accepts any amount ≥ 0; production should require a
  verifier-signed duty quote.
- **No pull-payment fallback.** Honor uses `safeTransfer`; a token-level block would strand a
  settlement until resolved off-chain.
- **Single bank / single verifier roles.** Production should split issuing/advising banks and the
  inspection/insurance/customs verifiers, and/or use multisigs.
- **No dispute mechanism** (by design — see `docs/DESIGN_DECISIONS.md` D13); commercial disputes are
  handled off-chain, with the reclaim and force-finalize safeguards providing on-chain neutrality.
- **Not audited.** Academic prototype; do not deploy with real value.
