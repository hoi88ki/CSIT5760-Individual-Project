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
/// @dev    The access control of the companion modules (`DocumentRegistry`, `LetterOfCredit`,
///         `ComplianceEngine`) is mounted here: each module grants its `DEFAULT_ADMIN_ROLE` and
///         `CONTROLLER_ROLE` to this core at construction, so the modules' writers and their role
///         administration are managed from this single authority (`setModuleRole`). The active
///         `DocumentRegistry` is swappable by the admin or `ROLE_REGISTRY_ADMIN`
///         (`setDocumentRegistry`), and the registry used for each anchor is snapshotted so a
///         swap never orphans documents that are already anchored. The DApp interacts with one
///         address while six contracts are deployed.
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
    /// @notice Role allowed to replace the active `DocumentRegistry` ("the corresponding role").
    bytes32 public constant ROLE_REGISTRY_ADMIN = keccak256("ROLE_REGISTRY_ADMIN");

    // ---------------------------------------------------------------------
    // Companion contracts + settlement token
    // ---------------------------------------------------------------------

    IERC20 public immutable settlementToken;
    ShipmentTracker public immutable shipmentTracker;
    /// @notice Active document registry. Swappable by the admin or `ROLE_REGISTRY_ADMIN`
    ///         (see `setDocumentRegistry`); the registry used for each anchor is snapshotted.
    DocumentRegistry public documentRegistry;
    ComplianceEngine public immutable complianceEngine;
    LetterOfCredit public immutable letterOfCredit;

    /// @notice Registry that holds each `(shipment, DocType)` anchor, snapshotted at anchor time so
    ///         that replacing the active registry never orphans documents of in-flight shipments.
    mapping(uint256 id => mapping(TradeTypes.DocType docType => address registry)) private _docRegistryOf;

    /// @notice Runtime codehash of the deployment-time registry. A replacement registry must match
    ///         it, so only a genuine `DocumentRegistry` (whose only writer is this core) can be
    ///         swapped in and a look-alike contract cannot forge `isValid` for compliance.
    bytes32 private _registryCodehash;

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
    error LCAlreadySettled(uint256 id);
    error RegistryAlreadyActive(address registry);
    error RegistryNotBoundToCore(address registry);
    error RegistryInvalidCode(address registry);
    error UnknownModule(address module);
    error CannotRevokeCoreAdmin(address module);

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
    event DocumentRegistryReplaced(address indexed oldRegistry, address indexed newRegistry);
    event ModuleRoleSet(address indexed module, bytes32 indexed role, address indexed account, bool granted);

    /// @param token_ The ERC-20 settlement token (e.g. `TradeUSD`). Must be non-zero.
    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        IERC20 token = token_;
        settlementToken = token;

        ShipmentTracker tracker = new ShipmentTracker(address(this));
        DocumentRegistry registry = new DocumentRegistry(address(this));
        ComplianceEngine compliance = new ComplianceEngine(address(this), address(registry), address(tracker));
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
        _registryCodehash = address(registry).codehash;

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

    /// @notice Replaces the active `DocumentRegistry`. Only the admin or `ROLE_REGISTRY_ADMIN`.
    /// @dev    The replacement must be bound to this core and its runtime code must match the
    ///         deployment-time registry, so only a genuine `DocumentRegistry` (whose only writer
    ///         is this core) can be swapped in and `isValid` cannot be forged for compliance.
    ///         Documents already anchored stay in their registry: the core snapshots the registry
    ///         per `(shipment, DocType)`, so in-flight shipments keep resolving correctly.
    function setDocumentRegistry(address newRegistry) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(ROLE_REGISTRY_ADMIN, msg.sender)) {
            revert Unauthorized(msg.sender);
        }
        if (newRegistry == address(0)) revert ZeroAddress();
        if (newRegistry == address(documentRegistry)) revert RegistryAlreadyActive(newRegistry);
        if (DocumentRegistry(newRegistry).core() != address(this)) revert RegistryNotBoundToCore(newRegistry);
        if (newRegistry.codehash != _registryCodehash) revert RegistryInvalidCode(newRegistry);

        emit DocumentRegistryReplaced(address(documentRegistry), newRegistry);
        documentRegistry = DocumentRegistry(newRegistry);
    }

    /// @notice Grants or revokes a role on a companion module. The modules' `AccessControl` is
    ///         mounted on this core, so this is the single place their writers are administered.
    /// @dev    `module` must be one of the core's own companions; the core holds each module's
    ///         `DEFAULT_ADMIN_ROLE`. Revoking the core's own admin is rejected so the modules can
    ///         never become unmanaged.
    function setModuleRole(
        address module,
        bytes32 role,
        address account,
        bool granted
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            module != address(documentRegistry) &&
            module != address(letterOfCredit) &&
            module != address(complianceEngine)
        ) revert UnknownModule(module);
        if (!granted && role == DEFAULT_ADMIN_ROLE && account == address(this)) {
            revert CannotRevokeCoreAdmin(module);
        }

        if (granted) {
            AccessControl(module).grantRole(role, account);
        } else {
            AccessControl(module).revokeRole(role, account);
        }
        emit ModuleRoleSet(module, role, account, granted);
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
        _anchor(id, TradeTypes.DocType.CommercialInvoice, invoiceCID, msg.sender);
        _anchor(id, TradeTypes.DocType.PackingList, packingListCID, msg.sender);
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
        _anchor(id, docType, cid, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Custody milestones
    // ---------------------------------------------------------------------

    /// @notice Logistics confirms pickup. Under EXW risk moves to the importer and the L/C pays out.
    function confirmPickup(uint256 id) external onlyRole(ROLE_LOGISTICS) {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.LCFunded) revert InvalidState(id, TradeTypes.Phase.LCFunded, s.phase);

        complianceEngine.requireCompliant(id, s.term, TradeTypes.Phase.PickedUp);

        shipmentTracker.setPhase(id, TradeTypes.Phase.PickedUp);
        // Risk passes to the importer at pickup under EXW only; FOB/CIF pass it on the vessel and
        // DDP at destination (see confirmVesselLoading / _finalizeDelivery).
        if (s.term == TradeTypes.Incoterm.EXW) {
            shipmentTracker.setRiskHolder(id, s.importer);
        }
        emit MilestoneReached(id, TradeTypes.Phase.PickedUp, msg.sender);

        if (s.term == TradeTypes.Incoterm.EXW) _triggerSettlement(id);
    }

    /// @notice Logistics confirms loading, anchors the B/L (or AWB) and sets the title URI.
    ///         Under FOB/CIF risk moves to the importer and the L/C pays out here.
    function confirmVesselLoading(uint256 id, string calldata blCid) external onlyRole(ROLE_LOGISTICS) {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.PickedUp) revert InvalidState(id, TradeTypes.Phase.PickedUp, s.phase);

        _anchor(id, TradeTypes.DocType.BillOfLadingOrAWB, blCid, msg.sender);
        shipmentTracker.setTokenURI(id, string.concat("ipfs://", blCid));
        complianceEngine.requireCompliant(id, s.term, TradeTypes.Phase.LoadedOnVessel);

        shipmentTracker.setPhase(id, TradeTypes.Phase.LoadedOnVessel);
        // FOB/CIF transfer risk on the vessel (the payout milestone); EXW already passed it at pickup.
        if (s.term == TradeTypes.Incoterm.FOB || s.term == TradeTypes.Incoterm.CIF) {
            shipmentTracker.setRiskHolder(id, s.importer);
        }
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
        // Duty is forwarded to the treasury only inside `LetterOfCredit.settle`. Once the L/C has been
        // paid (EXW at pickup, FOB/CIF at loading), escrowing duty here would lock it forever, so it
        // must be paid before the payout milestone.
        if (letterOfCredit.isPaid(id)) revert LCAlreadySettled(id);

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

        LetterOfCredit.LC memory lc = letterOfCredit.getLC(id);
        uint256 dutyRefund = lc.dutyPaid ? lc.dutyAmount : 0;

        letterOfCredit.refund(id);
        shipmentTracker.setPhase(id, TradeTypes.Phase.Reclaimed);
        emit LCReclaimed(id, s.importer, s.lcAmount, dutyRefund);
    }

    /// @notice Revokes a document: the original issuer or the admin.
    function revokeDocument(uint256 id, TradeTypes.DocType docType) external {
        DocumentRegistry reg = DocumentRegistry(documentRegistryOf(id, docType));
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (msg.sender != reg.issuerOf(id, docType)) revert Unauthorized(msg.sender);
        }
        reg.revoke(id, docType);
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

    /// @dev Anchors `docType` into the currently active registry and snapshots the pairing, so
    ///      replacing the registry later cannot hide or move an already-anchored document.
    function _anchor(uint256 id, TradeTypes.DocType docType, string calldata cid, address issuer) internal {
        DocumentRegistry reg = documentRegistry;
        reg.anchor(id, docType, cid, issuer);
        _docRegistryOf[id][docType] = address(reg);
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
        // Under DDP risk passes only on delivery at destination.
        if (s.term == TradeTypes.Incoterm.DDP) {
            shipmentTracker.setRiskHolder(id, s.importer);
        }
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

    /// @notice Registry that holds the `(id, docType)` anchor: the snapshot taken at anchor time,
    ///         or the currently active registry when that anchor has not been written yet.
    function documentRegistryOf(uint256 id, TradeTypes.DocType docType) public view returns (address) {
        address resolved = _docRegistryOf[id][docType];
        return resolved == address(0) ? address(documentRegistry) : resolved;
    }

    function getDocument(uint256 id, TradeTypes.DocType docType) external view returns (TradeTypes.DocRecord memory) {
        return DocumentRegistry(documentRegistryOf(id, docType)).getDocument(id, docType);
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
        return DocumentRegistry(documentRegistryOf(id, docType)).isValid(id, docType);
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
