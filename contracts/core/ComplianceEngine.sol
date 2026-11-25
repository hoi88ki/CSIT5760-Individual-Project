// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {TradeTypes} from "../libraries/TradeTypes.sol";
import {DocumentRegistry} from "./DocumentRegistry.sol";
import {ShipmentTracker} from "./ShipmentTracker.sol";

/// @notice Resolves which `DocumentRegistry` holds a given `(shipment, DocType)` anchor.
///         Implemented by `TradeChainCore`, which snapshots the registry in use at anchor time.
interface IDocumentDirectory {
    function documentRegistryOf(
        uint256 shipmentId,
        TradeTypes.DocType docType
    ) external view returns (address);
}

/// @title ComplianceEngine — Incoterm-aware document compliance rules
/// @notice View-only rule engine. The seven `DocType`s are the *universe*; the actual mandatory
///         set is a function of the Incoterm and of the checkpoint being proved. Two kinds of
///         checkpoints exist:
///           • **Custody gates** — the progressive documentary readiness of the goods
///             (pickup → loading → delivery).
///           • **The presentation** — the stipulated documentary set of the credit, examined
///             by the issuing bank before honoring (the same full set per Incoterm).
/// @dev    Access control is mounted on the `TradeChainCore` (the core holds `DEFAULT_ADMIN_ROLE`),
///         so the rule engine's authority is administered from one place. Every function is a
///         `view` and stays permissionless by design — the engine only reads the registries and
///         the tracker, it never mutates state. Because the core can swap the active
///         `DocumentRegistry`, the engine resolves the registry per `(shipment, DocType)` through
///         `IDocumentDirectory` and falls back to the deployment-time `registry`.
contract ComplianceEngine is AccessControl {
    /// @notice Resolves the registry that holds a `(shipment, DocType)` anchor (the core).
    IDocumentDirectory public immutable directory;

    /// @notice Fallback registry used when the directory reports no entry (never in production).
    DocumentRegistry public immutable registry;
    ShipmentTracker public immutable tracker;

    error ZeroAddress();

    error MissingMandatoryDocument(uint256 id, TradeTypes.DocType docType);

    constructor(address directory_, address registry_, address tracker_) {
        if (directory_ == address(0) || registry_ == address(0) || tracker_ == address(0)) revert ZeroAddress();
        directory = IDocumentDirectory(directory_);
        registry = DocumentRegistry(registry_);
        tracker = ShipmentTracker(tracker_);
        _grantRole(DEFAULT_ADMIN_ROLE, directory_);
    }

    /// @dev Registry that actually holds the `(id, docType)` anchor.
    function _registryFor(uint256 id, TradeTypes.DocType docType) internal view returns (DocumentRegistry) {
        address resolved = directory.documentRegistryOf(id, docType);
        return DocumentRegistry(resolved == address(0) ? address(registry) : resolved);
    }

    /// @dev Mandatory document bitmask for a given Incoterm + custody checkpoint.
    function requiredMask(TradeTypes.Incoterm term, TradeTypes.Custody custody) public pure returns (uint8 mask) {
        uint8 base = TradeTypes.bit(TradeTypes.DocType.CommercialInvoice) |
            TradeTypes.bit(TradeTypes.DocType.PackingList);

        if (custody == TradeTypes.Custody.PickedUp) {
            return base;
        }
        if (custody == TradeTypes.Custody.OnVessel) {
            if (term == TradeTypes.Incoterm.EXW) {
                return base | TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB);
            }
            if (term == TradeTypes.Incoterm.CIF) {
                return
                    base |
                    TradeTypes.bit(TradeTypes.DocType.InspectionCertificate) |
                    TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB) |
                    TradeTypes.bit(TradeTypes.DocType.InsuranceCertificate);
            }
            return
                base |
                TradeTypes.bit(TradeTypes.DocType.InspectionCertificate) |
                TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB); // FOB, DDP
        }
        if (custody == TradeTypes.Custody.Delivered) {
            if (term == TradeTypes.Incoterm.DDP) {
                return
                    base |
                    TradeTypes.bit(TradeTypes.DocType.InspectionCertificate) |
                    TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB) |
                    TradeTypes.bit(TradeTypes.DocType.CertificateOfOrigin) |
                    TradeTypes.bit(TradeTypes.DocType.CustomsClearance);
            }
            if (term == TradeTypes.Incoterm.CIF) {
                return
                    base |
                    TradeTypes.bit(TradeTypes.DocType.InspectionCertificate) |
                    TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB) |
                    TradeTypes.bit(TradeTypes.DocType.InsuranceCertificate);
            }
            if (term == TradeTypes.Incoterm.FOB) {
                return
                    base |
                    TradeTypes.bit(TradeTypes.DocType.InspectionCertificate) |
                    TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB);
            }
            return base | TradeTypes.bit(TradeTypes.DocType.BillOfLadingOrAWB); // EXW
        }
        return 0; // AtExporter: nothing is gate-checked before pickup
    }

    /// @notice The stipulated documentary set of the credit for an Incoterm — the documents the
    ///         beneficiary must present and the issuing bank must examine before honoring.
    function presentationMask(TradeTypes.Incoterm term) public pure returns (uint8) {
        return requiredMask(term, TradeTypes.Custody.Delivered);
    }

    /// @notice Returns the first document of `mask` that is missing or revoked, if any.
    function _firstMissing(uint256 id, uint8 mask) internal view returns (bool ok, TradeTypes.DocType missing) {
        for (uint8 i = 0; i < TradeTypes.DOC_TYPE_COUNT; ++i) {
            if ((mask & (uint8(1) << i)) != 0) {
                TradeTypes.DocType d = TradeTypes.DocType(i);
                if (!_registryFor(id, d).isValid(id, d)) return (false, d);
            }
        }
        return (true, TradeTypes.DocType.CommercialInvoice);
    }

    /// @notice Returns the first custody-gate document that is missing or revoked, if any.
    function firstMissing(
        uint256 id,
        TradeTypes.Incoterm term,
        TradeTypes.Custody custody
    ) public view returns (bool ok, TradeTypes.DocType missing) {
        return _firstMissing(id, requiredMask(term, custody));
    }

    /// @notice Returns the first stipulated presentation document that is missing or revoked.
    function firstMissingPresentation(
        uint256 id,
        TradeTypes.Incoterm term
    ) public view returns (bool ok, TradeTypes.DocType missing) {
        return _firstMissing(id, presentationMask(term));
    }

    function isCompliant(
        uint256 id,
        TradeTypes.Incoterm term,
        TradeTypes.Custody custody
    ) external view returns (bool) {
        (bool ok, ) = firstMissing(id, term, custody);
        return ok;
    }

    function isPresentationCompliant(uint256 id, TradeTypes.Incoterm term) external view returns (bool) {
        (bool ok, ) = firstMissingPresentation(id, term);
        return ok;
    }

    /// @notice Reverts with `MissingMandatoryDocument` if the custody-gate set is incomplete.
    function requireCompliant(
        uint256 id,
        TradeTypes.Incoterm term,
        TradeTypes.Custody custody
    ) external view {
        (bool ok, TradeTypes.DocType missing) = firstMissing(id, term, custody);
        if (!ok) revert MissingMandatoryDocument(id, missing);
    }

    /// @notice Reverts with `MissingMandatoryDocument` if the stipulated presentation set is
    ///         incomplete. Used when recording a presentation and when the bank examines it.
    function requirePresentationCompliant(uint256 id, TradeTypes.Incoterm term) external view {
        (bool ok, TradeTypes.DocType missing) = firstMissingPresentation(id, term);
        if (!ok) revert MissingMandatoryDocument(id, missing);
    }

    /// @notice Convenience: custody-gate mask for a shipment's current Incoterm.
    function requiredForShipment(uint256 id, TradeTypes.Custody custody) external view returns (uint8) {
        TradeTypes.Shipment memory s = tracker.getShipment(id);
        return requiredMask(s.term, custody);
    }

    /// @notice Convenience: stipulated presentation mask for a shipment's current Incoterm.
    function presentationForShipment(uint256 id) external view returns (uint8) {
        TradeTypes.Shipment memory s = tracker.getShipment(id);
        return presentationMask(s.term);
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
