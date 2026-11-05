// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {TradeTypes} from "../libraries/TradeTypes.sol";

/// @title ShipmentTracker — shipment lifecycle **and** the e-B/L document of title
/// @notice One aggregate per shipment: the trade-agreement metadata, the lifecycle state machine
///         (phase, timestamps, risk holder) **and** the ERC-721 title token. `tokenId` is the
///         shipment id, so the record and the document of title share one identity.
/// @dev    All mutators are restricted to the `TradeChainCore` (`onlyCore`). The ERC-721 transfer
///         surface is **not** open: `transferFrom`/`safeTransferFrom` revert for everyone, and only
///         the core can move the title through `transferTitle` at the Incoterm-correct milestone
///         (enforced by `_update`). The B/L or AWB CID is attached as the token URI when the
///         document is anchored.
contract ShipmentTracker is ERC721URIStorage, AccessControl {
    /// @notice Role allowed to mint and move the title token (held by the core).
    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");

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
    error TokenDoesNotExist(uint256 tokenId);
    error TransferRestricted(uint256 tokenId);

    modifier onlyCore() {
        if (msg.sender != core) revert OnlyCore();
        _;
    }

    /// @param core_ The TradeChainCore (granted `DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE`).
    constructor(address core_) ERC721("TradeChain Shipment Title", "TC-SHP") {
        if (core_ == address(0)) revert ZeroAddress();
        core = core_;
        _grantRole(DEFAULT_ADMIN_ROLE, core_);
        _grantRole(CONTROLLER_ROLE, core_);
    }

    // ---------------------------------------------------------------------
    // Order / shipment lifecycle (core only)
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
    // Document of title (ERC-721, core only)
    // ---------------------------------------------------------------------

    /// @notice Mints the title token for an existing shipment (`tokenId == shipmentId`).
    function mint(address to, uint256 tokenId, string calldata uri) external onlyCore {
        if (_shipments[tokenId].importer == address(0)) revert ShipmentNotFound(tokenId);
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Updates the off-chain B/L (or AWB) pointer when the document is anchored.
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyCore {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist(tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Transfers the document of title (the core calls this at the settlement milestone).
    function transferTitle(uint256 tokenId, address to) external onlyCore {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert TokenDoesNotExist(tokenId);
        _transfer(owner, to, tokenId);
    }

    /// @notice True when the title token exists (minted and not burned).
    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
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

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Reject every externally initiated transfer (the owner cannot move or endorse the title).
    ///      Internal moves use `auth == address(0)` and are already gated by `onlyCore`.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (auth != address(0)) revert TransferRestricted(tokenId);
        return super._update(to, tokenId, auth);
    }

    function _requireShipment(uint256 id) private view returns (TradeTypes.Shipment storage s) {
        s = _shipments[id];
        if (s.importer == address(0)) revert ShipmentNotFound(id);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721URIStorage, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
