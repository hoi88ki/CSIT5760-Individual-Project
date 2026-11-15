# TradeChain — Change Log & Notes

Concise history of the changes made against the final proposal, plus any open clarifications.
Authoritative design rationale stays in [`docs/DESIGN_DECISIONS.md`](./docs/DESIGN_DECISIONS.md).

---

## 2026-11-15 — Post-review correctness fixes

A focused review of the contract suite surfaced three behavioural issues that were fixed, each with a
regression test. Six contracts, the deployment addresses and the public interface are unchanged.

| # | Issue | Fix | File | Test |
|---|-------|-----|------|------|
| 1 | **Risk holder ignored the Incoterm.** `confirmPickup` moved `riskHolder` to the importer for *every* Incoterm, contradicting the documented risk-transfer milestones (EXW at pickup, FOB/CIF on the vessel, DDP at destination). | `riskHolder` now moves at the correct milestone: EXW in `confirmPickup`, FOB/CIF in `confirmVesselLoading`, DDP in `_finalizeDelivery`. | `contracts/TradeChainCore.sol` | `Incoterms.e2e.test.js` ("FOB — risk passes … on the vessel", "DDP — risk passes only at final delivery") |
| 2 | **Duty escrow could be permanently stranded.** `payCustomsDuty` accepted a payment after the L/C had already paid out (EXW at pickup, FOB/CIF at loading). Since only `LetterOfCredit.settle` forwards duty to the treasury, that escrow had no exit path and locked funds forever. | `payCustomsDuty` reverts with the new `LCAlreadySettled(id)` once `letterOfCredit.isPaid(id)`. | `contracts/TradeChainCore.sol` | `AccessControl.test.js` ("cannot escrow duty once the L/C has been paid") |
| 3 | **`LCReclaimed` always reported `dutyRefund = 0`**, even when duty had been escrowed and refunded to its payer. | The event now reports the actual duty refunded (read from the L/C before `refund`). | `contracts/TradeChainCore.sol` | `Neutrality.test.js` (`withArgs(..., LC, 10n)`) |

Verification after the fixes: **87 passing** tests · coverage **100 % statements · 93.08 % branch ·
100 % functions · 100 % lines** · `solhint` clean.

---

## 2026-11-06 — Final proposal alignment, Sepolia deploy/verify, clean-up

### 1. Proposal review (final version)

The updated `CSIT5760_Project_Proposal_21232072.docx` was re-checked against the implementation and
the earlier merge (M1–M8) and v4 review items. **All substantive items are now applied**: six
contracts, no `ShipmentNFT`, e-B/L title wording, per-role IPFS nodes, ≥ 90 % branch bar, seven
document types incl. Customs Clearance, Architecture diagram in §5.1.

Two cosmetic, non-blocking observations only (safe to leave):

| Location | Observation |
|----------|-------------|
| §9 Phase 1 | still says Solidity `^0.8.20`; the repo compiles at `^0.8.24` (solc 0.8.28). Wording only. |
| §6 IPFS rationale | says "on-chain **hash** references"; the implementation stores **CIDs**. Cosmetic. |

Per the author's instruction, the **Workflow** diagram is intentionally deferred to the final
report; §5.1 keeps only the Architecture diagram.

### 2. IPFS model — final wording

- Model is **one kubo node per participant**; each role **keeps its own copy**, and any involved
  party can read a document **through the DApp** by pointing at the node that holds it.
- "Private swarm + manual pin" is **no longer presented as the design** — it survives only as an
  optional confidentiality note in `docs/IPFS_CONSORTIUM.md`.
- Docs updated to match: `docs/IPFS_CONSORTIUM.md`, `docs/ARCHITECTURE.md`, `docs/DESIGN_DECISIONS.md`
  (D15), `docs/REFACTOR_PLAN.md`, `docs/PROPOSAL_UPDATES.md`, `dapp/README.md`.

### 3. Code changes

