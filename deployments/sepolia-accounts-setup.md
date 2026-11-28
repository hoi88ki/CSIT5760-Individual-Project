# Account setup — TradeChain on sepolia (core 0x06365Fbcedc05f1e3751D993Ef933F8c931e0651)

Date: 2026-11-28T07:20:56.761Z

## 1. Key validation

| Env key | Address | Valid | Distinct | ETH |
|---|---|---|---|---|
| IMPORTER_PRIVATE_KEY | `0x42687043F24511CdE610190c24505E09b60f7706` | yes | yes | 7.721000690887612627 |
| EXPORTER_PRIVATE_KEY | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | yes | yes | 1.098014614893518633 |
| BANK_PRIVATE_KEY | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | yes | yes | 1.099250715924413491 |
| LOGISTICS_PRIVATE_KEY | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | yes | yes | 1.097444461918041154 |
| VERIFIER_PRIVATE_KEY | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | yes | yes | 0.099999999969065918 |
| ADMIN_PRIVATE_KEY (deployer) | `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664` | yes | yes | 5.467835756793793972 |

ADMIN holds DEFAULT_ADMIN_ROLE on the core: yes

## 2. ETH funding from the ADMIN account

| Account | Address | Before (ETH) | Sent (ETH) | Tx |
|---|---|---|---|---|
| IMPORTER | `0x42687043F24511CdE610190c24505E09b60f7706` | 7.721000690887612627 | skipped | — (already funded) |
| EXPORTER | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | 1.098014614893518633 | skipped | — (already funded) |
| BANK | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | 1.099250715924413491 | skipped | — (already funded) |
| LOGISTICS | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | 1.097444461918041154 | skipped | — (already funded) |
| VERIFIER | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | 0.099999999969065918 | skipped | — (already funded) |

## 3. Role assignment (`grantRoles`, one transaction for all five)

| Role | Account | Holder |
|---|---|---|
| `ROLE_IMPORTER` | `0x42687043F24511CdE610190c24505E09b60f7706` | applicant (L/C importer) (already held) |
| `ROLE_EXPORTER` | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | beneficiary (exporter) (already held) |
| `ROLE_BANK` | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | issuing bank (already held) |
| `ROLE_LOGISTICS` | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | carrier / logistics (already held) |
| `ROLE_VERIFIER` | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | verifier (inspection / insurance / customs) (already held) |

All roles already held — no grant transaction needed.

## 4. Demo TradeUSD minting (the BANK funds L/C escrows)

| Account | Amount (tUSD) | Balance after | Tx |
|---|---|---|---|
| BANK | 1000000.0 | 1000000.0 | [0xed1295a7…](https://sepolia.etherscan.io/tx/0xed1295a7a0ab37256a979738a9e75f314a61ebd9d3f2919e0dec48c25fe37f11) |
| IMPORTER | 1000000.0 | 1000000.0 | [0xe7f701d6…](https://sepolia.etherscan.io/tx/0xe7f701d6573d42a5dc9ce61de56e6cdc59d927e61ec703133ffe286419aae0c4) |
| EXPORTER | 10000.0 | 10000.0 | [0x991cf188…](https://sepolia.etherscan.io/tx/0x991cf1882bff3391fc9d190097ebb0d5c5d75fb9fe97a711eb89aaaa1c178494) |

Escrow account (LetterOfCredit module): `0x5944D815389E2202CFae38fcb42c1416ff92d828`

## 5. TradeUSD allowances (core escrow/duty + credit reimbursement pull-payment)

| Account | Core allowance | Credit allowance | Tx |
|---|---|---|---|
| IMPORTER | max (set) | max (set) | set by IMPORTER |
| EXPORTER | max (set) | max (set) | set by EXPORTER |
| BANK | max (set) | max (set) | set by BANK |

> The ADMIN/deployer also retains its originally granted roles from the single-account
> deployment; the workflow demo (`scripts/demo-accounts.js`) signs every step with the
> distinct account above.
