// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {TradeTypes} from "../libraries/TradeTypes.sol";
import {ShipmentTracker} from "./ShipmentTracker.sol";
import {ComplianceEngine} from "./ComplianceEngine.sol";

/// @title LetterOfCredit — escrow and L/C state machine
/// @notice Holds the `TradeUSD` escrow and drives settlement: funding, customs duty, the atomic
///         payout at the Incoterm risk-transfer milestone, and the deadline refund (reclaim).
///         Mutators are restricted to the `TradeChainCore`.
/// @dev    Payout follows strict checks-effects-interactions and is `nonReentrant`.
contract LetterOfCredit is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct LC {
        uint256 shipmentId;
        uint256 amount;
        bool funded;
        bool paid;
        bool reclaimed;
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

    error OnlyCore();
    error ZeroAddress();
    error InvalidAmount();
    error AlreadyFunded(uint256 id);
    error NotFunded(uint256 id);
    error AlreadySettled(uint256 id);
    error DutyAlreadyPaid(uint256 id);
    error DutyNotPaid(uint256 id);
    error NotPayoutPhase(uint256 id, TradeTypes.Phase expected, TradeTypes.Phase actual);
    error DeadlineNotReached(uint256 deadline);
    error NothingToReclaim(uint256 id);

    event LCFunded(uint256 indexed id, address indexed payer, uint256 amount);
    event LCSettled(uint256 indexed id, address indexed exporter, uint256 amount, TradeTypes.Phase atPhase);
    event DutyPaid(uint256 indexed id, address indexed payer, uint256 amount);
    event LCRefunded(uint256 indexed id, address indexed importer, uint256 lcRefund, uint256 dutyRefund);
    event TreasuryUpdated(address indexed treasury);

    modifier onlyCore() {
        if (msg.sender != core) revert OnlyCore();
        _;
    }

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
    }

    // ---------------------------------------------------------------------
    // Core-only mutators
    // ---------------------------------------------------------------------

    /// @notice Records the L/C funding. The tokens are transferred to this contract by the core.
    function fund(uint256 id, address payer, uint256 amount) external onlyCore {
        LC storage lc = _lcs[id];
        if (lc.funded) revert AlreadyFunded(id);
        if (amount == 0) revert InvalidAmount();

        lc.shipmentId = id;
        lc.amount = amount;
        lc.funded = true;

        emit LCFunded(id, payer, amount);
    }

    /// @notice Records a customs-duty escrow (zero is allowed for duty-free destinations).
    function payDuty(uint256 id, address payer, uint256 amount) external onlyCore {
        LC storage lc = _lcs[id];
        if (!lc.funded) revert NotFunded(id);
        if (lc.dutyPaid) revert DutyAlreadyPaid(id);

        lc.dutyPaid = true;
        lc.dutyAmount = amount;
        lc.dutyPayer = payer;

        emit DutyPaid(id, payer, amount);
    }

    /// @notice Releases the escrow to the exporter at the Incoterm risk-transfer milestone.
    function settle(uint256 id, address exporter) external onlyCore nonReentrant {
        LC storage lc = _lcs[id];
        if (!lc.funded) revert NotFunded(id);
        if (lc.paid || lc.reclaimed) revert AlreadySettled(id);

        TradeTypes.Shipment memory s = tracker.getShipment(id);
        TradeTypes.Phase due = compliance.payoutPhase(s.term);
        if (s.phase != due) revert NotPayoutPhase(id, due, s.phase);
        compliance.requireCompliant(id, s.term, due);
        if (s.term == TradeTypes.Incoterm.DDP && !lc.dutyPaid) revert DutyNotPaid(id);

        // --- Effects before interaction ---
        lc.paid = true;
        uint256 amount = lc.amount;
        uint256 duty = lc.dutyAmount;

        emit LCSettled(id, exporter, amount, due);

        // --- Interactions ---
        token.safeTransfer(exporter, amount);
        if (duty > 0) token.safeTransfer(treasury, duty);
    }

    /// @notice Returns the escrow to the importer if the exporter never shipped before the deadline.
    function refund(uint256 id) external onlyCore nonReentrant {
        LC storage lc = _lcs[id];
        if (!lc.funded) revert NotFunded(id);
        if (lc.paid || lc.reclaimed) revert AlreadySettled(id);

        TradeTypes.Shipment memory s = tracker.getShipment(id);
        if (block.timestamp <= s.deadline) revert DeadlineNotReached(s.deadline);
        if (s.phase != TradeTypes.Phase.LCFunded) revert NothingToReclaim(id);

        lc.reclaimed = true;
        uint256 lcRefund = lc.amount;
        uint256 dutyRefund = lc.dutyPaid ? lc.dutyAmount : 0;
        address importer = s.importer;
        address dutyPayer = lc.dutyPayer;

        emit LCRefunded(id, importer, lcRefund, dutyRefund);

        token.safeTransfer(importer, lcRefund);
        if (dutyRefund > 0) token.safeTransfer(dutyPayer, dutyRefund);
    }

    /// @notice Updates the duty treasury (customs-authority stand-in).
    function setTreasury(address treasury_) external onlyCore {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getLC(uint256 id) external view returns (LC memory) {
        return _lcs[id];
    }

    function isPaid(uint256 id) external view returns (bool) {
        return _lcs[id].paid;
    }

    function escrowBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
