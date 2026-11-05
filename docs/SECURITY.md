# TradeChain — Security Notes

## 1. Trust model

- **Roles are trusted.** `AccessControl` roles are granted by the admin. Verifiers follow a
  **trusted-oracle** model: they are trusted to have validated off-chain content before anchoring.
- **Docs are tamper-evident, not private.** Only CIDs are on-chain. An anchor is locked once written
  (no silent CID replacement); verification can be revoked and is checked at payout.
- **The settlement token is trusted.** `TradeUSD` is injected; a malicious token cannot break
  `nonReentrant`/CEI (proved by `MaliciousReentrancy`), but could censor transfers.
- **Only the core mutates.** Every companion rejects non-core callers (`OnlyCore`), so module state
  can only change through the role-gated facade.

## 2. Threat table

| Threat | Failure scenario | Mitigation (code) | Evidence (tests) |
|--------|------------------|-------------------|------------------|
| **Documentary fraud** | Payout without a mandatory document; CID replaced after funding | `ComplianceEngine.requireCompliant`; `DocumentRegistry` anchor-once-then-lock | `Incoterms.e2e`, `DocumentRegistry`, `ComplianceEngine` |
| **Unauthorized attestation** | Exporter self-signs a certificate | Per-`DocType` role check in `TradeChainCore.anchorDocument` | `DocumentRegistry`, `AccessControl` |
| **Revoked attestation** | Certificate revoked after being relied upon | `DocumentRegistry.revoke` clears `verified`; checked at compliance time | `DocumentRegistry` revocation tests |
| **Reentrancy** | Malicious ERC-20 transfer callback / ERC-721 receiver hook | `nonReentrant` on `LetterOfCredit.settle`/`refund` + strict CEI + `SafeERC20` | `Reentrancy.test.js` (single payout) |
| **Stablecoin inflation** | Anyone mints `TradeUSD` | `mint` is `MINTER_ROLE`-gated | `Tokens.test.js` |
| **Settlement stall (importer)** | Importer withholds delivery | Either bank may `forceFinalizeDelivery` | `Neutrality` |
| **Settlement stall (exporter)** | Exporter never ships | Deadline reclaim by importer/bank/admin | `Neutrality` |
| **Unauthorized milestone** | Wrong role advances the shipment or mints | `onlyRole` + per-shipment importer/exporter checks | `AccessControl` |
| **Bad input** | Empty CID, zero/oversized payment, past deadline | Custom-error guards + allowance failures | `Order`, `DocumentRegistry`, `Modules` |
| **Integer overflow** | Counter/amount overflow | Solidity 0.8 checked arithmetic | compiler default |

## 3. Static analysis

- **Solhint** (`solhint:recommended`).
- **Slither** in CI (`fail-on: high`) with `slither.config.json`; mocks/dependencies filtered.

## 4. Test & coverage evidence

```
npx hardhat test        # 77 passing
npx hardhat coverage    # statements ~98% · branches ~87% · functions ~96% · lines ~98%
```

Mocks are excluded from the coverage denominator via `.solcover.js`.

## 5. Known limitations & future work

- **Duty is unquoted.** `payCustomsDuty` accepts any amount ≥ 0; production should require a
  verifier-signed duty quote.
- **No pull-payment fallback.** Payout uses `safeTransfer`; a token-level block would strand a
  settlement until resolved off-chain.
- **Single bank / single verifier roles.** Production should split issuing/advising banks and the
  inspection/insurance/customs verifiers, and/or use multisigs.
- **No dispute mechanism** (by design — see `docs/DESIGN_DECISIONS.md` D13); commercial disputes are
  handled off-chain, with the reclaim and force-finalize safeguards providing on-chain neutrality.
- **Not audited.** Academic prototype; do not deploy with real value.
