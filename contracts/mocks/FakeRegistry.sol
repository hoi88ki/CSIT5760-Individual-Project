// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TradeTypes} from "../libraries/TradeTypes.sol";

/// @title FakeRegistry — adversarial "registry" that pretends every document is valid
/// @notice Implements the `DocumentRegistry` surface (`core`, `isValid`, …) but always reports
///         `true`. Used to prove that `TradeChainCore.setDocumentRegistry` rejects look-alike
///         contracts: without the runtime-codehash check, swapping this in would forge compliance
///         and release an escrow without any document.
/// @dev    Test-only. Excluded from coverage via `.solcover.js`.
contract FakeRegistry {
    address public immutable core;

    constructor(address core_) {
        core = core_;
    }

    function isValid(uint256, TradeTypes.DocType) external pure returns (bool) {
        return true;
    }

    function issuerOf(uint256, TradeTypes.DocType) external pure returns (address) {
        return address(0);
    }

    function getDocument(uint256, TradeTypes.DocType) external pure returns (TradeTypes.DocRecord memory) {
        return TradeTypes.DocRecord({cid: "fake", issuer: address(0), timestamp: 0, verified: true});
    }

    function revoke(uint256, TradeTypes.DocType) external pure {}
}
