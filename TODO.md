# TradeChain TODO — L/C workflow realism

## Background

The original prototype treated `openLetterOfCredit` as an importer-funded token escrow after the exporter had already created the shipment. It then paid the exporter automatically at the Incoterm risk-transfer phase. That is a useful escrow demo, but it does not represent a bank-issued documentary credit:

- The importer is the **applicant**: it requests a credit from its bank and agrees the commercial/payment terms.
- The issuing bank decides whether to issue the L/C, records the beneficiary and documentary terms, and undertakes to honor a complying presentation. The importer may reimburse or collateralize the bank separately; it is not normally the party that directly funds the exporter-facing L/C escrow.
- The exporter (beneficiary) should ship only after the L/C is operative, then present the stipulated documents.
- The issuing bank examines the presentation against the L/C. If compliant, it honors the credit according to the agreed term—at sight or after an agreed deferred period—not automatically at an Incoterm risk-transfer milestone.

## Proposed contract workflow

- [x] Importer creates an order/application and records requested sight or deferred payment terms. (`createOrder` with `PaymentTerm.Sight|Deferred` + deferral days)
- [x] Issuing-bank role issues an L/C against that application and provides the prototype's escrow funds. (`issueLetterOfCredit` — bank-only, pulls the credit amount from the bank into the escrow)
- [x] The named exporter can create the shipment only after the L/C is issued and operative. (`createShipment` requires phase `LCIssued` and the named beneficiary)
- [x] After shipment, the exporter records a presentation of the documents anchored for that trade. (`presentDocuments` — compliance-checked, pre-expiry)
- [x] The issuing bank examines the presentation against the L/C's required-document list and the on-chain CID/verification state. (`honorPresentation` re-examines the stipulated set inside the module; `examinePresentation` view previews it)
- [x] The bank honors a compliant presentation: at sight after examination, or after the agreed deferral. (sight pays immediately; deferred schedules `maturityAt` and `drawDeferredPayment` releases the proceeds permissionless)
- [x] Expired, unused L/C funds return to the issuing bank rather than directly to the importer. (`reclaimExpiredLC` → issuing bank; shipped-but-unpresented title returns to the exporter)
- [x] Update tests, both UIs, scripts, ABIs, README and architecture/security documentation to use the new order → issuance → shipment → presentation → examination → honor sequence. (130 tests passing · 100 % stmts / 98.76 % branch; `ui/index.html` + React `dapp/` reworked; `seed-demo.js` reworked; `docs/FRONTENDS.md` gains a click-by-click multi-account UI simulation; README / ARCHITECTURE / SECURITY / DESIGN_DECISIONS / CHANGES updated)

### Implementation verification (25 November 2026)

- [x] `npx hardhat test` → 130 passing; `npx hardhat coverage` → 100 % stmts · 98.76 % branch · 100 % funcs · 100 % lines; `npx solhint` clean; core initcode 49,334 B (< 49,152 EIP-3860 limit).
- [x] `seed-demo.js` on a local node: EXW/FOB/CIF/DDP sight flows, a deferred (+3d) CIF flow with a maturity draw, and an expired unused credit reclaimed to the issuing bank.
- [x] Both front ends simulated end-to-end in a browser against a local Hardhat node with six distinct accounts (admin, importer, bank, exporter, logistics, verifier), including the negative paths: shipping before issuance and presenting before the B/L exists are refused in the UI; the deferred draw and the expiry reclaim were exercised via chain-time advance. Final on-chain state re-checked: trades #1/#2/#4 `Settled` (title with the importer), trade #3 `Reclaimed` (escrow emptied, funds with the bank).

## Scope assumptions and limitations to record during implementation

- This remains a teaching model. Prefunding the on-chain escrow makes the bank's undertaking deterministic, but real L/Cs are generally contingent bank obligations and may be supported by a credit line or collateral rather than 100% cash prefunding.
- On-chain examination can prove only that required document slots are anchored and currently verified. The contract cannot read IPFS file contents, assess documentary wording, apply UCP 600/ISBP rules, or make legal discrepancy decisions; the bank role remains a trusted examiner.
- Deferred terms are represented as elapsed calendar time after acceptance. Banking-day calendars, holidays, formal presentation windows, amendments, partial drawings, negotiation/confirmation, and refusal/discrepancy notices remain future work.
- **Explicitly outside this requested change:** e-B/L/title-transfer behavior and customs-duty/logistics semantics.
