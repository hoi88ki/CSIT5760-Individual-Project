// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {SettlementModule} from "./core/SettlementModule.sol";
import {EBLToken} from "./tokens/EBLToken.sol";
import {TradeCertNFT} from "./tokens/TradeCertNFT.sol";

/// @title TradeChainCore — composition root / single entry point
/// @notice Inherits every module and deploys + owns the standalone `EBLToken` and `TradeCertNFT`.
///         One storage layout, one deployment address, no proxies.
/// @dev    The deployer becomes DEFAULT_ADMIN_ROLE and grants the six operational roles.
contract TradeChainCore is SettlementModule, IERC721Receiver {
    /// @param token ERC-20 settlement stablecoin used for the L/C and customs duty.
    constructor(IERC20 token) {
        if (address(token) == address(0)) revert ZeroAddress();

        EBLToken ebl = new EBLToken(address(this));
        TradeCertNFT cert = new TradeCertNFT(address(this));

        _setSettlementToken(token);
        _setEBLToken(ebl);
        _setCertNFT(cert);

        // OpenZeppelin v5.6 AccessControl no longer auto-grants DEFAULT_ADMIN_ROLE,
        // so the deployer is granted it explicitly here.
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /// @notice Batch-grants roles to accounts (admin convenience for the six-wallet demo).
    function grantRoles(bytes32[] calldata roles, address[] calldata accounts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (roles.length != accounts.length) revert ArrayLengthMismatch();
        for (uint256 i; i < roles.length; ++i) {
            _grantRole(roles[i], accounts[i]);
        }
    }

    /// @notice Accepts the escrowed eB/L (safe-mint receiver hook). Only ERC-721 transfers are accepted.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
