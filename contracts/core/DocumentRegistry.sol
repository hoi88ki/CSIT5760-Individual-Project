// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TradeTypes} from "../libraries/TradeTypes.sol";

/// @title DocumentRegistry — IPFS document anchors and verification status
/// @notice Stores one immutable CID per `(shipment, DocType)` together with its issuer, timestamp
///         and a verifiable `verified` flag. A second anchor for the same slot reverts
///         (anchor-once-then-lock); a verifier certificate can later be revoked by clearing
///         `verified`, which invalidates the document at compliance time.
/// @dev    All mutators are restricted to the `TradeChainCore`.
contract DocumentRegistry {
    address public immutable core;

    mapping(uint256 id => mapping(TradeTypes.DocType docType => TradeTypes.DocRecord)) private _documents;

    error OnlyCore();
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

    modifier onlyCore() {
        if (msg.sender != core) revert OnlyCore();
        _;
    }

    constructor(address core_) {
        if (core_ == address(0)) revert ZeroAddress();
        core = core_;
    }

    /// @notice Anchors a document once. `issuer` is the role-verified account supplied by the core.
    function anchor(
        uint256 id,
        TradeTypes.DocType docType,
        string calldata cid,
        address issuer
    ) external onlyCore {
        if (bytes(cid).length == 0) revert EmptyCID();

        TradeTypes.DocRecord storage rec = _documents[id][docType];
        if (bytes(rec.cid).length != 0) revert DocumentLocked(id, docType);

        rec.cid = cid;
        rec.issuer = issuer;
        rec.timestamp = uint64(block.timestamp);
        rec.verified = true;

        emit DocumentAnchored(id, docType, issuer, cid);
    }

    /// @notice Revokes a previously verified document (invalid at compliance time).
    function revoke(uint256 id, TradeTypes.DocType docType) external onlyCore {
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
}
