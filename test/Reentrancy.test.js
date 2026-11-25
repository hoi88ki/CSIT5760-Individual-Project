const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  Incoterm,
  PaymentTerm,
  CID,
  LC,
  UNIT,
  deployTradeChain,
  futureDeadline,
  toPresentable,
  present,
} = require("./helpers/fixture");

describe("Reentrancy protection", function () {
  it("blocks a re-entrant settlement token and still pays out exactly once", async function () {
    const Evil = await ethers.getContractFactory("MaliciousReentrancy");
    const evil = await Evil.deploy();
    await evil.waitForDeployment();

    // Inject the adversarial token as the settlement asset. The fixture mints/approves through
    // core.mint (the token exposes a compatible `mint(address,uint256)`), so the bank is funded.
    const env = await deployTradeChain({ settlementToken: await evil.getAddress() });

    // A sight credit pays during honorPresentation, so a single transfer leaves the escrow.
    await env.core
      .connect(env.importer)
      .createOrder(env.exporter.address, Incoterm.EXW, LC, await futureDeadline(), PaymentTerm.Sight, 0n);
    await env.core.connect(env.bank).issueLetterOfCredit(1n);
    await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);
    await toPresentable(env, 1n);
    await present(env, 1n);

    // Arm the token to re-enter honorPresentation() during the payout.
    const payload = env.core.interface.encodeFunctionData("honorPresentation", [1n]);
    await evil.arm(await env.core.getAddress(), payload);

    const before = await evil.balanceOf(env.exporter.address);
    await env.core.connect(env.bank).honorPresentation(1n);

    // Exactly one payout; the re-entrant call was rejected.
    expect(await evil.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect((await env.core.getLC(1n)).paid).to.equal(true);
    expect(await evil.reentryCount()).to.equal(1n);
    expect(await evil.lastRevert()).to.not.equal("0x");
  });

  it("blocks a re-entrant draw of deferred proceeds", async function () {
    const Evil = await ethers.getContractFactory("MaliciousReentrancy");
    const evil = await Evil.deploy();
    await evil.waitForDeployment();

    const env = await deployTradeChain({ settlementToken: await evil.getAddress() });
    const { time } = require("@nomicfoundation/hardhat-network-helpers");

    await env.core
      .connect(env.importer)
      .createOrder(
        env.exporter.address,
        Incoterm.FOB,
        LC,
        await futureDeadline(),
        PaymentTerm.Deferred,
        1n
      );
    await env.core.connect(env.bank).issueLetterOfCredit(1n);
    await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);
    await toPresentable(env, 1n);
    await present(env, 1n);
    await env.core.connect(env.bank).honorPresentation(1n); // schedules maturity

    // Arm the token to re-enter drawDeferredPayment() during the maturity payout.
    const payload = env.core.interface.encodeFunctionData("drawDeferredPayment", [1n]);
    await evil.arm(await env.core.getAddress(), payload);

    await time.increaseTo(Number((await env.core.getLC(1n)).maturityAt) + 1);
    const before = await evil.balanceOf(env.exporter.address);
    await env.core.connect(env.bank).drawDeferredPayment(1n);

    expect(await evil.balanceOf(env.exporter.address)).to.equal(before + LC);
    expect(await evil.reentryCount()).to.equal(1n);
    expect(await evil.lastRevert()).to.not.equal("0x");
  });
});
