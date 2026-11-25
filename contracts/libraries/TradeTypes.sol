// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TradeTypes — shared value types for the TradeChain suite
/// @notice Central enums, structs and constants so the six contracts agree on one data model.
/// @dev    Pure type/constant library: inlined by the compiler, never deployed as its own
///         contract. Not counted among the six deployed contracts.
library TradeTypes {
    /// @notice ICC Incoterms® 2020 subset supported by TradeChain.
    /// @dev    The Incoterm selects the documentary requirements and when risk/title move;
    ///         it no longer decides when the L/C pays (that follows presentation/examination).
    enum Incoterm {
        EXW, // Ex Works                  — risk transfers at pickup
        FOB, // Free On Board             — risk transfers on vessel
        CIF, // Cost, Insurance & Freight — risk transfers on vessel, seller insures
        DDP  // Delivered Duty Paid        — risk transfers at destination, seller pays duty
    }

    /// @notice Payment terms of the documentary credit, requested by the applicant and issued
    ///         by the bank. `Sight` pays when the bank honors a complying presentation;
    ///         `Deferred` pays after the agreed deferral elapses from acceptance.
    enum PaymentTerm {
        Sight,
        Deferred
    }

    /// @notice Credit/trade lifecycle phase (tracked by `ShipmentTracker`).
    /// @dev    Linear path: OrderPlaced → LCIssued → Shipped → Presented → Honored →
    ///         Delivered → Settled. `Reclaimed` is the terminal state of an expired credit
    ///         that was never used (funds return to the issuing bank).
    enum Phase {
        OrderPlaced, // application recorded; the issuing bank has not acted yet
        LCIssued,    // bank issued the credit and prefunded the escrow; beneficiary may ship
        Shipped,     // beneficiary shipped: invoice + packing anchored, title minted
        Presented,   // beneficiary presented the stipulated documents
        Honored,     // bank examined and honored: sight paid now, deferred payable at maturity
        Delivered,   // custody complete; title released to the importer
        Settled,     // honored (paid) and delivered — terminal
        Reclaimed    // expired unused credit returned to the issuing bank — terminal
    }

    /// @notice Custody milestones of the goods. Independent of the credit phase: payment
    ///         follows the L/C (presentation → examination → honor), custody follows the
    ///         goods, and the two converge on `Settled` (paid **and** delivered).
    enum Custody {
        AtExporter, // goods still with the exporter
        PickedUp,   // logistics confirmed pickup (EXW: risk → importer)
        OnVessel,   // logistics confirmed loading, B/L anchored (FOB/CIF: risk → importer)
        Delivered   // importer/bank confirmed final delivery (DDP: risk → importer)
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

    /// @notice A purchase order / L/C application opened by the importer (the applicant)
    ///         before any shipment exists. The issuing bank issues the credit against it.
    struct Order {
        uint256 id;
        address importer; // L/C applicant
        address exporter; // beneficiary (the only account allowed to ship)
        Incoterm term;
        PaymentTerm paymentTerm;
        uint64 deferredDays; // agreed deferral for `Deferred` (0 for `Sight`)
        uint64 deadline; // unix timestamp: ship-by / credit expiry
        uint256 lcAmount;
    }

    /// @notice Packed trade record. Created together with the order (same id) so the credit
    ///         lifecycle can be tracked on-chain before the goods are shipped.
    struct Shipment {
        uint256 id;
        uint256 orderId;
        address exporter;
        address importer;
        Incoterm term;
        PaymentTerm paymentTerm;
        uint64 deferredDays;
        Phase phase;
        Custody custody;
        uint64 createdAt;
        uint64 deadline; // unix timestamp: ship-by / credit expiry
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
