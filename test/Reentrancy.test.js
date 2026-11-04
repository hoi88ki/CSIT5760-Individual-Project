const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { Incoterm, CID } = require("./helpers/fixture");

describe("Reentrancy protection", function () {
  it("blocks a reentrant settlement token and still pays out exactly once", async function () {
    const [admin, seller, buyer, carrier] = await ethers.getSigners();

    const Evil = await ethers.getContractFactory("MaliciousReentrancy");
    const evil = await Evil.deploy();
    await evil.waitForDeployment();

    const Core = await ethers.getContractFactory("TradeChainCore");
    const core = await Core.deploy(await evil.getAddress());
    await core.waitForDeployment();

    await core
      .connect(admin)
      .grantRoles(
        [await core.ROLE_SELLER(), await core.ROLE_BUYER(), await core.ROLE_CARRIER()],
        [seller.address, buyer.address, carrier.address]
      );

    const UNIT = 10n ** 6n;
    const LC = 1_000n * UNIT;
    await evil.mint(buyer.address, 1_000_000n * UNIT);
    await evil.connect(buyer).approve(await core.getAddress(), ethers.MaxUint256);

    const deadline = BigInt(await time.latest()) + 86_400n;
    await core.connect(buyer).createOrder(seller.address, Incoterm.EXW, LC, deadline);
    await core.connect(seller).createShipment(1n, CID.invoice, CID.packing);
    await core.connect(buyer).openLetterOfCredit(1n);

    // Arm the adversarial token to re-enter on the next transfer out of the core.
    await evil.arm(await core.getAddress(), 1n);

    const before = await evil.balanceOf(seller.address);
    await core.connect(carrier).confirmPickup(1n); // EXW payout

    // Exactly one payout, no double spend.
    expect(await evil.balanceOf(seller.address)).to.equal(before + LC);
    expect((await core.getShipment(1n)).lcPaid).to.equal(true);

    // The token tried to re-enter once and was stopped by the reentrancy guard.
    expect(await evil.reentryCount()).to.equal(1n);
    const guardSelector = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
    expect(await evil.lastRevert()).to.equal(guardSelector);
  });
});
