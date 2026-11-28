// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {TradeTypes} from "../libraries/TradeTypes.sol";

/// @title DocumentRegistry — IPFS document anchors and verification status
/// @notice Stores one CID per `(shipment, DocType)` together with its issuer, timestamp and a
///         verifiable `verified` flag. A **live** anchor is immutable: anchoring over it reverts
///         (`DocumentLocked`). Revoking clears `verified`, which invalidates the document at
///         compliance time and re-opens the slot for a replacement anchor. An existing anchor
///         (valid or revoked) can also be replaced through `replace`, which re-verifies the slot
///         and emits `DocumentReplaced` with the previous CID so the change stays auditable.
/// @dev    Access control is **mounted on the `TradeChainCore`**: the core is granted
///         `DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE` at construction, and both mutators are
///         `CONTROLLER_ROLE`-gated, so the core remains the only writer while the core's own
///         `AccessControl` administers who may hold that role. Instances are bound to one core
///         (`core`), which lets the core verify a replacement registry before swapping it in.
contract DocumentRegistry is AccessControl {
    /// @notice Role allowed to anchor and revoke documents (held by the `TradeChainCore`).
    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");

    /// @notice The `TradeChainCore` this registry is bound to (also the role authority).
    address public immutable core;

    mapping(uint256 id => mapping(TradeTypes.DocType docType => TradeTypes.DocRecord)) private _documents;

    error ZeroAddress();
    error EmptyCID();
    error DocumentLocked(uint256 id, TradeTypes.DocType docType);
    error DocumentNotFound(uint256 id, TradeTypes.DocType docType);
    error AlreadyRevoked(uint256 id, TradeTypes.DocType docType);

    event DocumentAnchored(
        uint256 indexed id,
        TradeTypes.DocType indexed docType,
        address indexed issuer,
        string cid
    );
    event DocumentRevoked(uint256 indexed id, TradeTypes.DocType indexed docType);
    event DocumentReplaced(
        uint256 indexed id,
        TradeTypes.DocType indexed docType,
        address indexed issuer,
        string oldCid,
        string newCid
    );

    constructor(address core_) {
        if (core_ == address(0)) revert ZeroAddress();
        core = core_;
        _grantRole(DEFAULT_ADMIN_ROLE, core_);
        _grantRole(CONTROLLER_ROLE, core_);
    }

    /// @notice Anchors a document once. A revoked slot may be re-anchored with a replacement CID.
    ///         `issuer` is the role-verified account supplied by the core.
    function anchor(
        uint256 id,
        TradeTypes.DocType docType,
        string calldata cid,
        address issuer
    ) external onlyRole(CONTROLLER_ROLE) {
        if (bytes(cid).length == 0) revert EmptyCID();

        TradeTypes.DocRecord storage rec = _documents[id][docType];
        // A live anchor is immutable; only a revoked one (`verified == false`) may be re-anchored.
        if (bytes(rec.cid).length != 0 && rec.verified) revert DocumentLocked(id, docType);

        rec.cid = cid;
        rec.issuer = issuer;
        rec.timestamp = uint64(block.timestamp);
        rec.verified = true;

        emit DocumentAnchored(id, docType, issuer, cid);
    }

    /// @notice Replaces the CID of an existing anchor (valid or revoked) and re-verifies it.
    ///         The previous CID is kept in the event log. `issuer` is the authorized account
    ///         supplied by the core.
    function replace(
        uint256 id,
        TradeTypes.DocType docType,
        string calldata cid,
        address issuer
    ) external onlyRole(CONTROLLER_ROLE) {
        if (bytes(cid).length == 0) revert EmptyCID();

        TradeTypes.DocRecord storage rec = _documents[id][docType];
        if (bytes(rec.cid).length == 0) revert DocumentNotFound(id, docType);

        string memory oldCid = rec.cid;
        rec.cid = cid;
        rec.issuer = issuer;
        rec.timestamp = uint64(block.timestamp);
        rec.verified = true;

        emit DocumentReplaced(id, docType, issuer, oldCid, cid);
    }

    /// @notice Revokes a previously verified document (invalid at compliance time).
    function revoke(uint256 id, TradeTypes.DocType docType) external onlyRole(CONTROLLER_ROLE) {
        TradeTypes.DocRecord storage rec = _documents[id][docType];
        if (bytes(rec.cid).length == 0) revert DocumentNotFound(id, docType);
        if (!rec.verified) revert AlreadyRevoked(id, docType);

        rec.verified = false;
        emit DocumentRevoked(id, docType);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getDocument(uint256 id, TradeTypes.DocType docType) external view returns (TradeTypes.DocRecord memory) {
        return _documents[id][docType];
    }

    function isPresent(uint256 id, TradeTypes.DocType docType) external view returns (bool) {
        return bytes(_documents[id][docType].cid).length != 0;
    }

    /// @notice True when a document is anchored **and** not revoked.
    function isValid(uint256 id, TradeTypes.DocType docType) public view returns (bool) {
        TradeTypes.DocRecord storage rec = _documents[id][docType];
        return bytes(rec.cid).length != 0 && rec.verified;
    }

    function issuerOf(uint256 id, TradeTypes.DocType docType) external view returns (address) {
        return _documents[id][docType].issuer;
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
