// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShipmentState} from "./ShipmentState.sol";
import {TradeCertNFT} from "../tokens/TradeCertNFT.sol";

/// @title DocumentRegistry — IPFS document anchors + certificate attestations
/// @notice Stores one immutable CID per (shipment, DocType), enforces the per-DocType issuer
///         role, and mints a revocable `TradeCertNFT` for verifier-attested document types.
abstract contract DocumentRegistry is ShipmentState {
    /// @notice Certificate token owned by the core contract.
    TradeCertNFT public certNFT;

    event DocumentAnchored(
        uint256 indexed id,
        DocType indexed docType,
        address indexed issuer,
        string cid,
        uint256 certId
    );
    event CertificateMinted(uint256 indexed certId, uint256 indexed id, DocType indexed docType, address issuer);
    event CertificateRevoked(uint256 indexed certId, uint256 indexed id, DocType indexed docType);

    /// @dev One-time wiring of the certificate token (called from the core constructor).
    function _setCertNFT(TradeCertNFT token) internal {
        certNFT = token;
    }

    /// @notice Document types whose anchor mints a verifiable certificate NFT.
    function _isVerifierDocType(DocType d) internal pure returns (bool) {
        return
            d == DocType.InspectionCertificate ||
            d == DocType.InsuranceCertificate ||
            d == DocType.CustomsClearance;
    }

    /// @notice Document types that can be anchored through the public `anchorDocument()` entry point.
    function _isAnchorableViaAnchorDocument(DocType d) internal pure returns (bool) {
        return
            d == DocType.CertificateOfOrigin ||
            d == DocType.InspectionCertificate ||
            d == DocType.InsuranceCertificate ||
            d == DocType.CustomsClearance;
    }

    /// @notice The role authorised to issue a given document type.
    function _roleForDocType(DocType d) internal pure returns (bytes32) {
        if (d == DocType.CommercialInvoice || d == DocType.PackingList || d == DocType.CertificateOfOrigin) {
            return ROLE_SELLER;
        }
        if (d == DocType.BillOfLadingOrAWB) {
            return ROLE_CARRIER;
        }
        return ROLE_VERIFIER; // Inspection / Insurance / CustomsClearance
    }

    /// @dev Anchor-once-then-lock write path. Mints a certificate for verifier doc types.
    function _anchorInternal(
        uint256 id,
        DocType docType,
        string calldata cid,
        address issuer
    ) internal returns (uint256 certId) {
        if (bytes(cid).length == 0) revert EmptyCID();

        DocRecord storage rec = _documents[id][docType];
        if (rec.locked) revert DocumentLocked(id, docType);

        rec.cid = cid;
        rec.issuer = issuer;
        rec.timestamp = uint64(block.timestamp);
        rec.locked = true;

        if (_isVerifierDocType(docType)) {
            certId = certNFT.mint(issuer, string.concat("ipfs://", cid));
            rec.certId = certId;
            emit CertificateMinted(certId, id, docType, issuer);
        }

        emit DocumentAnchored(id, docType, issuer, cid, certId);
    }

    /// @notice True when a document is anchored and, for verifier types, its certificate is unrevoked.
    function _hasValidDocument(uint256 id, DocType docType) internal view returns (bool) {
        DocRecord storage rec = _documents[id][docType];
        if (bytes(rec.cid).length == 0) return false;
        if (_isVerifierDocType(docType) && !certNFT.exists(rec.certId)) return false;
        return true;
    }

    /// @dev Reverts with the first missing mandatory document in `mask`.
    function _requireDocuments(uint256 id, uint8 mask) internal view {
        for (uint8 i = 0; i < DOC_TYPE_COUNT; ++i) {
            if ((mask & (uint8(1) << i)) != 0) {
                DocType d = DocType(i);
                if (!_hasValidDocument(id, d)) revert MissingMandatoryDocument(id, d);
            }
        }
    }

    // =====================================================================
    // External API
    // =====================================================================

    /// @notice Anchors certificate of origin, inspection, insurance or customs-clearance documents.
    /// @dev    Only the per-DocType authorised role may anchor; verifier types mint a TradeCertNFT.
    function anchorDocument(uint256 id, DocType docType, string calldata cid) external {
        Shipment storage s = _requireShipment(id);
        if (!_isAnchorableViaAnchorDocument(docType)) revert DocumentNotAnchorable(docType);
        if (!hasRole(_roleForDocType(docType), msg.sender)) revert Unauthorized(msg.sender);
        if (uint8(s.phase) < uint8(Phase.LCFunded) || s.phase == Phase.Reclaimed) {
            revert InvalidStateRange(id, s.phase);
        }
        _anchorInternal(id, docType, cid, msg.sender);
    }

    /// @notice Revokes a certificate by burning it, invalidating the document at payout.
    /// @dev    Callable by the original issuer or the admin (Q5).
    function revokeCertificate(uint256 id, DocType docType) external {
        if (!_isVerifierDocType(docType)) revert DocumentNotAnchorable(docType);

        DocRecord storage rec = _documents[id][docType];
        if (rec.certId == 0) revert CertificateNotFound(0);
        if (msg.sender != rec.issuer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert Unauthorized(msg.sender);
        }

        uint256 certId = rec.certId;
        certNFT.revoke(certId);
        emit CertificateRevoked(certId, id, docType);
    }

    /// @notice Returns the stored document record for (shipment, docType).
    function getDocument(uint256 id, DocType docType) external view returns (DocRecord memory) {
        return _documents[id][docType];
    }
}
