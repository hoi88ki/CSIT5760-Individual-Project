// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TradeUSD — simulated stablecoin used for trade settlement
/// @notice ERC-20 (usually 6 decimals) that backs the Letter-of-Credit escrow and customs duty.
///         Minting is **role-gated** (`MINTER_ROLE`) so the supply cannot be inflated by
///         arbitrary accounts (the previous demo mock had an open `mint`).
contract TradeUSD is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint8 private immutable _DECIMALS;

    error ZeroAddress();

    /// @param admin     The TradeChainCore (granted DEFAULT_ADMIN_ROLE and MINTER_ROLE).
    /// @param name_     ERC-20 name.
    /// @param symbol_   ERC-20 symbol.
    /// @param decimals_ Fixed decimals (6 for a USDC-like token).
    constructor(
        address admin,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        if (admin == address(0)) revert ZeroAddress();
        _DECIMALS = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _DECIMALS;
    }

    /// @notice Mints new settlement tokens (test-network demo funding only).
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        _mint(to, amount);
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
