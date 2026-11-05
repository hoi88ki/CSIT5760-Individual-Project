// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MaliciousReentrancy — adversarial settlement token
/// @notice A valid ERC-20 that, on the first transfer after `arm`, re-enters a target with an
///         arbitrary payload. Used to prove the core's checks-effects-interactions ordering and
///         the `nonReentrant` guard on `LetterOfCredit` prevent a double payout.
/// @dev    Test-only. Excluded from coverage via `.solcover.js`.
contract MaliciousReentrancy is ERC20 {
    address public victim;
    bytes public payload;
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

    /// @notice Arms the attack: re-enter `victim_` with `payload_` on the next transfer.
    function arm(address victim_, bytes calldata payload_) external {
        victim = victim_;
        payload = payload_;
        armed = true;
        attacked = false;
        reentryCount = 0;
        lastRevert = "";
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (armed && !attacked && victim != address(0)) {
            attacked = true;
            reentryCount += 1;
            (bool ok, bytes memory data) = victim.call(payload);
            if (!ok) lastRevert = data;
        }
    }
}
