// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TradeTypes — shared value types for the TradeChain suite
/// @notice Central enums, structs and constants so the seven contracts agree on one data model.
/// @dev    Pure type/constant library: inlined by the compiler, never deployed as its own
///         contract. Not counted among the seven deployed contracts.
library TradeTypes {
    /// @notice ICC Incoterms® 2020 subset supported by TradeChain.
    enum Incoterm {
        EXW, // Ex Works                  — risk transfers at pickup
        FOB, // Free On Board             — risk transfers on vessel
        CIF, // Cost, Insurance & Freight — risk transfers on vessel, seller insures
        DDP  // Delivered Duty Paid        — risk transfers at destination, seller pays duty
    }

    /// @notice Shipment lifecycle phase (tracked by `ShipmentTracker`).
    enum Phase {
        Created,
        LCFunded,
        PickedUp,
        LoadedOnVessel,
        Delivered,
        Settled,
        Reclaimed
    }

    /// @notice The seven trade document types stored by `DocumentRegistry`.
    /// @dev    Anchor authority is enforced by `TradeChainCore`:
    ///           0 CommercialInvoice      Exporter  (at createShipment)
    ///           1 PackingList            Exporter  (at createShipment)
    ///           2 CertificateOfOrigin    Exporter  (anchorDocument)
    ///           3 InspectionCertificate  Verifier  (anchorDocument)
    ///           4 InsuranceCertificate   Verifier  (anchorDocument)
    ///           5 BillOfLadingOrAWB      Logistics (at confirmVesselLoading)
    ///           6 CustomsClearance       Verifier  (anchorDocument)
    enum DocType {
        CommercialInvoice,
        PackingList,
        CertificateOfOrigin,
        InspectionCertificate,
        InsuranceCertificate,
        BillOfLadingOrAWB,
        CustomsClearance
    }

    uint8 internal constant DOC_TYPE_COUNT = 7;

    /// @notice A purchase order opened by the importer before any shipment exists.
    struct Order {
        uint256 id;
        address importer;
        address exporter;
        Incoterm term;
        uint64 deadline; // unix timestamp
        uint256 lcAmount;
        uint256 shipmentId; // 0 until fulfilled
        bool fulfilled;
    }

    /// @notice Packed shipment record.
    struct Shipment {
        uint256 id;
        uint256 orderId;
        address exporter;
        address importer;
        Incoterm term;
        Phase phase;
        uint64 createdAt;
        uint64 deadline; // unix timestamp
        uint256 lcAmount;
        address riskHolder;
    }

    /// @notice Per-(shipment, DocType) document anchor.
    struct DocRecord {
        string cid; // IPFS CIDv1 (empty ⇒ not anchored)
        address issuer;
        uint64 timestamp;
        bool verified; // false once revoked
    }

    /// @notice Single-bit mask for a DocType (used by the compliance bitmask).
    function bit(DocType d) internal pure returns (uint8) {
        return uint8(1) << uint8(d);
    }
}
