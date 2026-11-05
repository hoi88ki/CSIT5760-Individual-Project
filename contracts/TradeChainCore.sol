// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {TradeTypes} from "./libraries/TradeTypes.sol";
import {ShipmentTracker} from "./core/ShipmentTracker.sol";
import {DocumentRegistry} from "./core/DocumentRegistry.sol";
import {ComplianceEngine} from "./core/ComplianceEngine.sol";
import {LetterOfCredit} from "./core/LetterOfCredit.sol";

/// @title TradeChainCore — central coordinator and single user entry point
/// @notice Owns the `AccessControl` role authority, deploys/wires the four companion contracts,
///         receives the `TradeUSD` settlement token and orchestrates the full trade workflow
///         (orders, documents, milestones, settlement).
/// @dev    Companion contracts accept calls only from this core (`onlyCore`) and expose public
///         views, so the DApp interacts with one address while six contracts are deployed.
contract TradeChainCore is AccessControl, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    bytes32 public constant ROLE_EXPORTER = keccak256("ROLE_EXPORTER");
    bytes32 public constant ROLE_IMPORTER = keccak256("ROLE_IMPORTER");
    bytes32 public constant ROLE_BANK = keccak256("ROLE_BANK");
    bytes32 public constant ROLE_LOGISTICS = keccak256("ROLE_LOGISTICS");
    bytes32 public constant ROLE_VERIFIER = keccak256("ROLE_VERIFIER");

    // ---------------------------------------------------------------------
    // Companion contracts + settlement token
    // ---------------------------------------------------------------------

    IERC20 public immutable settlementToken;
    ShipmentTracker public immutable shipmentTracker;
    DocumentRegistry public immutable documentRegistry;
    ComplianceEngine public immutable complianceEngine;
    LetterOfCredit public immutable letterOfCredit;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error Unauthorized(address caller);
    error ZeroAddress();
    error ShipmentNotFound(uint256 id);
    error InvalidState(uint256 id, TradeTypes.Phase expected, TradeTypes.Phase actual);
    error InvalidStateRange(uint256 id, TradeTypes.Phase actual);
    error DocumentNotAnchorable(TradeTypes.DocType docType);
    error NotReclaimAuthority(address caller);
    error ArrayLengthMismatch();
    error NotTokenAdmin();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OrderCreated(
        uint256 indexed orderId,
        address indexed importer,
        address indexed exporter,
        TradeTypes.Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    );
    event ShipmentCreated(
        uint256 indexed id,
        uint256 indexed orderId,
        address indexed exporter,
        address importer,
        TradeTypes.Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    );
    event LetterOfCreditOpened(uint256 indexed id, address indexed importer, uint256 amount);
    event MilestoneReached(uint256 indexed id, TradeTypes.Phase phase, address indexed actor);
    event AtomicLCPayoutExecuted(
        uint256 indexed id,
        address indexed exporter,
        uint256 amount,
        TradeTypes.Phase atPhase
    );
    event DutyPaid(uint256 indexed id, address indexed payer, uint256 amount);
    event TitleTransferred(uint256 indexed id, address indexed from, address indexed to);
    event LCReclaimed(uint256 indexed id, address indexed importer, uint256 lcRefund, uint256 dutyRefund);
    event DeliveryForceFinalized(uint256 indexed id, address indexed bank);
    event TreasuryUpdated(address indexed treasury);

    /// @param token_ The ERC-20 settlement token (e.g. `TradeUSD`). Must be non-zero.
    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        IERC20 token = token_;
        settlementToken = token;

        ShipmentTracker tracker = new ShipmentTracker(address(this));
        DocumentRegistry registry = new DocumentRegistry(address(this));
        ComplianceEngine compliance = new ComplianceEngine(address(registry), address(tracker));
        LetterOfCredit loc = new LetterOfCredit(
            address(this),
            address(token),
            address(tracker),
            address(compliance),
            address(this) // treasury defaults to the core; admin can re-point it
        );

        shipmentTracker = tracker;
        documentRegistry = registry;
        complianceEngine = compliance;
        letterOfCredit = loc;

        // OpenZeppelin v5 AccessControl does not auto-grant DEFAULT_ADMIN_ROLE.
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Batch-grants roles to accounts.
    function grantRoles(bytes32[] calldata roles, address[] calldata accounts) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (roles.length != accounts.length) revert ArrayLengthMismatch();
        for (uint256 i; i < roles.length; ++i) {
            _grantRole(roles[i], accounts[i]);
        }
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        letterOfCredit.setTreasury(treasury_);
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Mints demo `TradeUSD` (only when the core deployed its own token).
    function mint(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        (bool ok, ) = address(settlementToken).call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
        if (!ok) revert NotTokenAdmin();
    }

    // ---------------------------------------------------------------------
    // Order -> Shipment -> L/C
    // ---------------------------------------------------------------------

    /// @notice Importer opens a purchase order for a named exporter.
    function createOrder(
        address exporter,
        TradeTypes.Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    ) external onlyRole(ROLE_IMPORTER) returns (uint256 orderId) {
        orderId = shipmentTracker.createOrder(msg.sender, exporter, term, lcAmount, deadline);
        emit OrderCreated(orderId, msg.sender, exporter, term, lcAmount, deadline);
    }

    /// @notice The ordered exporter accepts the order, anchoring invoice + packing list.
    function createShipment(
        uint256 orderId,
        string calldata invoiceCID,
        string calldata packingListCID
    ) external onlyRole(ROLE_EXPORTER) returns (uint256 id) {
        id = shipmentTracker.fulfilOrder(orderId, msg.sender);
        documentRegistry.anchor(id, TradeTypes.DocType.CommercialInvoice, invoiceCID, msg.sender);
        documentRegistry.anchor(id, TradeTypes.DocType.PackingList, packingListCID, msg.sender);
        shipmentTracker.mint(address(this), id, "");

        TradeTypes.Shipment memory s = shipmentTracker.getShipment(id);
        emit ShipmentCreated(id, orderId, msg.sender, s.importer, s.term, s.lcAmount, s.deadline);
    }

    /// @notice Importer escrows the L/C amount in `TradeUSD` (approve this core first).
    function openLetterOfCredit(uint256 id) external onlyRole(ROLE_IMPORTER) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        if (s.importer != msg.sender) revert Unauthorized(msg.sender);
        if (s.phase != TradeTypes.Phase.Created) revert InvalidState(id, TradeTypes.Phase.Created, s.phase);

        settlementToken.safeTransferFrom(msg.sender, address(letterOfCredit), s.lcAmount);
        letterOfCredit.fund(id, msg.sender, s.lcAmount);
        shipmentTracker.setPhase(id, TradeTypes.Phase.LCFunded);

        emit LetterOfCreditOpened(id, msg.sender, s.lcAmount);
    }

    /// @notice Anchors a certificate of origin (exporter) or a verifier-attested document.
    function anchorDocument(uint256 id, TradeTypes.DocType docType, string calldata cid) external {
        TradeTypes.Shipment memory s = _requireShipment(id);
        bytes32 role = _roleForDocType(docType);
        if (!hasRole(role, msg.sender)) revert Unauthorized(msg.sender);
        if (uint8(s.phase) < uint8(TradeTypes.Phase.LCFunded) || s.phase == TradeTypes.Phase.Reclaimed) {
            revert InvalidStateRange(id, s.phase);
        }
        documentRegistry.anchor(id, docType, cid, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Custody milestones
    // ---------------------------------------------------------------------

    /// @notice Logistics confirms pickup. Risk moves to the importer; EXW pays out here.
    function confirmPickup(uint256 id) external onlyRole(ROLE_LOGISTICS) {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.LCFunded) revert InvalidState(id, TradeTypes.Phase.LCFunded, s.phase);

        complianceEngine.requireCompliant(id, s.term, TradeTypes.Phase.PickedUp);

        shipmentTracker.setPhase(id, TradeTypes.Phase.PickedUp);
        shipmentTracker.setRiskHolder(id, s.importer);
        emit MilestoneReached(id, TradeTypes.Phase.PickedUp, msg.sender);

        if (s.term == TradeTypes.Incoterm.EXW) _triggerSettlement(id);
    }

    /// @notice Logistics confirms loading, anchors the B/L (or AWB) and sets the title URI.
    ///         FOB and CIF pay out here.
    function confirmVesselLoading(uint256 id, string calldata blCid) external onlyRole(ROLE_LOGISTICS) {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.PickedUp) revert InvalidState(id, TradeTypes.Phase.PickedUp, s.phase);

        documentRegistry.anchor(id, TradeTypes.DocType.BillOfLadingOrAWB, blCid, msg.sender);
        shipmentTracker.setTokenURI(id, string.concat("ipfs://", blCid));
        complianceEngine.requireCompliant(id, s.term, TradeTypes.Phase.LoadedOnVessel);

        shipmentTracker.setPhase(id, TradeTypes.Phase.LoadedOnVessel);
        emit MilestoneReached(id, TradeTypes.Phase.LoadedOnVessel, msg.sender);

        if (s.term == TradeTypes.Incoterm.FOB || s.term == TradeTypes.Incoterm.CIF) _triggerSettlement(id);
    }

    /// @notice Escrows customs duty (zero allowed for duty-free destinations).
    function payCustomsDuty(uint256 id, uint256 amount) external {
        TradeTypes.Shipment memory s = _requireActive(id);
        bytes32 role = (s.term == TradeTypes.Incoterm.DDP) ? ROLE_EXPORTER : ROLE_IMPORTER;
        if (!hasRole(role, msg.sender)) revert Unauthorized(msg.sender);
        if (uint8(s.phase) < uint8(TradeTypes.Phase.LCFunded) || uint8(s.phase) > uint8(TradeTypes.Phase.Delivered)) {
            revert InvalidStateRange(id, s.phase);
        }

        if (amount > 0) settlementToken.safeTransferFrom(msg.sender, address(letterOfCredit), amount);
        letterOfCredit.payDuty(id, msg.sender, amount);
        emit DutyPaid(id, msg.sender, amount);
    }

    /// @notice Importer confirms final delivery. Releases the title; DDP pays out here.
    function confirmFinalDelivery(uint256 id) external onlyRole(ROLE_IMPORTER) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        if (s.importer != msg.sender) revert Unauthorized(msg.sender);
        _finalizeDelivery(id, msg.sender);
    }

    /// @notice Either bank may force-finalize once objective milestones are complete.
    function forceFinalizeDelivery(uint256 id) external onlyRole(ROLE_BANK) {
        _finalizeDelivery(id, msg.sender);
        emit DeliveryForceFinalized(id, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Neutrality safeguards
    // ---------------------------------------------------------------------

    /// @notice Refunds the escrow to the importer if the exporter never shipped before the deadline.
    function reclaimExpiredLC(uint256 id) external {
        TradeTypes.Shipment memory s = _requireShipment(id);
        bool authorised = msg.sender == s.importer ||
            hasRole(ROLE_BANK, msg.sender) ||
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!authorised) revert NotReclaimAuthority(msg.sender);

        letterOfCredit.refund(id);
        shipmentTracker.setPhase(id, TradeTypes.Phase.Reclaimed);
        emit LCReclaimed(id, s.importer, s.lcAmount, 0);
    }

    /// @notice Revokes a document: the original issuer or the admin.
    function revokeDocument(uint256 id, TradeTypes.DocType docType) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (msg.sender != documentRegistry.issuerOf(id, docType)) revert Unauthorized(msg.sender);
        }
        documentRegistry.revoke(id, docType);
    }

    // ---------------------------------------------------------------------
    // Internal engine
    // ---------------------------------------------------------------------

    function _roleForDocType(TradeTypes.DocType docType) internal pure returns (bytes32) {
        if (docType == TradeTypes.DocType.CertificateOfOrigin) return ROLE_EXPORTER;
        if (
            docType == TradeTypes.DocType.InspectionCertificate ||
            docType == TradeTypes.DocType.InsuranceCertificate ||
            docType == TradeTypes.DocType.CustomsClearance
        ) return ROLE_VERIFIER;
        revert DocumentNotAnchorable(docType);
    }

    function _triggerSettlement(uint256 id) internal {
        TradeTypes.Shipment memory s = shipmentTracker.getShipment(id);
        letterOfCredit.settle(id, s.exporter);
        emit AtomicLCPayoutExecuted(id, s.exporter, s.lcAmount, s.phase);
    }

    function _finalizeDelivery(uint256 id, address actor) internal {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.LoadedOnVessel) {
            revert InvalidState(id, TradeTypes.Phase.LoadedOnVessel, s.phase);
        }

        complianceEngine.requireCompliant(id, s.term, TradeTypes.Phase.Delivered);

        shipmentTracker.setPhase(id, TradeTypes.Phase.Delivered);
        shipmentTracker.transferTitle(id, s.importer);
        emit MilestoneReached(id, TradeTypes.Phase.Delivered, actor);
        emit TitleTransferred(id, address(this), s.importer);

        if (s.term == TradeTypes.Incoterm.DDP) _triggerSettlement(id);
        _maybeSettle(id);
    }

    function _maybeSettle(uint256 id) internal {
        TradeTypes.Shipment memory s = shipmentTracker.getShipment(id);
        if (s.phase == TradeTypes.Phase.Delivered && letterOfCredit.isPaid(id)) {
            shipmentTracker.setPhase(id, TradeTypes.Phase.Settled);
        }
    }

    function _requireShipment(uint256 id) internal view returns (TradeTypes.Shipment memory s) {
        s = shipmentTracker.getShipment(id);
        if (s.importer == address(0)) revert ShipmentNotFound(id);
    }

    function _requireActive(uint256 id) internal view returns (TradeTypes.Shipment memory s) {
        s = _requireShipment(id);
        if (s.phase == TradeTypes.Phase.Settled || s.phase == TradeTypes.Phase.Reclaimed) {
            revert InvalidStateRange(id, s.phase);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getOrder(uint256 orderId) external view returns (TradeTypes.Order memory) {
        return shipmentTracker.getOrder(orderId);
    }

    function getShipment(uint256 id) external view returns (TradeTypes.Shipment memory) {
        return shipmentTracker.getShipment(id);
    }

    function getDocument(uint256 id, TradeTypes.DocType docType) external view returns (TradeTypes.DocRecord memory) {
        return documentRegistry.getDocument(id, docType);
    }

    function getLC(uint256 id) external view returns (LetterOfCredit.LC memory) {
        return letterOfCredit.getLC(id);
    }

    function orderCount() external view returns (uint256) {
        return shipmentTracker.orderCount();
    }

    function shipmentCount() external view returns (uint256) {
        return shipmentTracker.shipmentCount();
    }

    function hasValidDocument(uint256 id, TradeTypes.DocType docType) external view returns (bool) {
        return documentRegistry.isValid(id, docType);
    }

    function payoutPhaseOf(TradeTypes.Incoterm term) external pure returns (TradeTypes.Phase) {
        if (term == TradeTypes.Incoterm.EXW) return TradeTypes.Phase.PickedUp;
        if (term == TradeTypes.Incoterm.DDP) return TradeTypes.Phase.Delivered;
        return TradeTypes.Phase.LoadedOnVessel;
    }

    function requiredDocumentsAt(uint256 id, TradeTypes.Phase phase) external view returns (uint8) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        return complianceEngine.requiredMask(s.term, phase);
    }

    function isCompliant(uint256 id, TradeTypes.Phase phase) external view returns (bool) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        return complianceEngine.isCompliant(id, s.term, phase);
    }

    /// @notice Accepts the escrowed title token (safe-mint receiver hook).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
