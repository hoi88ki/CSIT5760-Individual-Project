// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TradeChainCore} from "../TradeChainCore.sol";

/// @title TradeChainHarness — test-only harness
/// @notice Exposes internal settlement internals so the defensive guards of
///         `_triggerAtomicPayout` can be exercised directly (they are otherwise unreachable
///         through the state-guarded public API).
/// @dev    Test-only. Excluded from coverage via `.solcover.js`.
contract TradeChainHarness is TradeChainCore {
    constructor(IERC20 token) TradeChainCore(token) {}

    /// @dev Calls the internal atomic-payout engine without the public state guards.
    function exposed_triggerAtomicPayout(uint256 id) external {
        _triggerAtomicPayout(id);
    }

    /// @dev Exposes the internal per-DocType role lookup.
    function exposed_roleForDocType(DocType d) external pure returns (bytes32) {
        return _roleForDocType(d);
    }

    /// @dev Exposes whether a DocType mints a certificate.
    function exposed_isVerifierDocType(DocType d) external pure returns (bool) {
        return _isVerifierDocType(d);
    }
}
