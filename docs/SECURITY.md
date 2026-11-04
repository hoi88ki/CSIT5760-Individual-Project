# TradeChain — Security Notes

## 1. Trust model

- **Roles are trusted.** `AccessControl` roles are granted by the admin. Verifiers follow a
  **trusted-oracle** model: they are trusted to have validated the off-chain content before
  anchoring a CID / minting a certificate.
- **Docs are tamper-evident, not private.** Only CIDs are on-chain. Immutability of the anchor
  plus the CID's content addressing make later substitution detectable.
- **The settlement token is trusted.** The core uses the injected ERC-20 via `SafeERC20`; a
  malicious token cannot break `nonReentrant`/CEI invariants but could censor transfers.

## 2. Threat table

| Threat | Failure scenario | Mitigation (code) | Evidence (tests) |
|--------|------------------|-------------------|------------------|
| **Documentary fraud** | Payout attempted without a mandatory document; a CID replaced after funding | Per-milestone `requireDocuments(bitmask)`; `DocRecord.locked` anchor-once-then-lock | `Incoterms.e2e` (missing insurance at CIF, missing clearance/duty at DDP), `DocumentRegistry` (DocumentLocked) |
| **Unauthorized attestation** | Exporter self-signs a regulatory certificate / forges an NFT | Certificates mint only inside the role-gated `anchorDocument`/`confirmVesselLoading`; per-`DocType` role lookup | `DocumentRegistry` (Unauthorized), `AccessControl` |
| **Forged / traded certificate** | A certificate is revoked after being relied upon | Revocation burns the NFT; `_hasValidDocument` checks `certNFT.exists` at payout | `DocumentRegistry` revocation tests |
| **Reentrancy** | A malicious settlement token re-enters during payout | `nonReentrant` on `_triggerAtomicPayout` + strict CEI (state finalised before transfer) | `Reentrancy.test.js` (`MaliciousReentrancy` token; guard error asserted) |
| **Settlement stall (Buyer)** | Buyer withholds `confirmFinalDelivery` | Either bank may `forceFinalizeDelivery` once objective milestones complete | `Neutrality` (advising-bank force-finalize) |
| **Settlement stall (Seller)** | Seller never ships / bank blocks reclaim | Buyer-issued reclaim after deadline; issuing bank or admin can also reclaim | `Neutrality` (reclaim authority + timeout) |
| **Unauthorized milestone** | Wrong role advances the shipment | `onlyRole` + per-shipment buyer/seller checks | `AccessControl` |
| **Bad input** | Empty CID, zero/oversized payment, past deadline | Custom-error guards (`EmptyCID`, `InvalidAmount`, `InvalidDeadline`, allowance failures) | `Order`, `DocumentRegistry` |
| **Integer overflow** | Arithmetic overflow in counters/amounts | Solidity 0.8 checked arithmetic | compiler default |

## 3. Static analysis

- **Solhint** (`solhint:recommended`) — 0 errors, 0 warnings.
- **Slither** — run in CI (`fail-on: high`) with `slither.config.json`; mocks and dependencies are
  filtered out. No High/Medium findings are tolerated for release.

## 4. Test & coverage evidence

```
npx hardhat test        # 67 passing
npx hardhat coverage    # statements 100% · branches 95.93% · functions 100% · lines 100%
```

All four metrics exceed the ≥ 90 % success criterion. Mocks are excluded from the coverage
denominator via `.solcover.js`.

## 5. Known limitations & future work

- **Duty is unquoted.** `payCustomsDuty` accepts any amount ≥ 0 (including 0); a production
  system should require `msg.value`/allowance to match a verifier-signed duty quote.
- **No pull-payment fallback.** Payout uses `safeTransfer`; a token-level block would strand a
  settlement until resolved off-chain.
- **Verifier centralisation.** One shared verifier role for inspection, insurance and customs in
  the demo; production should split these and/or use multi-signatures.
- **Not audited.** This is an academic prototype; do not deploy with real value.
