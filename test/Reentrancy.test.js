const { expect } = require("chai");
const { ethers } = require("hardhat");
const { Incoterm, CID, LC, UNIT, deployTradeChain, createOrderAndShipment, fundLC } = require("./helpers/fixture");

describe("Reentrancy protection", function () {
  it("blocks a re-entrant settlement token and still pays out exactly once", async function () {
    const Evil = await ethers.getContractFactory("MaliciousReentrancy");
    const evil = await Evil.deploy();
    await evil.waitForDeployment();

    // Inject the adversarial token as the settlement asset. The fixture mints/approves through
    // core.mint (the token exposes a compatible `mint(address,uint256)`), so the buyer is funded.
    const env = await deployTradeChain({ settlementToken: await evil.getAddress() });

    // EXW pays out at pickup, so a single transfer leaves the escrow.
    const { shipmentId } = await createOrderAndShipment(env, { term: Incoterm.EXW });
    await fundLC(env, shipmentId);

    // Arm the token to re-enter confirmPickup() during the payout.
    const payload = env.core.interface.encodeFunctionData("confirmPickup", [shipmentId]);
    await evil.arm(await env.core.getAddress(), payload);

    const before = await evil.balanceOf(env.exporter.address);
    await env.core.connect(env.logistics).confirmPickup(shipmentId);

    // Exactly one payout; the re-entrant call was rejected.
    expect(await evil.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect((await env.core.getLC(shipmentId)).paid).to.equal(true);
    expect(await evil.reentryCount()).to.equal(1n);
    expect(await evil.lastRevert()).to.not.equal("0x");
  });
});
