// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {TradeTypes} from "../libraries/TradeTypes.sol";
import {ShipmentTracker} from "./ShipmentTracker.sol";
import {ComplianceEngine} from "./ComplianceEngine.sol";

/// @title LetterOfCredit — bank-issued documentary credit: escrow, examination and honor
/// @notice Models a documentary credit instead of a buyer escrow: the **issuing bank** issues the
///         credit against the importer's application and prefunds the `TradeUSD` escrow, the
///         **beneficiary** (exporter) ships and presents the stipulated documents, and the bank
///         **examines** the presentation against the credit's documentary terms before honoring
///         it — at sight (pay on examination) or after the agreed deferral (pay at maturity).
///         Expired, unused funds return to the issuing bank, not to the importer.
/// @dev    Access control is **mounted on the `TradeChainCore`**: the core is granted
///         `DEFAULT_ADMIN_ROLE` and `CONTROLLER_ROLE` at construction and every mutator is
///         `CONTROLLER_ROLE`-gated, so the core remains the only writer while the core's own
///         `AccessControl` administers who may hold that role. The bank's issuance decision and
///         examination happen in the core (role-gated); this module records state and moves value
///         under strict checks-effects-interactions, `nonReentrant` on every paying path.
contract LetterOfCredit is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to issue, honor, draw, reclaim and re-point the escrow (held by the core).
    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");

    /// @notice One documentary credit per trade (`id == orderId == shipmentId`).
    struct LC {
        uint256 id;
        address issuingBank; // issued the credit and prefunded the escrow
        address beneficiary; // the named exporter entitled to the proceeds
        uint256 amount;
        TradeTypes.PaymentTerm term; // Sight or Deferred
        uint64 deferredDays; // agreed deferral for `Deferred` (0 for `Sight`)
        uint64 issuedAt;
        uint8 requiredDocs; // stipulated documentary set at issuance (bitmask of `DocType`)
        bool issued;
        bool presented;
        uint64 presentedAt;
        bool honored;
        uint64 honoredAt;
        uint64 maturityAt; // sight: == honoredAt; deferred: honoredAt + deferredDays
        bool paid; // proceeds released to the beneficiary
        bool reclaimed; // expired unused credit returned to the issuing bank
        uint256 dutyAmount;
        bool dutyPaid;
        address dutyPayer;
    }

    address public immutable core;
    IERC20 public immutable token;
    ShipmentTracker public immutable tracker;
    ComplianceEngine public immutable compliance;
    address public treasury;

    mapping(uint256 id => LC) private _lcs;

    error ZeroAddress();
    error InvalidAmount();
    error NotIssued(uint256 id);
    error AlreadyIssued(uint256 id);
    error NotPresented(uint256 id);
    error AlreadyPresented(uint256 id);
    error AlreadyHonored(uint256 id);
    error NotHonored(uint256 id);
    error MaturityNotReached(uint64 maturityAt);
    error AlreadySettled(uint256 id);
    error CreditPresented(uint256 id);
    error DutyAlreadyPaid(uint256 id);
    error DutyNotPaid(uint256 id);
    error DeadlineNotReached(uint64 deadline);

    event LCIssued(
        uint256 indexed id,
        address indexed issuingBank,
        address indexed beneficiary,
        uint256 amount,
        TradeTypes.PaymentTerm term,
        uint64 deferredDays,
        uint8 requiredDocs
    );
    event LCPresented(uint256 indexed id, address indexed beneficiary, uint64 presentedAt);
    event LCHonored(uint256 indexed id, address indexed beneficiary, uint64 maturityAt, bool deferred);
    event LCPaid(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event DutyPaid(uint256 indexed id, address indexed payer, uint256 amount);
    event LCReclaimed(uint256 indexed id, address indexed issuingBank, uint256 lcRefund, uint256 dutyRefund);
    event TreasuryUpdated(address indexed treasury);

    constructor(
        address core_,
        address token_,
        address tracker_,
        address compliance_,
        address treasury_
    ) {
        if (
            core_ == address(0) ||
            token_ == address(0) ||
            tracker_ == address(0) ||
            compliance_ == address(0) ||
            treasury_ == address(0)
        ) revert ZeroAddress();
        core = core_;
        token = IERC20(token_);
        tracker = ShipmentTracker(tracker_);
        compliance = ComplianceEngine(compliance_);
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, core_);
        _grantRole(CONTROLLER_ROLE, core_);
    }

    // ---------------------------------------------------------------------
    // Core-only mutators
    // ---------------------------------------------------------------------

    /// @notice Records the issuance of the credit. The escrow tokens are transferred to this
    ///         contract by the core before calling (the issuing bank is the funder).
    function issue(
        uint256 id,
        address issuingBank,
        address beneficiary,
        uint256 amount,
        TradeTypes.PaymentTerm term,
        uint64 deferredDays,
        uint8 requiredDocs
    ) external onlyRole(CONTROLLER_ROLE) {
        LC storage lc = _lcs[id];
        if (lc.issued) revert AlreadyIssued(id);
        if (amount == 0) revert InvalidAmount();

        lc.id = id;
        lc.issuingBank = issuingBank;
        lc.beneficiary = beneficiary;
        lc.amount = amount;
        lc.term = term;
        lc.deferredDays = deferredDays;
        lc.issuedAt = uint64(block.timestamp);
        lc.requiredDocs = requiredDocs;
        lc.issued = true;

        emit LCIssued(id, issuingBank, beneficiary, amount, term, deferredDays, requiredDocs);
    }

    /// @notice Records the beneficiary's presentation of the stipulated documents. The core has
    ///         already checked the credit is live and the presentation set is complete.
    function recordPresentation(uint256 id) external onlyRole(CONTROLLER_ROLE) {
        LC storage lc = _lcs[id];
        if (!lc.issued) revert NotIssued(id);
        if (lc.presented) revert AlreadyPresented(id);

        lc.presented = true;
        lc.presentedAt = uint64(block.timestamp);

        emit LCPresented(id, lc.beneficiary, lc.presentedAt);
    }

    /// @notice Records the bank's examination of a presented credit and honors it. The compliance
    ///         (documentary) examination is repeated here so the module itself never honors a
    ///         discrepant presentation. Returns `true` when the proceeds were paid immediately
    ///         (sight); `false` when payment was scheduled at `maturityAt` (deferred).
    function honor(uint256 id, address beneficiary) external onlyRole(CONTROLLER_ROLE) nonReentrant returns (bool) {
        LC storage lc = _lcs[id];
        if (!lc.issued) revert NotIssued(id);
        if (lc.paid || lc.reclaimed) revert AlreadySettled(id);
        if (lc.honored) revert AlreadyHonored(id);
        if (!lc.presented) revert NotPresented(id);

        TradeTypes.Shipment memory s = tracker.getShipment(id);
        compliance.requirePresentationCompliant(id, s.term);
        if (s.term == TradeTypes.Incoterm.DDP && !lc.dutyPaid) revert DutyNotPaid(id);

        lc.honored = true;
        lc.honoredAt = uint64(block.timestamp);
        lc.maturityAt =
            lc.term == TradeTypes.PaymentTerm.Sight
                ? uint64(block.timestamp)
                : lc.honoredAt + lc.deferredDays * 1 days;

        if (lc.term == TradeTypes.PaymentTerm.Sight) {
            lc.paid = true;
            emit LCHonored(id, beneficiary, lc.maturityAt, false);
            _release(id, beneficiary);
            return true;
        }

        emit LCHonored(id, beneficiary, lc.maturityAt, true);
        return false;
    }

    /// @notice Releases the proceeds of an honored **deferred** credit once maturity is reached.
    ///         The bank's undertaking is deterministic, so the core may let anyone trigger it
    ///         after maturity (a neutrality safeguard).
    function drawDeferred(uint256 id, address beneficiary) external onlyRole(CONTROLLER_ROLE) nonReentrant {
        LC storage lc = _lcs[id];
        if (!lc.honored) revert NotHonored(id);
        if (lc.paid || lc.reclaimed) revert AlreadySettled(id);
        if (block.timestamp < lc.maturityAt) revert MaturityNotReached(lc.maturityAt);

        lc.paid = true;
        _release(id, beneficiary);
    }

    /// @notice Records a customs-duty escrow (zero is allowed for duty-free destinations).
    function payDuty(uint256 id, address payer, uint256 amount) external onlyRole(CONTROLLER_ROLE) {
        LC storage lc = _lcs[id];
        if (!lc.issued) revert NotIssued(id);
        if (lc.dutyPaid) revert DutyAlreadyPaid(id);

        lc.dutyPaid = true;
        lc.dutyAmount = amount;
        lc.dutyPayer = payer;

        emit DutyPaid(id, payer, amount);
    }

    /// @notice Returns the funds of an expired, unused credit to the **issuing bank**. A credit
    ///         with a recorded presentation was used: it must be honored (or refused off-chain),
    ///         never reclaimed.
    function reclaim(uint256 id) external onlyRole(CONTROLLER_ROLE) nonReentrant {
        LC storage lc = _lcs[id];
        if (!lc.issued) revert NotIssued(id);
        if (lc.paid || lc.reclaimed) revert AlreadySettled(id);
        if (lc.honored) revert AlreadyHonored(id);
        if (lc.presented) revert CreditPresented(id);

        TradeTypes.Shipment memory s = tracker.getShipment(id);
        if (block.timestamp <= s.deadline) revert DeadlineNotReached(s.deadline);

        lc.reclaimed = true;
        uint256 lcRefund = lc.amount;
        uint256 dutyRefund = lc.dutyPaid ? lc.dutyAmount : 0;
        address bank = lc.issuingBank;
        address dutyPayer = lc.dutyPayer;

        emit LCReclaimed(id, bank, lcRefund, dutyRefund);

        token.safeTransfer(bank, lcRefund);
        if (dutyRefund > 0) token.safeTransfer(dutyPayer, dutyRefund);
    }

    /// @notice Updates the duty treasury (customs-authority stand-in).
    function setTreasury(address treasury_) external onlyRole(CONTROLLER_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Releases the credit proceeds to the beneficiary and any escrowed duty to the treasury.
    ///      Callers set `paid` first (checks-effects-interactions) and hold `nonReentrant`.
    function _release(uint256 id, address beneficiary) private {
        LC storage lc = _lcs[id];
        uint256 amount = lc.amount;
        uint256 duty = lc.dutyAmount;

        emit LCPaid(id, beneficiary, amount);

        token.safeTransfer(beneficiary, amount);
        if (duty > 0) token.safeTransfer(treasury, duty);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getLC(uint256 id) external view returns (LC memory) {
        return _lcs[id];
    }

    function isIssued(uint256 id) external view returns (bool) {
        return _lcs[id].issued;
    }

    function isPresented(uint256 id) external view returns (bool) {
        return _lcs[id].presented;
    }

    function isHonored(uint256 id) external view returns (bool) {
        return _lcs[id].honored;
    }

    function isPaid(uint256 id) external view returns (bool) {
        return _lcs[id].paid;
    }

    function escrowBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
