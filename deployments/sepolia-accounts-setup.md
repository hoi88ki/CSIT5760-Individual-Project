# Account setup — TradeChain on sepolia (core 0x34A657C2b68CCda1b696f03dEf8c0a7a8A8728a6)

Date: 2026-11-25T17:54:51.917Z

## 1. Key validation

| Env key | Address | Valid | Distinct | ETH |
|---|---|---|---|---|
| IMPORTER_PRIVATE_KEY | `0x42687043F24511CdE610190c24505E09b60f7706` | yes | yes | 7.722365724937930082 |
| EXPORTER_PRIVATE_KEY | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | yes | yes | 0.09999999994035375 |
| BANK_PRIVATE_KEY | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | yes | yes | 0.09999999995648332 |
| LOGISTICS_PRIVATE_KEY | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | yes | yes | 0.099999999958152085 |
| VERIFIER_PRIVATE_KEY | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | yes | yes | 0.099999999978164948 |
| ADMIN_PRIVATE_KEY (deployer) | `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664` | yes | yes | 8.687977831703626289 |

ADMIN holds DEFAULT_ADMIN_ROLE on the core: yes

## 2. ETH funding from the ADMIN account

| Account | Address | Before (ETH) | Sent (ETH) | Tx |
|---|---|---|---|---|
| IMPORTER | `0x42687043F24511CdE610190c24505E09b60f7706` | 7.722365724937930082 | skipped | — (already funded) |
| EXPORTER | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | 0.09999999994035375 | skipped | — (already funded) |
| BANK | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | 0.09999999995648332 | skipped | — (already funded) |
| LOGISTICS | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | 0.099999999958152085 | skipped | — (already funded) |
| VERIFIER | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | 0.099999999978164948 | skipped | — (already funded) |

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
| BANK | skipped | 975000.0 | — (already funded) |
| IMPORTER | 1000000.0 | 1010000.0 | [0x0069af93…](https://sepolia.etherscan.io/tx/0x0069af93c7161ebc3237e197586d062e51ab60e2a110ba6017ce5773198ea025) |
| EXPORTER | skipped | 35000.0 | — (already funded) |

Escrow account (LetterOfCredit module): `0xFaA7C6C17fE1043b9f354d9Bd3bA55e25199919C`

## 5. TradeUSD allowances (core escrow/duty + credit reimbursement pull-payment)

| Account | Core allowance | Credit allowance | Tx |
|---|---|---|---|
| IMPORTER | sufficient | sufficient | — |
| EXPORTER | sufficient | sufficient | — |
| BANK | sufficient | sufficient | — |

> The ADMIN/deployer also retains its originally granted roles from the single-account
> deployment; the workflow demo (`scripts/demo-accounts.js`) signs every step with the
> distinct account above.
