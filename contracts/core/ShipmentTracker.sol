// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TradeTypes} from "../libraries/TradeTypes.sol";

/// @title ShipmentTracker — orders, shipment records and lifecycle milestones
/// @notice Stores trade-agreement metadata and the shipment state machine (phase, timestamps,
///         risk holder, dispute flag). All mutators are restricted to the `TradeChainCore`.
/// @dev    `Phase` is the single source of truth for where a shipment is in the trade flow.
contract ShipmentTracker {
    /// @notice The TradeChainCore allowed to mutate state.
    address public immutable core;

    uint256 private _nextOrderId;
    uint256 private _nextShipmentId;

    mapping(uint256 id => TradeTypes.Order) private _orders;
    mapping(uint256 id => TradeTypes.Shipment) private _shipments;

    error OnlyCore();
    error ZeroAddress();
    error InvalidAmount();
    error InvalidDeadline(uint64 deadline);
    error OrderNotFound(uint256 orderId);
    error OrderAlreadyFulfilled(uint256 orderId);
    error NotOrderedExporter(uint256 orderId, address caller);
    error ShipmentNotFound(uint256 id);

    modifier onlyCore() {
        if (msg.sender != core) revert OnlyCore();
        _;
    }

    constructor(address core_) {
        if (core_ == address(0)) revert ZeroAddress();
        core = core_;
    }

    // ---------------------------------------------------------------------
    // Mutators (core only)
    // ---------------------------------------------------------------------

    /// @notice Opens a purchase order on behalf of an importer.
    function createOrder(
        address importer,
        address exporter,
        TradeTypes.Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    ) external onlyCore returns (uint256 orderId) {
        if (exporter == address(0) || importer == address(0)) revert ZeroAddress();
        if (lcAmount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline(deadline);

        orderId = ++_nextOrderId;
        _orders[orderId] = TradeTypes.Order({
            id: orderId,
            importer: importer,
            exporter: exporter,
            term: term,
            deadline: deadline,
            lcAmount: lcAmount,
            shipmentId: 0,
            fulfilled: false
        });
    }

    /// @notice The ordered exporter accepts the order and a shipment is created.
    function fulfilOrder(uint256 orderId, address exporter) external onlyCore returns (uint256 id) {
        TradeTypes.Order storage o = _orders[orderId];
        if (o.importer == address(0)) revert OrderNotFound(orderId);
        if (o.fulfilled) revert OrderAlreadyFulfilled(orderId);
        if (o.exporter != exporter) revert NotOrderedExporter(orderId, exporter);
        if (block.timestamp >= o.deadline) revert InvalidDeadline(o.deadline);

        id = ++_nextShipmentId;
        _shipments[id] = TradeTypes.Shipment({
            id: id,
            orderId: orderId,
            exporter: exporter,
            importer: o.importer,
            term: o.term,
            phase: TradeTypes.Phase.Created,
            createdAt: uint64(block.timestamp),
            deadline: o.deadline,
            lcAmount: o.lcAmount,
            riskHolder: exporter // exporter holds risk until the risk-transfer milestone
        });

        o.fulfilled = true;
        o.shipmentId = id;
    }

    function setPhase(uint256 id, TradeTypes.Phase phase) external onlyCore {
        _requireShipment(id).phase = phase;
    }

    function setRiskHolder(uint256 id, address holder) external onlyCore {
        if (holder == address(0)) revert ZeroAddress();
        _requireShipment(id).riskHolder = holder;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getOrder(uint256 orderId) external view returns (TradeTypes.Order memory) {
        return _orders[orderId];
    }

    function getShipment(uint256 id) external view returns (TradeTypes.Shipment memory) {
        return _shipments[id];
    }

    function orderCount() external view returns (uint256) {
        return _nextOrderId;
    }

    function shipmentCount() external view returns (uint256) {
        return _nextShipmentId;
    }

    function _requireShipment(uint256 id) private view returns (TradeTypes.Shipment storage s) {
        s = _shipments[id];
        if (s.importer == address(0)) revert ShipmentNotFound(id);
    }
}
