// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TradeTypes} from "../libraries/TradeTypes.sol";
import {DocumentRegistry} from "./DocumentRegistry.sol";
import {ShipmentTracker} from "./ShipmentTracker.sol";

/// @title ComplianceEngine — Incoterm-aware document compliance rules
/// @notice View-only rule engine. The "six required documents" are treated as the *universe*;
///         the actual mandatory set is a function of the Incoterm and the milestone, which fixes
///         the updated proposal's fixed-six-document discrepancy (e.g. CIF needs insurance, DDP
///         needs customs clearance, EXW/FOB do not need insurance).
/// @dev    Reads `DocumentRegistry` (document validity) and `ShipmentTracker` (phase/term).
contract ComplianceEngine {
    DocumentRegistry public immutable registry;
    ShipmentTracker public immutable tracker;

    error ZeroAddress();
    error MissingMandatoryDocument(uint256 id, TradeTypes.DocType docType);

    constructor(address registry_, address tracker_) {
        if (registry_ == address(0) || tracker_ == address(0)) revert ZeroAddress();
        registry = DocumentRegistry(registry_);
        tracker = ShipmentTracker(tracker_);
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
                if (!registry.isValid(id, d)) return (false, d);
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
}
