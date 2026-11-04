const { expect } = require("chai");
const { ethers } = require("hardhat");
const { Incoterm, DocType, CID, LC, UNIT, futureDeadline } = require("./helpers/fixture");

// The defensive guards inside `_triggerAtomicPayout` cannot be reached through the
// state-guarded public API, so they are exercised directly through a test harness
// (which is itself excluded from coverage; the covered code lives in SettlementModule).
describe("Settlement engine guards (harness)", function () {
  async function deployHarness() {
    const [admin, seller, buyer, carrier, , , verifier] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("TradeChain USD", "tUSD", 6);
    await token.waitForDeployment();

    const Harness = await ethers.getContractFactory("TradeChainHarness");
    const h = await Harness.deploy(await token.getAddress());
    await h.waitForDeployment();

    await h
      .connect(admin)
      .grantRoles(
        [await h.ROLE_SELLER(), await h.ROLE_BUYER(), await h.ROLE_CARRIER(), await h.ROLE_VERIFIER()],
        [seller.address, buyer.address, carrier.address, verifier.address]
      );

    await token.mint(buyer.address, 1_000_000n * UNIT);
    await token.mint(seller.address, 1_000_000n * UNIT);
    await token.connect(buyer).approve(await h.getAddress(), ethers.MaxUint256);
    await token.connect(seller).approve(await h.getAddress(), ethers.MaxUint256);

    return { h, token, admin, seller, buyer, carrier, verifier };
  }

  it("reverts payout when the L/C is not funded, then when the phase is not due", async function () {
    const { h, buyer, seller } = await deployHarness();
    const deadline = await futureDeadline();

    await h.connect(buyer).createOrder(seller.address, Incoterm.FOB, LC, deadline);
    await h.connect(seller).createShipment(1n, CID.invoice, CID.packing);

    // Not funded.
    await expect(h.exposedTriggerAtomicPayout(1n)).to.be.revertedWithCustomError(h, "InvalidState");

    await h.connect(buyer).openLetterOfCredit(1n);
    // Funded, but FOB pays at LoadedOnVessel while the phase is still LCFunded.
    await expect(h.exposedTriggerAtomicPayout(1n)).to.be.revertedWithCustomError(h, "SettlementNotDue");
  });

  it("rejects a second payout (EXW remains at PickedUp after settling)", async function () {
    const { h, buyer, seller, carrier } = await deployHarness();
    const deadline = await futureDeadline();

    await h.connect(buyer).createOrder(seller.address, Incoterm.EXW, LC, deadline);
    await h.connect(seller).createShipment(1n, CID.invoice, CID.packing);
    await h.connect(buyer).openLetterOfCredit(1n);
    await h.connect(carrier).confirmPickup(1n); // EXW pays out here

    await expect(h.exposedTriggerAtomicPayout(1n)).to.be.revertedWithCustomError(h, "SettlementAlreadyExecuted");
  });

  it("exposes the doc-type role/verifier helpers", async function () {
    const { h } = await deployHarness();
    expect(await h.exposedRoleForDocType(DocType.CertificateOfOrigin)).to.equal(await h.ROLE_SELLER());
    expect(await h.exposedRoleForDocType(DocType.InspectionCertificate)).to.equal(await h.ROLE_VERIFIER());
    expect(await h.exposedRoleForDocType(DocType.CustomsClearance)).to.equal(await h.ROLE_VERIFIER());

    expect(await h.exposedIsVerifierDocType(DocType.InspectionCertificate)).to.equal(true);
    expect(await h.exposedIsVerifierDocType(DocType.InsuranceCertificate)).to.equal(true);
    expect(await h.exposedIsVerifierDocType(DocType.CustomsClearance)).to.equal(true);
    expect(await h.exposedIsVerifierDocType(DocType.CommercialInvoice)).to.equal(false);
    expect(await h.exposedIsVerifierDocType(DocType.CertificateOfOrigin)).to.equal(false);
  });
});