| File | Change |
|------|--------|
| `dapp/src/ipfs.js` | Added `fetchFromKubo(cid, apiBase)` so any role can retrieve a document by CID through the DApp; header reworded to the per-role model. |
| `dapp/src/App.jsx` | New **Document viewer (any role)** panel (pick node + CID → open); IPFS hint text updated; imports `fetchFromKubo`. |
| `contracts/core/ComplianceEngine.sol` | Header comment: "six required documents" → the seven `DocType`s as the universe. |
| `contracts/TradeChainCore.sol` | Header comment: "deploys/wires the five companion contracts" → four companions + injected token. |
| `hardhat.config.js` | `etherscan.apiKey` switched to a single **Etherscan V2** key (the per-network map is deprecated and blocked verification). |

No behavioural/contract logic changes were required — the contracts already matched the proposal.

### 4. Repository clean-up

Removed/cleared legacy and generated clutter:

- **Deleted** `ProposalImprovement.md` (superseded; content folded into the docs).
- **Cleared** `QUESTIONS.md` (now a short pointer; no open questions).
- **Deleted** `.tmp_prop/` (scratch unzip of the proposal) and git-ignored `.tmp*/`, `tmp/`.
- **Deleted** `docs/diagrams/.$TradeChain.drawio.bkp` (stale draw.io backup).
- **Deleted** stale generated output: `coverage/`, `coverage.json`, `artifacts/`, `cache/`
  (they still referenced removed `ShipmentNFT`/`TradeCertNFT`/`EBLToken`).

### 5. Sepolia deployment & verification (OBJ-4)

Deployed and **verified all six contracts** on Ethereum Sepolia. Record:
[`deployments/sepolia.json`](./deployments/sepolia.json).

| Contract | Address |
|----------|---------|
| `TradeChainCore` | `0x2975F0E166A15e13dFb64efD6d55578DEef861Be` |
| `ShipmentTracker` | `0x9f85F3dca79BEEC07Fb50350637d1AA181BBF926` |
| `DocumentRegistry` | `0xFf79f12350DD6061A36d7268f5Ccb51764caA301` |
| `ComplianceEngine` | `0xC62187D99Fd6115eE8010d263230e305907b4ca5` |
| `LetterOfCredit` | `0x980A395218D6349a501508e4264b8b868c6F42AA` |
| `TradeUSD` | `0x1a2372BAEfb7bF6F50cafE08cc62EB32BB327ac4` |

Deployer: `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664`. Creation transactions:
`TradeUSD` `0xae37de9a9ffd296210c9b6105631d1087594519d693cdbeb573a2aefb0bb0ae4` (block 12070799);
`TradeChainCore` `0xbd8908fb8c9a10917bee57476fef25299b353ddda225d86f30fb69f3e43738c8` (block 12070801,
which also created the four companions in the constructor).

> **Note.** On a single-account network every role defaults to the deployer. To give roles distinct
> wallets, set `TRADECHAIN_EXPORTER` … `TRADECHAIN_VERIFIER` and re-run `scripts/deploy.js`.

### 6. Verification results (this pass)

| Check | Result |
|-------|--------|
| `npx hardhat compile` | 37 files, OK |
| `npx hardhat test` | **84 passing** |
| `npx hardhat coverage` | **100 % stmts · 92.74 % branch · 100 % funcs · 100 % lines** |
| `npx solhint "contracts/**/*.sol"` | 0 errors |
| `cd dapp && npm run build` | built OK |
| Sepolia deploy + `verify.js` | **all six verified** |

### 7. Documentation

- `README.md` rewritten: verified **Sepolia address table (§7)**, a new
  **Step-by-step Verification Walkthrough (§8)**, updated coverage/tech-stack/IPFS wording, and
  current structure.
- `CHANGES.md` (this file) added.

---

## Open clarifications

_None blocking._ Minor, optional:

1. **Proposal cosmetics** — the two §9/§6 wording nits above.
2. **Distinct role wallets on Sepolia** — currently all roles = deployer; optional redeploy with
   `TRADECHAIN_*` env if a per-role demo is preferred.
3. **`TradeUSD` seeding on Sepolia** — the deployer holds `MINTER_ROLE`; mint demo balances (and
   grant the core `MINTER_ROLE` if needed) before running a live demo.

## Still outstanding (not code)

- Demo video and the final project report.
- Optional: export the **Workflow** page of `docs/diagrams/TradeChain.drawio` for the report.
