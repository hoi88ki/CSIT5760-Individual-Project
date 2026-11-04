// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MaliciousReentrancy — adversarial settlement token
/// @notice A valid ERC-20 that, when the core pays out, re-enters `reclaimExpiredLC` in an attempt
///         to move funds twice. Used to prove the `nonReentrant` guard + CEI protection.
/// @dev    Test-only. Excluded from coverage via `.solcover.js`.
contract MaliciousReentrancy is ERC20 {
    address public core;
    uint256 public attackId;
    bool public armed;
    bool public attacked;
    uint256 public reentryCount;
    bytes public lastRevert;

    constructor() ERC20("Malicious Settlement", "EVIL") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the attack: re-enter on the next transfer *out of* the core.
    function arm(address core_, uint256 id) external {
        core = core_;
        attackId = id;
        armed = true;
        attacked = false;
        reentryCount = 0;
        lastRevert = "";
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (armed && !attacked && core != address(0) && from == core) {
            attacked = true;
            reentryCount += 1;
            (bool ok, bytes memory data) = core.call(abi.encodeWithSignature("reclaimExpiredLC(uint256)", attackId));
            if (!ok) lastRevert = data;
        }
    }
}
