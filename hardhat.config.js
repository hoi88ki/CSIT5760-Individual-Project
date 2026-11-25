// SPDX-License-Identifier: MIT
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  SEPOLIA_RPC_URL = "",
  PRIVATE_KEY = "",
  ETHERSCAN_API_KEY = "",
  REPORT_GAS = "false",
} = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    // Compiler 0.8.28 satisfies the `^0.8.24` source pragma and provides the `mcopy`
    // builtin required by OpenZeppelin v5.6 (MCOPY, EVM Cancun).
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // The core's constructor embeds its four companions' creation code, so every byte
      // saved per contract counts four times toward the EIP-3860 initcode cap (49,152 B,
      // enforced on Sepolia). Dropping the metadata hash saves ~53 B per contract without
      // affecting Etherscan source verification.
      metadata: {
        bytecodeHash: "none",
      },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Pin the pre-Osaka hardfork for the local network: from Osaka, EIP-7825 caps a single
      // transaction at 2^24 gas, which the instrumented core deployment exceeds under coverage.
      hardfork: "cancun",
      // Deterministic accounts; a high gas limit keeps E2E flows cheap to script and lets the
      // core's constructor deploy the six companion contracts even under coverage instrumentation.
      blockGasLimit: 0x1fffffffffffff,
      // The core's init code embeds its four companions (~42 kB, 85 % of the EIP-3860 limit).
      // Coverage instrumentation roughly doubles it, so the *local* network must not enforce the
      // init-code cap. Sepolia enforces it: the production build stays at ~42 kB (< 49,152).
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
  etherscan: {
    // A single Etherscan.io API key (Etherscan V2). The v2 endpoint resolves the chain
    // from the network, so the old per-network mapping is no longer required.
    apiKey: ETHERSCAN_API_KEY,
  },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
    excludeContracts: ["mocks/"],
  },
  mocha: {
    timeout: 180000,
  },
};
