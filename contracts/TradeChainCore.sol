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
///         receives the `TradeUSD` settlement token and orchestrates the full documentary-credit
///         workflow: the importer applies for a credit, the **issuing bank issues and prefunds**
///         it, the beneficiary ships, **presents** the stipulated documents, the bank **examines
///         and honors** the presentation (sight or deferred), and custody/title follow the
///         Incoterm independently of payment.
/// @dev    The access control of the companion modules (`DocumentRegistry`, `LetterOfCredit`,
///         `ComplianceEngine`) is mounted here: each module grants its `DEFAULT_ADMIN_ROLE` and
///         `CONTROLLER_ROLE` to this core at construction, so the modules' writers and their role
///         administration are managed from this single authority (`setModuleRole`). The active
///         `DocumentRegistry` is swappable by the admin or `ROLE_REGISTRY_ADMIN`
///         (`setDocumentRegistry`), and the registry used for each anchor is snapshotted so a
///         swap never orphans documents that are already anchored. The console interacts with one
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

    /// @notice Registry that holds each `(trade, DocType)` anchor, snapshotted at anchor time so
    ///         that replacing the active registry never orphans documents of in-flight trades.
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
    error InvalidCustody(uint256 id, TradeTypes.Custody expected, TradeTypes.Custody actual);
    error DocumentNotAnchorable(TradeTypes.DocType docType);
    error NotBeneficiary(uint256 id, address caller);
    error NotReclaimAuthority(address caller);
    error CreditExpired(uint256 id, uint64 deadline);
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
        TradeTypes.PaymentTerm paymentTerm,
        uint64 deferredDays,
        uint256 lcAmount,
        uint64 deadline
    );
    // Issuance/presentation details are emitted by the LetterOfCredit module
    // (LCIssued / LCPresented) — no duplicate core-level events.
    event ShipmentCreated(
        uint256 indexed id,
        uint256 indexed orderId,
        address indexed exporter,
        address importer,
        TradeTypes.Incoterm term,
        uint256 lcAmount,
        uint64 deadline
    );
    event MilestoneReached(uint256 indexed id, TradeTypes.Custody custody, address indexed actor);
    event AtomicLCPayoutExecuted(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event DutyPaid(uint256 indexed id, address indexed payer, uint256 amount);
    event TitleTransferred(uint256 indexed id, address indexed from, address indexed to);
    event LCReclaimed(uint256 indexed id, address indexed issuingBank, uint256 lcRefund, uint256 dutyRefund);
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
    ///         per `(trade, DocType)`, so in-flight trades keep resolving correctly.
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
    // Application → issuance → shipment → presentation
    // ---------------------------------------------------------------------

    /// @notice The importer (L/C applicant) opens a purchase order naming the beneficiary and
    ///         the requested payment terms (sight, or deferred with a deferral in days). The
    ///         trade record is opened in phase `OrderPlaced`; nothing is funded yet.
    function createOrder(
        address exporter,
        TradeTypes.Incoterm term,
        uint256 lcAmount,
        uint64 deadline,
        TradeTypes.PaymentTerm paymentTerm,
        uint64 deferredDays
    ) external onlyRole(ROLE_IMPORTER) returns (uint256 orderId) {
        orderId = shipmentTracker.createOrder(
            msg.sender,
            exporter,
            term,
            paymentTerm,
            deferredDays,
            lcAmount,
            deadline
        );
        emit OrderCreated(orderId, msg.sender, exporter, term, paymentTerm, deferredDays, lcAmount, deadline);
    }

    /// @notice The issuing bank issues the credit against the application and prefunds the
    ///         escrow: `order.lcAmount` of `TradeUSD` is pulled from the bank into the
    ///         `LetterOfCredit`. The stipulated documentary set is recorded from the
    ///         `ComplianceEngine`. Only after this may the named exporter ship.
    /// @dev    The trade record mirrors every application field, so the shipment struct carries
    ///         the issued terms (`orderId == shipmentId`).
    function issueLetterOfCredit(uint256 orderId) external onlyRole(ROLE_BANK) {
        TradeTypes.Shipment memory s = _requireShipment(orderId);
        if (s.phase != TradeTypes.Phase.OrderPlaced) {
            revert InvalidState(orderId, TradeTypes.Phase.OrderPlaced, s.phase);
        }
        if (block.timestamp >= s.deadline) revert CreditExpired(orderId, s.deadline);

        uint8 requiredDocs = complianceEngine.presentationMask(s.term);
        settlementToken.safeTransferFrom(msg.sender, address(letterOfCredit), s.lcAmount);
        letterOfCredit.issue(
            orderId,
            msg.sender,
            s.exporter,
            s.lcAmount,
            s.paymentTerm,
            s.deferredDays,
            requiredDocs
        );
        shipmentTracker.setPhase(orderId, TradeTypes.Phase.LCIssued);
    }

    /// @notice The **named** exporter ships against the issued credit, anchoring the invoice and
    ///         packing list and escrowing the title token. Reverts until the bank has issued an
    ///         operative credit and after the credit's expiry.
    function createShipment(
        uint256 orderId,
        string calldata invoiceCID,
        string calldata packingListCID
    ) external onlyRole(ROLE_EXPORTER) returns (uint256 id) {
        TradeTypes.Shipment memory s = _requireShipment(orderId);
        if (s.exporter != msg.sender) revert NotBeneficiary(orderId, msg.sender);
        if (s.phase != TradeTypes.Phase.LCIssued) {
            revert InvalidState(orderId, TradeTypes.Phase.LCIssued, s.phase);
        }

        id = orderId; // the order and its trade record share one id
        shipmentTracker.ship(orderId, msg.sender);
        _anchor(id, TradeTypes.DocType.CommercialInvoice, invoiceCID, msg.sender);
        _anchor(id, TradeTypes.DocType.PackingList, packingListCID, msg.sender);
        shipmentTracker.mint(address(this), id, "");

        emit ShipmentCreated(id, orderId, msg.sender, s.importer, s.term, s.lcAmount, s.deadline);
    }

    /// @notice The beneficiary records the presentation of the stipulated documents for the
    ///         trade. The presentation set must be complete and verified at this point, and the
    ///         credit must not have expired; the bank re-examines before honoring.
    function presentDocuments(uint256 id) external onlyRole(ROLE_EXPORTER) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        if (s.exporter != msg.sender) revert NotBeneficiary(id, msg.sender);
        if (s.phase != TradeTypes.Phase.Shipped) revert InvalidState(id, TradeTypes.Phase.Shipped, s.phase);
        if (block.timestamp > s.deadline) revert CreditExpired(id, s.deadline);

        complianceEngine.requirePresentationCompliant(id, s.term);
        letterOfCredit.recordPresentation(id);
        shipmentTracker.setPhase(id, TradeTypes.Phase.Presented);
    }

    /// @notice The issuing bank examines the presentation against the credit's stipulated
    ///         documentary set (and the on-chain CID/verification state) and honors a complying
    ///         presentation: at sight the proceeds are paid immediately; with deferred terms the
    ///         payment is scheduled for `honoredAt + deferredDays` and released by
    ///         `drawDeferredPayment` at maturity.
    function honorPresentation(uint256 id) external onlyRole(ROLE_BANK) {
        TradeTypes.Shipment memory s = _requireActive(id);
        // Delivery may complete while the documents are under examination; the credit itself
        // must have been presented (recorded by `presentDocuments`) and not yet honored.
        if (!letterOfCredit.isPresented(id)) revert InvalidState(id, TradeTypes.Phase.Presented, s.phase);

        bool paidNow = letterOfCredit.honor(id, s.exporter);
        if (paidNow) {
            // Sight: proceeds leave the escrow inside the module's reentrancy guard.
            emit AtomicLCPayoutExecuted(id, s.exporter, s.lcAmount);
        }

        shipmentTracker.setPhase(
            id,
            s.custody == TradeTypes.Custody.Delivered
                ? TradeTypes.Phase.Settled
                : TradeTypes.Phase.Honored
        );
    }

    /// @notice Releases the proceeds of an honored deferred credit at maturity. Permissionless
    ///         after maturity: the bank's undertaking is deterministic and no party can stall it.
    function drawDeferredPayment(uint256 id) external {
        TradeTypes.Shipment memory s = _requireShipment(id);
        if (
            s.phase != TradeTypes.Phase.Honored && s.phase != TradeTypes.Phase.Delivered
        ) revert InvalidState(id, TradeTypes.Phase.Honored, s.phase);

        letterOfCredit.drawDeferred(id, s.exporter);
        emit AtomicLCPayoutExecuted(id, s.exporter, s.lcAmount);

        if (s.custody == TradeTypes.Custody.Delivered) {
            shipmentTracker.setPhase(id, TradeTypes.Phase.Settled);
        }
    }

    /// @notice Anchors a certificate of origin (exporter) or a verifier-attested document.
    ///         Certificates may only be anchored once the goods are shipped against the credit.
    function anchorDocument(uint256 id, TradeTypes.DocType docType, string calldata cid) external {
        TradeTypes.Shipment memory s = _requireShipment(id);
        bytes32 role = _roleForDocType(docType);
        if (!hasRole(role, msg.sender)) revert Unauthorized(msg.sender);
        if (uint8(s.phase) < uint8(TradeTypes.Phase.Shipped) || s.phase == TradeTypes.Phase.Reclaimed) {
            revert InvalidStateRange(id, s.phase);
        }
        _anchor(id, docType, cid, msg.sender);
    }

    /// @notice The applicant (importer) reimburses the issuing bank on-chain for the credit
    ///         amount. Only possible once the proceeds have been released — sight: at honor;
    ///         deferred: at maturity — which is when the bank is actually out of pocket.
    ///         The reimbursement is recorded on the credit (`LCReimbursed`).
    function reimburseIssuingBank(uint256 orderId) external onlyRole(ROLE_IMPORTER) {
        TradeTypes.Shipment memory s = _requireShipment(orderId);
        if (s.importer != msg.sender) revert Unauthorized(msg.sender);
        letterOfCredit.reimburse(orderId);
    }

    // ---------------------------------------------------------------------
    // Custody milestones (payment does NOT follow these)
    // ---------------------------------------------------------------------

    /// @notice Logistics confirms pickup: goods leave the exporter. Under EXW risk moves to the
    ///         importer. No payment is triggered — the credit pays on honor.
    function confirmPickup(uint256 id) external onlyRole(ROLE_LOGISTICS) {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.Shipped) revert InvalidState(id, TradeTypes.Phase.Shipped, s.phase);
        if (s.custody != TradeTypes.Custody.AtExporter) {
            revert InvalidCustody(id, TradeTypes.Custody.AtExporter, s.custody);
        }

        complianceEngine.requireCompliant(id, s.term, TradeTypes.Custody.PickedUp);

        shipmentTracker.setCustody(id, TradeTypes.Custody.PickedUp);
        // Risk passes to the importer at pickup under EXW only; FOB/CIF pass it on the vessel and
        // DDP at destination (see confirmVesselLoading / _finalizeDelivery).
        if (s.term == TradeTypes.Incoterm.EXW) {
            shipmentTracker.setRiskHolder(id, s.importer);
        }
        emit MilestoneReached(id, TradeTypes.Custody.PickedUp, msg.sender);
    }

    /// @notice Logistics confirms loading, anchors the B/L (or AWB) and sets the title URI.
    ///         Under FOB/CIF risk moves to the importer. No payment is triggered.
    function confirmVesselLoading(uint256 id, string calldata blCid) external onlyRole(ROLE_LOGISTICS) {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.phase != TradeTypes.Phase.Shipped) revert InvalidState(id, TradeTypes.Phase.Shipped, s.phase);
        if (s.custody != TradeTypes.Custody.PickedUp) {
            revert InvalidCustody(id, TradeTypes.Custody.PickedUp, s.custody);
        }

        _anchor(id, TradeTypes.DocType.BillOfLadingOrAWB, blCid, msg.sender);
        shipmentTracker.setTokenURI(id, string.concat("ipfs://", blCid));
        complianceEngine.requireCompliant(id, s.term, TradeTypes.Custody.OnVessel);

        shipmentTracker.setCustody(id, TradeTypes.Custody.OnVessel);
        // FOB/CIF transfer risk on the vessel; EXW already passed it at pickup.
        if (s.term == TradeTypes.Incoterm.FOB || s.term == TradeTypes.Incoterm.CIF) {
            shipmentTracker.setRiskHolder(id, s.importer);
        }
        emit MilestoneReached(id, TradeTypes.Custody.OnVessel, msg.sender);
    }

    /// @notice Escrows customs duty (zero allowed for duty-free destinations). DDP duty must be
    ///         paid before the bank honors the credit.
    function payCustomsDuty(uint256 id, uint256 amount) external {
        TradeTypes.Shipment memory s = _requireShipment(id);
        bytes32 role = (s.term == TradeTypes.Incoterm.DDP) ? ROLE_EXPORTER : ROLE_IMPORTER;
        if (!hasRole(role, msg.sender)) revert Unauthorized(msg.sender);
        if (
            uint8(s.phase) < uint8(TradeTypes.Phase.Shipped) ||
            uint8(s.phase) > uint8(TradeTypes.Phase.Delivered)
        ) revert InvalidStateRange(id, s.phase);
        // Duty is forwarded to the treasury only when the credit's proceeds are released. Once
        // the credit has paid, escrowing duty here would lock it forever, so it must be paid
        // before honor/maturity.
        if (letterOfCredit.isPaid(id)) revert LCAlreadySettled(id);

        if (amount > 0) settlementToken.safeTransferFrom(msg.sender, address(letterOfCredit), amount);
        letterOfCredit.payDuty(id, msg.sender, amount);
        emit DutyPaid(id, msg.sender, amount);
    }

    /// @notice Importer confirms final delivery. Releases the title.
    function confirmFinalDelivery(uint256 id) external onlyRole(ROLE_IMPORTER) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        if (s.importer != msg.sender) revert Unauthorized(msg.sender);
        _finalizeDelivery(id, msg.sender);
    }

    /// @notice Either bank may force-finalize once objective custody milestones are complete.
    function forceFinalizeDelivery(uint256 id) external onlyRole(ROLE_BANK) {
        _finalizeDelivery(id, msg.sender);
        emit DeliveryForceFinalized(id, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Neutrality safeguards
    // ---------------------------------------------------------------------

    /// @notice Returns the funds of an expired, unused credit to the **issuing bank** (the
    ///         importer never funded the escrow). If the beneficiary had shipped but never
    ///         presented, the escrowed title returns to the exporter with the goods.
    function reclaimExpiredLC(uint256 orderId) external {
        TradeTypes.Shipment memory s = _requireShipment(orderId);
        bool authorised = msg.sender == s.importer ||
            hasRole(ROLE_BANK, msg.sender) ||
            hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!authorised) revert NotReclaimAuthority(msg.sender);

        LetterOfCredit.LC memory lc = letterOfCredit.getLC(orderId);
        uint256 dutyRefund = lc.dutyPaid ? lc.dutyAmount : 0;
        address bank = lc.issuingBank;

        letterOfCredit.reclaim(orderId);
        shipmentTracker.setPhase(orderId, TradeTypes.Phase.Reclaimed);
        // Goods shipped but never presented: return the escrowed title to the exporter.
        if (shipmentTracker.exists(orderId)) {
            shipmentTracker.setCustody(orderId, TradeTypes.Custody.AtExporter);
            shipmentTracker.setRiskHolder(orderId, s.exporter);
            shipmentTracker.transferTitle(orderId, s.exporter);
            emit TitleTransferred(orderId, address(this), s.exporter);
        }
        emit LCReclaimed(orderId, bank, s.lcAmount, dutyRefund);
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

    function _finalizeDelivery(uint256 id, address actor) internal {
        TradeTypes.Shipment memory s = _requireActive(id);
        if (s.custody != TradeTypes.Custody.OnVessel) {
            revert InvalidCustody(id, TradeTypes.Custody.OnVessel, s.custody);
        }

        complianceEngine.requireCompliant(id, s.term, TradeTypes.Custody.Delivered);

        shipmentTracker.setCustody(id, TradeTypes.Custody.Delivered);
        // Under DDP risk passes only on delivery at destination.
        if (s.term == TradeTypes.Incoterm.DDP) {
            shipmentTracker.setRiskHolder(id, s.importer);
        }
        shipmentTracker.transferTitle(id, s.importer);
        emit MilestoneReached(id, TradeTypes.Custody.Delivered, actor);
        emit TitleTransferred(id, address(this), s.importer);

        // Custody and the credit converge: a paid credit settles on delivery; an unpaid one
        // settles when the bank honors (or the deferred payment is drawn) after delivery.
        shipmentTracker.setPhase(id, letterOfCredit.isPaid(id) ? TradeTypes.Phase.Settled : TradeTypes.Phase.Delivered);
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

    /// @notice Stipulated documentary set of the credit for a trade's Incoterm.
    function presentationDocuments(uint256 id) external view returns (uint8) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        return complianceEngine.presentationMask(s.term);
    }

    // Custody-gate masks/compliance are read through the ComplianceEngine directly
    // (`requiredForShipment(id, custody)`, `isCompliant(id, term, custody)`); the core
    // keeps the credit-facing views (`presentationDocuments`, `examinePresentation`).

    /// @notice Bank's examination preview: the first stipulated document that is missing or
    ///         revoked, if any. `(true, _)` means a complying presentation.
    function examinePresentation(uint256 id) external view returns (bool ok, TradeTypes.DocType missing) {
        TradeTypes.Shipment memory s = _requireShipment(id);
        return complianceEngine.firstMissingPresentation(id, s.term);
    }

    /// @notice Accepts the escrowed title token (safe-mint receiver hook).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
