// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ShipmentState — shared storage base for TradeChain
/// @notice Holds the single storage layout shared by every module (no proxies, no diamonds):
///         enums, packed structs, role constants, bookkeeping mappings and custom errors.
/// @dev    `Phase` is the shipment lifecycle enum (called "ShipmentState enum" in the proposal;
///         renamed here to avoid clashing with this contract's name — see ProposalImprovement.md C1).
abstract contract ShipmentState is AccessControl, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Enums
    // ---------------------------------------------------------------------

    /// @notice ICC Incoterms® 2020 subset supported by this contract.
    enum Incoterm {
        EXW, // Ex Works                  — risk transfers at pickup
        FOB, // Free On Board             — risk transfers on vessel
        CIF, // Cost, Insurance & Freight — risk transfers on vessel
        DDP  // Delivered Duty Paid        — risk transfers at destination
    }

    /// @notice Shipment lifecycle phase.
    enum Phase {
        Created,
        LCFunded,
        PickedUp,
        LoadedOnVessel,
        Delivered,
        Settled,
        Reclaimed
    }

    /// @notice The seven trade document types stored by the registry.
    /// @dev    Order and anchor authority are per the agreed design (see Q4 in QUESTIONS.md):
    ///           0 CommercialInvoice      Seller    (at createShipment)
    ///           1 PackingList            Seller    (at createShipment)
    ///           2 CertificateOfOrigin    Seller    (anchorDocument)
    ///           3 InspectionCertificate  Verifier  (anchorDocument) -> mints TradeCertNFT
    ///           4 InsuranceCertificate   Verifier  (anchorDocument) -> mints TradeCertNFT
    ///           5 BillOfLadingOrAWB      Carrier   (at confirmVesselLoading; drives EBLToken.tokenURI)
    ///           6 CustomsClearance       Verifier  (anchorDocument) -> mints TradeCertNFT
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

    // ---------------------------------------------------------------------
    // Structs
    // ---------------------------------------------------------------------

    /// @notice A purchase order opened by the Buyer before any shipment exists.
    struct Order {
        uint256 id;
        address buyer;
        address seller;
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
        uint64 createdAt;
        uint64 deadline; // unix timestamp
        Incoterm term;
        Phase phase;
        bool lcFunded;
        bool lcPaid;
        bool dutyPaid;
        bool titleTransferred;
        uint256 lcAmount;
        uint256 dutyAmount;
        address seller;
        address buyer;
        address riskHolder;
        address dutyPayer;
    }

    /// @notice Per-(shipment, DocType) document anchor.
    struct DocRecord {
        string cid; // IPFS CIDv1 (empty ⇒ not anchored)
        address issuer;
        uint64 timestamp;
        bool locked; // anchor-once-then-lock
        uint256 certId; // TradeCertNFT id for verifier-attested types (0 otherwise)
    }

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    bytes32 public constant ROLE_SELLER = keccak256("ROLE_SELLER");
    bytes32 public constant ROLE_BUYER = keccak256("ROLE_BUYER");
    bytes32 public constant ROLE_CARRIER = keccak256("ROLE_CARRIER");
    bytes32 public constant ROLE_ISSUING_BANK = keccak256("ROLE_ISSUING_BANK");
    bytes32 public constant ROLE_ADVISING_BANK = keccak256("ROLE_ADVISING_BANK");
    bytes32 public constant ROLE_VERIFIER = keccak256("ROLE_VERIFIER");

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 internal _nextOrderId;
    uint256 internal _nextShipmentId;
    mapping(uint256 id => Order) internal _orders;
    mapping(uint256 id => Shipment) internal _shipments;
    mapping(uint256 id => mapping(DocType docType => DocRecord)) internal _documents;

    // ---------------------------------------------------------------------
    // Custom errors
    // ---------------------------------------------------------------------

    error Unauthorized(address caller);
    error ZeroAddress();
    error InvalidAmount();
    error InvalidDeadline(uint64 deadline);
    error ArrayLengthMismatch();
    error EmptyCID();
    error OrderNotFound(uint256 orderId);
    error OrderAlreadyFulfilled(uint256 orderId);
    error NotOrderedSeller(uint256 orderId, address caller);
    error ShipmentNotFound(uint256 id);
    error InvalidState(uint256 id, Phase expected, Phase actual);
    error InvalidStateRange(uint256 id, Phase actual);
    error MissingMandatoryDocument(uint256 id, DocType docType);
    error DocumentLocked(uint256 id, DocType docType);
    error DocumentNotAnchorable(DocType docType);
    error CertificateNotFound(uint256 certId);
    error IncorrectPayment(uint256 expected, uint256 received);
    error DeadlineNotReached(uint256 deadline);
    error SettlementNotDue(uint256 id, Phase phase);
    error SettlementAlreadyExecuted(uint256 id);
    error NothingToReclaim(uint256 id);
    error NotReclaimAuthority(address caller);
    error CustomsDutyNotPaid(uint256 id);
    error DutyAlreadyPaid(uint256 id);
    error PayoutFailed(address payee);

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /// @dev Reverts if `id` does not exist; returns the storage pointer otherwise.
    function _requireShipment(uint256 id) internal view returns (Shipment storage s) {
        s = _shipments[id];
        if (s.seller == address(0)) revert ShipmentNotFound(id);
    }

    /// @dev Reverts if `orderId` does not exist; returns the storage pointer otherwise.
    function _requireOrder(uint256 orderId) internal view returns (Order storage o) {
        o = _orders[orderId];
        if (o.buyer == address(0)) revert OrderNotFound(orderId);
    }

    /// @dev Single-bit mask for a DocType, used by requireDocuments(bitmask).
    function _bit(DocType d) internal pure returns (uint8) {
        return uint8(1) << uint8(d);
    }
}
