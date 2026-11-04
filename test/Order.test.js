const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  DocType,
  CID,
  LC,
  UNIT,
  deployTradeChain,
  futureDeadline,
} = require("./helpers/fixture");

describe("Orders, shipment creation & L/C funding", function () {
  const fixture = deployTradeChain;

  describe("createOrder", function () {
    it("lets a buyer open an order naming an exporter", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();

      await expect(env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, deadline))
        .to.emit(env.core, "OrderCreated")
        .withArgs(1n, env.buyer.address, env.seller.address, Incoterm.FOB, LC, deadline);

      expect(await env.core.orderCount()).to.equal(1n);
      const order = await env.core.getOrder(1n);
      expect(order.buyer).to.equal(env.buyer.address);
      expect(order.seller).to.equal(env.seller.address);
      expect(order.term).to.equal(Incoterm.FOB);
      expect(order.lcAmount).to.equal(LC);
      expect(order.deadline).to.equal(deadline);
      expect(order.fulfilled).to.equal(false);
      expect(order.shipmentId).to.equal(0n);
    });

    it("rejects non-buyer callers", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.seller).createOrder(env.seller.address, Incoterm.FOB, LC, await futureDeadline())
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("rejects zero seller, zero amount and non-future deadlines", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.buyer).createOrder(ethers.ZeroAddress, Incoterm.FOB, LC, await futureDeadline())
      ).to.be.revertedWithCustomError(env.core, "ZeroAddress");

      await expect(
        env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, 0, await futureDeadline())
      ).to.be.revertedWithCustomError(env.core, "InvalidAmount");

      const past = BigInt(await time.latest()) - 1n;
      await expect(
        env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, past)
      ).to.be.revertedWithCustomError(env.core, "InvalidDeadline");
    });
  });

  describe("createShipment", function () {
    it("only the named seller may accept the order", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();
      await env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, deadline);

      // Give `outsider` a seller role but it is not the ordered seller.
      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_SELLER()], [env.outsider.address]);
      await expect(
        env.core.connect(env.outsider).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "NotOrderedSeller");
    });

    it("creates the shipment, anchors invoice + packing list and escrows the eB/L on the core", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();
      await env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, deadline);

      await expect(env.core.connect(env.seller).createShipment(1n, CID.invoice, CID.packing))
        .to.emit(env.core, "ShipmentCreated")
        .withArgs(1n, 1n, env.seller.address, env.buyer.address, Incoterm.FOB, LC, deadline)
        .and.to.emit(env.core, "DocumentAnchored")
        .withArgs(1n, DocType.CommercialInvoice, env.seller.address, CID.invoice, 0n);

      const shipment = await env.core.getShipment(1n);
      expect(shipment.phase).to.equal(0); // Created
      expect(shipment.buyer).to.equal(env.buyer.address);
      expect(shipment.seller).to.equal(env.seller.address);
      expect(shipment.riskHolder).to.equal(env.seller.address);

      expect(await env.core.hasValidDocument(1n, DocType.CommercialInvoice)).to.equal(true);
      expect(await env.core.hasValidDocument(1n, DocType.PackingList)).to.equal(true);

      // eB/L minted to the core (escrow).
      expect(await env.ebl.ownerOf(1n)).to.equal(await env.core.getAddress());
      expect(await env.ebl.nextTokenId()).to.equal(2n);

      const order = await env.core.getOrder(1n);
      expect(order.fulfilled).to.equal(true);
      expect(order.shipmentId).to.equal(1n);
    });

    it("rejects an empty invoice CID and a fulfilled order", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, await futureDeadline());
      await expect(env.core.connect(env.seller).createShipment(1n, "", CID.packing)).to.be.revertedWithCustomError(
        env.core,
        "EmptyCID"
      );

      await env.core.connect(env.seller).createShipment(1n, CID.invoice, CID.packing);
      await expect(
        env.core.connect(env.seller).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "OrderAlreadyFulfilled");
    });

    it("rejects an unknown order", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.seller).createShipment(999n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.core, "OrderNotFound");
    });
  });

  describe("openLetterOfCredit", function () {
    it("escrows the exact L/C amount from the buyer", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();
      await env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, deadline);
      await env.core.connect(env.seller).createShipment(1n, CID.invoice, CID.packing);

      const coreAddr = await env.core.getAddress();
      const before = await env.token.balanceOf(coreAddr);

      await expect(env.core.connect(env.buyer).openLetterOfCredit(1n))
        .to.emit(env.core, "LetterOfCreditOpened")
        .withArgs(1n, env.buyer.address, LC);

      expect(await env.token.balanceOf(coreAddr)).to.equal(before + LC);
      const s = await env.core.getShipment(1n);
      expect(s.phase).to.equal(1); // LCFunded
      expect(s.lcFunded).to.equal(true);
    });

    it("reverts when the buyer has not approved the core", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, await futureDeadline());
      await env.core.connect(env.seller).createShipment(1n, CID.invoice, CID.packing);

      // The order's buyer revokes its allowance → the escrow transfer must fail.
      await env.token.connect(env.buyer).approve(await env.core.getAddress(), 0);
      await expect(
        env.core.connect(env.buyer).openLetterOfCredit(1n)
      ).to.be.revertedWithCustomError(env.token, "ERC20InsufficientAllowance");
    });

    it("reverts if the funding account is not the order's buyer", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.buyer).createOrder(env.seller.address, Incoterm.FOB, LC, await futureDeadline());
      await env.core.connect(env.seller).createShipment(1n, CID.invoice, CID.packing);

      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_BUYER()], [env.outsider.address]);
      await expect(
        env.core.connect(env.outsider).openLetterOfCredit(1n)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");
    });
  });
});
