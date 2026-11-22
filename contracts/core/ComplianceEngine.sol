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
/// @notice View-only rule engine. The seven `DocType`s are the *universe*; the actual mandatory set
///         is a function of the Incoterm and the milestone (e.g. CIF needs insurance, DDP needs
///         customs clearance, EXW/FOB do not need insurance).
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

    /// @dev Mandatory document bitmask for a given Incoterm + phase.
    function requiredMask(TradeTypes.Incoterm term, TradeTypes.Phase phase) public pure returns (uint8 mask) {
        uint8 base = TradeTypes.bit(TradeTypes.DocType.CommercialInvoice) |
            TradeTypes.bit(TradeTypes.DocType.PackingList);

        if (phase == TradeTypes.Phase.PickedUp) {
            return base;
        }
        if (phase == TradeTypes.Phase.LoadedOnVessel) {
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
        if (phase == TradeTypes.Phase.Delivered) {
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
        return 0;
    }

    /// @notice Milestone at which risk (and therefore payment) transfers for each Incoterm.
    function payoutPhase(TradeTypes.Incoterm term) public pure returns (TradeTypes.Phase) {
        if (term == TradeTypes.Incoterm.EXW) return TradeTypes.Phase.PickedUp;
        if (term == TradeTypes.Incoterm.DDP) return TradeTypes.Phase.Delivered;
        return TradeTypes.Phase.LoadedOnVessel; // FOB, CIF
    }

    /// @notice Returns the first required document that is missing or revoked, if any.
    function firstMissing(
        uint256 id,
        TradeTypes.Incoterm term,
        TradeTypes.Phase phase
    ) public view returns (bool ok, TradeTypes.DocType missing) {
        uint8 mask = requiredMask(term, phase);
        for (uint8 i = 0; i < TradeTypes.DOC_TYPE_COUNT; ++i) {
            if ((mask & (uint8(1) << i)) != 0) {
                TradeTypes.DocType d = TradeTypes.DocType(i);
                if (!_registryFor(id, d).isValid(id, d)) return (false, d);
            }
        }
        return (true, TradeTypes.DocType.CommercialInvoice);
    }

    function isCompliant(uint256 id, TradeTypes.Incoterm term, TradeTypes.Phase phase) external view returns (bool) {
        (bool ok, ) = firstMissing(id, term, phase);
        return ok;
    }

    /// @notice Reverts with `MissingMandatoryDocument` if the set for `phase` is incomplete.
    function requireCompliant(uint256 id, TradeTypes.Incoterm term, TradeTypes.Phase phase) external view {
        (bool ok, TradeTypes.DocType missing) = firstMissing(id, term, phase);
        if (!ok) revert MissingMandatoryDocument(id, missing);
    }

    /// @notice Convenience: required mask for a shipment's current term.
    function requiredForShipment(uint256 id, TradeTypes.Phase phase) external view returns (uint8) {
        TradeTypes.Shipment memory s = tracker.getShipment(id);
        return requiredMask(s.term, phase);
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
