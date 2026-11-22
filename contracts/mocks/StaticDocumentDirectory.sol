// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TradeTypes} from "../libraries/TradeTypes.sol";
import {IDocumentDirectory} from "../core/ComplianceEngine.sol";

/// @title StaticDocumentDirectory — test-only `IDocumentDirectory`
/// @notice Always resolves to a fixed registry address (zero allowed, to exercise the
///         `ComplianceEngine` fallback path). Used by the module unit tests, which deploy the
///         companion contracts standalone instead of through a full `TradeChainCore`.
/// @dev    Test-only. Excluded from coverage via `.solcover.js`.
contract StaticDocumentDirectory is IDocumentDirectory {
    address public immutable registry;

    constructor(address registry_) {
        registry = registry_;
    }

    function documentRegistryOf(
        uint256, /* shipmentId */
        TradeTypes.DocType /* docType */
    ) external view override returns (address) {
        return registry;
    }
}
