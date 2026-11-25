# Account setup — TradeChain on sepolia (core 0xCcE6bd88756759B8A02318a61d37e15BB1781520)

Date: 2026-11-25T15:15:26.357Z

## 1. Key validation

| Env key | Address | Valid | Distinct | ETH |
|---|---|---|---|---|
| IMPORTER_PRIVATE_KEY | `0x42687043F24511CdE610190c24505E09b60f7706` | yes | yes | 7.72236572499812015 |
| EXPORTER_PRIVATE_KEY | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | yes | yes | 0.0 |
| BANK_PRIVATE_KEY | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | yes | yes | 0.0 |
| LOGISTICS_PRIVATE_KEY | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | yes | yes | 0.0 |
| VERIFIER_PRIVATE_KEY | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | yes | yes | 0.0 |
| ADMIN_PRIVATE_KEY (deployer) | `0xCE4b0826b1B5d4bEA67EED5212Ae0AA5ec6c8664` | yes | yes | 9.166138812686171745 |

ADMIN holds DEFAULT_ADMIN_ROLE on the core: yes

## 2. ETH funding from the ADMIN account

| Account | Address | Before (ETH) | Sent (ETH) | Tx |
|---|---|---|---|---|
| IMPORTER | `0x42687043F24511CdE610190c24505E09b60f7706` | 7.72236572499812015 | skipped | — (already funded) |
| EXPORTER | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | 0.0 | 0.1 | [0x2529b47a…](https://sepolia.etherscan.io/tx/0x2529b47ae55b0422e11e84616ac73c2b3207e64e809796342cb9c1f1c2adb261) |
| BANK | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | 0.0 | 0.1 | [0xc211c484…](https://sepolia.etherscan.io/tx/0xc211c484174de21c429259074b05546e75ebb18fa5c8a52b237d11b5ae2dad77) |
| LOGISTICS | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | 0.0 | 0.1 | [0xe202118e…](https://sepolia.etherscan.io/tx/0xe202118ec8d2825dc90b27963c7dc5cf600402e03e6481442633165b205ee97e) |
| VERIFIER | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | 0.0 | 0.1 | [0x364f547c…](https://sepolia.etherscan.io/tx/0x364f547c26129c612bb285aab5b9e309846ad7947868423e1a777afd378d8fa7) |

## 3. Role assignment (`grantRoles`, one transaction for all five)

| Role | Account | Holder |
|---|---|---|
| `ROLE_IMPORTER` | `0x42687043F24511CdE610190c24505E09b60f7706` | applicant (L/C importer) |
| `ROLE_EXPORTER` | `0x6e5c0C765e7C5011cd561efdb8272Ab567D4156F` | beneficiary (exporter) |
| `ROLE_BANK` | `0xfcF3333Fc5269b59E8ddf0dF9D87A7C41bEAbc45` | issuing bank |
| `ROLE_LOGISTICS` | `0x8125b7BD0d9785E0DBb26C2FBa03dbe46F8C93C2` | carrier / logistics |
| `ROLE_VERIFIER` | `0xd836DE2d1b255100e4655680CE434Ed731Aef5A5` | verifier (inspection / insurance / customs) |

Grant transaction: [`0x91f88386f520…`](https://sepolia.etherscan.io/tx/0x91f88386f52009d413db3d5f2caf03f2d3b5e8c2b0fc06f064869527b52b5f98) (block 12210352, gas 587984) — ROLE_IMPORTER, ROLE_EXPORTER, ROLE_BANK, ROLE_LOGISTICS, ROLE_VERIFIER

## 4. Demo TradeUSD minting (the BANK funds L/C escrows)

| Account | Amount (tUSD) | Balance after | Tx |
|---|---|---|---|
| BANK | 1000000.0 | 1000000.0 | [0x0887b242…](https://sepolia.etherscan.io/tx/0x0887b2421e6a07fedaf95ca5f48b8f701ba7a29a1860e7fb53259c266b58f49e) |
| IMPORTER | 10000.0 | 10000.0 | [0x40759001…](https://sepolia.etherscan.io/tx/0x407590015b1050e1c9d4f70f779c1a2a4e9328e65bdab18e14b5d5b4287aa647) |
| EXPORTER | 10000.0 | 10000.0 | [0x88689b3c…](https://sepolia.etherscan.io/tx/0x88689b3c94fe62daad3a1f26c08ed6ac67edc3db55b3b99f8b82adc07c5e0554) |

Escrow account (LetterOfCredit module): `0xCC67ec9baed27A00f0f1DD7AaBEa194fcbeb8abd`

> The ADMIN/deployer also retains its originally granted roles from the single-account
> deployment; the workflow demo (`scripts/demo-accounts.js`) signs every step with the
> distinct account above.
