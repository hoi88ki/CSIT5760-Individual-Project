// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DocumentRegistry} from "./DocumentRegistry.sol";
import {EBLToken} from "../tokens/EBLToken.sol";

/// @title SettlementModule — orders, smart Letter of Credit, duty and atomic payout
/// @notice Acts as an automated L/C examining bank: validates the per-Incoterm required document
///         set and releases a single 100% atomic payout in the ERC-20 settlement token at the
///         exact milestone where risk transfers. Adds neutrality safeguards (reclaim, force-finalize).
/// @dev    Settlement is denominated in an ERC-20 stablecoin (Q8 in QUESTIONS.md), not native ETH.
abstract contract SettlementModule is DocumentRegistry {
    using SafeERC20 for IERC20;

    /// @notice ERC-20 settlement token (stablecoin) used for the L/C and customs duty.
    IERC20 public settlementToken;
    /// @notice ERC-721 electronic Bill of Lading title token.
    EBLToken public eblToken;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    );
    event ShipmentCreated(
        uint256 indexed id,
        uint256 indexed orderId,
        address indexed seller,
        address buyer,
        Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    );
    event LetterOfCreditOpened(uint256 indexed id, address indexed buyer, uint256 amount);
    event MilestoneReached(uint256 indexed id, Phase phase, address indexed actor);
    event AtomicLCPayoutExecuted(uint256 indexed id, address indexed seller, uint256 amount, Phase atPhase);
    event DutyPaid(uint256 indexed id, address indexed payer, uint256 amount);
    event EBLTitleTransferred(uint256 indexed id, address indexed from, address indexed to);
    event LCReclaimed(uint256 indexed id, address indexed buyer, uint256 lcRefund, uint256 dutyRefund);
    event DeliveryForceFinalized(uint256 indexed id, address indexed bank);

    /// @dev One-time wiring (called from the core constructor).
    function _setSettlementToken(IERC20 token) internal {
        settlementToken = token;
    }

    /// @dev One-time wiring (called from the core constructor).
    function _setEBLToken(EBLToken token) internal {
        eblToken = token;
    }

    // =====================================================================
    // Order -> Shipment
    // =====================================================================

    /// @notice Buyer opens a purchase order for a named exporter before any shipment exists (Q1).
    function createOrder(
        address seller,
        Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    ) external onlyRole(ROLE_BUYER) returns (uint256 orderId) {
        if (seller == address(0)) revert ZeroAddress();
        if (lcAmount == 0) revert InvalidAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline(deadline);

        orderId = ++_nextOrderId;
        Order storage o = _orders[orderId];
        o.id = orderId;
        o.buyer = msg.sender;
        o.seller = seller;
        o.term = term;
        o.deadline = deadline;
        o.lcAmount = lcAmount;

        emit OrderCreated(orderId, msg.sender, seller, term, lcAmount, deadline);
    }

    /// @notice The named exporter accepts the order and creates the shipment (anchors invoice + packing list).
    function createShipment(
        uint256 orderId,
        string calldata invoiceCID,
        string calldata packingListCID
    ) external onlyRole(ROLE_SELLER) returns (uint256 id) {
        Order storage o = _requireOrder(orderId);
        if (o.fulfilled) revert OrderAlreadyFulfilled(orderId);
        if (o.seller != msg.sender) revert NotOrderedSeller(orderId, msg.sender);
        if (block.timestamp >= o.deadline) revert InvalidDeadline(o.deadline);

        id = ++_nextShipmentId;
        Shipment storage s = _shipments[id];
        s.id = id;
        s.orderId = orderId;
        s.seller = msg.sender;
        s.buyer = o.buyer;
        s.riskHolder = msg.sender; // Seller holds risk until the risk-transfer milestone
        s.term = o.term;
        s.phase = Phase.Created;
        s.createdAt = uint64(block.timestamp);
        s.deadline = o.deadline;
        s.lcAmount = o.lcAmount;

        o.fulfilled = true;
        o.shipmentId = id;

        _anchorInternal(id, DocType.CommercialInvoice, invoiceCID, msg.sender);
        _anchorInternal(id, DocType.PackingList, packingListCID, msg.sender);
        eblToken.mint(address(this), "");

        emit ShipmentCreated(id, orderId, msg.sender, o.buyer, o.term, o.lcAmount, o.deadline);
    }

    /// @notice Buyer escrows the L/C amount in the settlement token (requires prior `approve`).
    function openLetterOfCredit(uint256 id) external onlyRole(ROLE_BUYER) {
        Shipment storage s = _requireShipment(id);
        if (s.phase != Phase.Created) revert InvalidState(id, Phase.Created, s.phase);
        if (msg.sender != s.buyer) revert Unauthorized(msg.sender);

        s.lcFunded = true;
        s.phase = Phase.LCFunded;
        emit LetterOfCreditOpened(id, msg.sender, s.lcAmount);

        settlementToken.safeTransferFrom(msg.sender, address(this), s.lcAmount);
    }

    // =====================================================================
    // Custody milestones
    // =====================================================================

    /// @notice Carrier confirms pickup. Risk moves to the Buyer; EXW pays out here.
    function confirmPickup(uint256 id) external onlyRole(ROLE_CARRIER) {
        Shipment storage s = _requireShipment(id);
        if (s.phase != Phase.LCFunded) revert InvalidState(id, Phase.LCFunded, s.phase);

        _requireDocuments(id, _requiredAt(s.term, Phase.PickedUp));

        s.phase = Phase.PickedUp;
        s.riskHolder = s.buyer;
        emit MilestoneReached(id, Phase.PickedUp, msg.sender);

        if (s.term == Incoterm.EXW) _triggerAtomicPayout(id);
    }

    /// @notice Carrier confirms loading, anchors the B/L (/AWB) and updates the eB/L tokenURI. FOB/CIF pay out here.
    function confirmVesselLoading(uint256 id, string calldata blCid) external onlyRole(ROLE_CARRIER) {
        Shipment storage s = _requireShipment(id);
        if (s.phase != Phase.PickedUp) revert InvalidState(id, Phase.PickedUp, s.phase);

        _anchorInternal(id, DocType.BillOfLadingOrAWB, blCid, msg.sender);
        eblToken.setTokenURI(id, string.concat("ipfs://", blCid));

        _requireDocuments(id, _requiredAt(s.term, Phase.LoadedOnVessel));

        s.phase = Phase.LoadedOnVessel;
        emit MilestoneReached(id, Phase.LoadedOnVessel, msg.sender);

        if (s.term == Incoterm.FOB || s.term == Incoterm.CIF) _triggerAtomicPayout(id);
    }

    /// @notice Escrows customs duty. Zero duty is allowed for duty-free destinations (Q3/Q11).
    ///         Seller pays under DDP; the Buyer pays otherwise.
    function payCustomsDuty(uint256 id, uint256 dutyAmount) external {
        Shipment storage s = _requireShipment(id);
        bytes32 requiredRole = (s.term == Incoterm.DDP) ? ROLE_SELLER : ROLE_BUYER;
        if (!hasRole(requiredRole, msg.sender)) revert Unauthorized(msg.sender);
        if (s.dutyPaid) revert DutyAlreadyPaid(id);
        if (uint8(s.phase) < uint8(Phase.LCFunded) || uint8(s.phase) > uint8(Phase.Delivered)) {
            revert InvalidStateRange(id, s.phase);
        }

        s.dutyPaid = true;
        s.dutyAmount = dutyAmount;
        s.dutyPayer = msg.sender;
        emit DutyPaid(id, msg.sender, dutyAmount);

        if (dutyAmount > 0) {
            settlementToken.safeTransferFrom(msg.sender, address(this), dutyAmount);
        }
    }

    /// @notice Buyer confirms final delivery. Releases the eB/L title; DDP pays out here.
    function confirmFinalDelivery(uint256 id) external onlyRole(ROLE_BUYER) {
        Shipment storage s = _requireShipment(id);
        if (msg.sender != s.buyer) revert Unauthorized(msg.sender);
        _finalizeDelivery(id, msg.sender);
    }

    /// @notice Either bank may force-finalize once all objective milestones are complete (Q6).
    function forceFinalizeDelivery(uint256 id) external {
        if (!hasRole(ROLE_ISSUING_BANK, msg.sender) && !hasRole(ROLE_ADVISING_BANK, msg.sender)) {
            revert Unauthorized(msg.sender);
        }
        _finalizeDelivery(id, msg.sender);
        emit DeliveryForceFinalized(id, msg.sender);
    }

    // =====================================================================
    // Neutrality safeguards
    // =====================================================================

    /// @notice Returns escrow to the Buyer if the Seller never shipped before the deadline.
    /// @dev    Restricted to the Buyer, the issuing bank or the admin (Q10).
    function reclaimExpiredLC(uint256 id) external nonReentrant {
        Shipment storage s = _requireShipment(id);

        bool authorised = msg.sender == s.buyer ||
            hasRole(ROLE_ISSUING_BANK, msg.sender) ||
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!authorised) revert NotReclaimAuthority(msg.sender);

        if (block.timestamp <= s.deadline) revert DeadlineNotReached(s.deadline);
        if (s.phase != Phase.LCFunded) revert NothingToReclaim(id);

        s.phase = Phase.Reclaimed;

        uint256 lcRefund = s.lcAmount;
        uint256 dutyRefund = s.dutyPaid ? s.dutyAmount : 0;
        address buyer = s.buyer;
        address dutyPayer = s.dutyPayer;

        emit LCReclaimed(id, buyer, lcRefund, dutyRefund);

        settlementToken.safeTransfer(buyer, lcRefund);
        if (dutyRefund > 0) settlementToken.safeTransfer(dutyPayer, dutyRefund);
    }

    // =====================================================================
    // Internal engine
    // =====================================================================

    /// @dev Milestone at which risk (and therefore payment) transfers for each Incoterm.
    function _payoutPhase(Incoterm t) internal pure returns (Phase) {
        if (t == Incoterm.EXW) return Phase.PickedUp;
        if (t == Incoterm.DDP) return Phase.Delivered;
        return Phase.LoadedOnVessel; // FOB, CIF
    }

    /// @dev Mandatory document bitmask for a given Incoterm + phase.
    function _requiredAt(Incoterm t, Phase p) internal pure returns (uint8 mask) {
        uint8 base = _bit(DocType.CommercialInvoice) | _bit(DocType.PackingList);

        if (p == Phase.PickedUp) {
            return base;
        }
        if (p == Phase.LoadedOnVessel) {
            if (t == Incoterm.EXW) return base | _bit(DocType.BillOfLadingOrAWB);
            if (t == Incoterm.CIF) {
                return base | _bit(DocType.InspectionCertificate) | _bit(DocType.BillOfLadingOrAWB) | _bit(DocType.InsuranceCertificate);
            }
            return base | _bit(DocType.InspectionCertificate) | _bit(DocType.BillOfLadingOrAWB); // FOB, DDP
        }
        if (p == Phase.Delivered) {
            if (t == Incoterm.DDP) {
                return
                    base |
                    _bit(DocType.InspectionCertificate) |
                    _bit(DocType.BillOfLadingOrAWB) |
                    _bit(DocType.CertificateOfOrigin) |
                    _bit(DocType.CustomsClearance);
            }
            if (t == Incoterm.CIF) {
                return base | _bit(DocType.InspectionCertificate) | _bit(DocType.BillOfLadingOrAWB) | _bit(DocType.InsuranceCertificate);
            }
            if (t == Incoterm.FOB) {
                return base | _bit(DocType.InspectionCertificate) | _bit(DocType.BillOfLadingOrAWB);
            }
            return base | _bit(DocType.BillOfLadingOrAWB); // EXW
        }
        return 0;
    }

    /// @dev Marks the shipment Settled once both the title and the payment are done.
    function _maybeSettle(uint256 id) internal {
        Shipment storage s = _shipments[id];
        if (s.phase == Phase.Delivered && s.lcPaid) {
            s.phase = Phase.Settled;
        }
    }

    /// @dev Transfers the eB/L title, reaches Delivered and (for DDP) triggers payout.
    function _finalizeDelivery(uint256 id, address actor) internal {
        Shipment storage s = _requireShipment(id);
        if (s.phase != Phase.LoadedOnVessel) revert InvalidState(id, Phase.LoadedOnVessel, s.phase);

        _requireDocuments(id, _requiredAt(s.term, Phase.Delivered));

        s.phase = Phase.Delivered;
        s.titleTransferred = true;
        emit MilestoneReached(id, Phase.Delivered, actor);

        eblToken.transferTitle(id, s.buyer);
        emit EBLTitleTransferred(id, address(this), s.buyer);

        if (s.term == Incoterm.DDP) _triggerAtomicPayout(id);
        _maybeSettle(id);
    }

    /// @dev The single atomic payout. `nonReentrant` + strict CEI (Q19).
    function _triggerAtomicPayout(uint256 id) internal nonReentrant {
        Shipment storage s = _requireShipment(id);
        if (s.lcPaid) revert SettlementAlreadyExecuted(id);
        if (!s.lcFunded) revert InvalidState(id, Phase.LCFunded, s.phase);

        Phase due = _payoutPhase(s.term);
        if (s.phase != due) revert SettlementNotDue(id, s.phase);

        _requireDocuments(id, _requiredAt(s.term, due));
        if (s.term == Incoterm.DDP && !s.dutyPaid) revert CustomsDutyNotPaid(id);

        // --- Effects before interaction ---
        s.lcPaid = true;
        s.riskHolder = s.buyer;
        uint256 amount = s.lcAmount;
        address seller = s.seller;

        emit AtomicLCPayoutExecuted(id, seller, amount, due);
        _maybeSettle(id);

        // --- Interaction ---
        settlementToken.safeTransfer(seller, amount);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function getShipment(uint256 id) external view returns (Shipment memory) {
        return _shipments[id];
    }

    function orderCount() external view returns (uint256) {
        return _nextOrderId;
    }

    function shipmentCount() external view returns (uint256) {
        return _nextShipmentId;
    }

    /// @notice Payout milestone for a given Incoterm.
    function payoutPhaseOf(Incoterm term) external pure returns (Phase) {
        return _payoutPhase(term);
    }

    /// @notice Required-document bitmask for a shipment's next mandatory milestone.
    function requiredDocumentsAt(uint256 id, Phase phase) external view returns (uint8) {
        Shipment storage s = _requireShipment(id);
        return _requiredAt(s.term, phase);
    }

    /// @notice True when a document is anchored and its certificate (if any) is unrevoked.
    function hasValidDocument(uint256 id, DocType docType) external view returns (bool) {
        return _hasValidDocument(id, docType);
    }
}
