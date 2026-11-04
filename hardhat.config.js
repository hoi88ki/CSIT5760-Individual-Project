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
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Deterministic accounts; a high gas limit keeps E2E flows cheap to script.
      allowUnlimitedContractSize: false,
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
    apiKey: {
      sepolia: ETHERSCAN_API_KEY,
    },
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
