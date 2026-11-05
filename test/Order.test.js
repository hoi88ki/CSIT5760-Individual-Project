const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  Incoterm,
  Phase,
  DocType,
  CID,
  LC,
  deployTradeChain,
  futureDeadline,
} = require("./helpers/fixture");

describe("Orders, shipment creation & L/C funding", function () {
  const fixture = deployTradeChain;

  describe("createOrder", function () {
    it("lets an importer open an order naming an exporter", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();

      await expect(env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, deadline))
        .to.emit(env.core, "OrderCreated")
        .withArgs(1n, env.importer.address, env.exporter.address, Incoterm.FOB, LC, deadline);

      expect(await env.core.orderCount()).to.equal(1n);
      const order = await env.core.getOrder(1n);
      expect(order.importer).to.equal(env.importer.address);
      expect(order.exporter).to.equal(env.exporter.address);
      expect(order.term).to.equal(Incoterm.FOB);
      expect(order.lcAmount).to.equal(LC);
      expect(order.deadline).to.equal(deadline);
      expect(order.fulfilled).to.equal(false);
      expect(order.shipmentId).to.equal(0n);
    });

    it("rejects non-importer callers", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.exporter).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline())
      ).to.be.revertedWithCustomError(env.core, "AccessControlUnauthorizedAccount");
    });

    it("rejects zero exporter, zero amount and non-future deadlines", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.importer).createOrder(ethers.ZeroAddress, Incoterm.FOB, LC, await futureDeadline())
      ).to.be.revertedWithCustomError(env.tracker, "ZeroAddress");

      await expect(
        env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, 0, await futureDeadline())
      ).to.be.revertedWithCustomError(env.tracker, "InvalidAmount");

      const past = BigInt(await time.latest()) - 1n;
      await expect(
        env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, past)
      ).to.be.revertedWithCustomError(env.tracker, "InvalidDeadline");
    });
  });

  describe("createShipment", function () {
    it("only the named exporter may accept the order", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline());

      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_EXPORTER()], [env.outsider.address]);
      await expect(
        env.core.connect(env.outsider).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.tracker, "NotOrderedExporter");
    });

    it("creates the shipment, anchors invoice + packing list and escrows the title NFT", async function () {
      const env = await loadFixture(fixture);
      const deadline = await futureDeadline();
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, deadline);

      await expect(env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing))
        .to.emit(env.core, "ShipmentCreated")
        .withArgs(1n, 1n, env.exporter.address, env.importer.address, Incoterm.FOB, LC, deadline)
        .and.to.emit(env.registry, "DocumentAnchored");

      const shipment = await env.core.getShipment(1n);
      expect(shipment.phase).to.equal(Phase.Created);
      expect(shipment.importer).to.equal(env.importer.address);
      expect(shipment.exporter).to.equal(env.exporter.address);
      expect(shipment.riskHolder).to.equal(env.exporter.address);

      expect(await env.core.hasValidDocument(1n, DocType.CommercialInvoice)).to.equal(true);
      expect(await env.core.hasValidDocument(1n, DocType.PackingList)).to.equal(true);

      // Title NFT minted to the core (escrow).
      expect(await env.nft.ownerOf(1n)).to.equal(await env.core.getAddress());

      const order = await env.core.getOrder(1n);
      expect(order.fulfilled).to.equal(true);
      expect(order.shipmentId).to.equal(1n);
    });

    it("rejects an empty invoice CID and a fulfilled order", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline());
      await expect(
        env.core.connect(env.exporter).createShipment(1n, "", CID.packing)
      ).to.be.revertedWithCustomError(env.registry, "EmptyCID");

      await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);
      await expect(
        env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.tracker, "OrderAlreadyFulfilled");
    });

    it("rejects an unknown order", async function () {
      const env = await loadFixture(fixture);
      await expect(
        env.core.connect(env.exporter).createShipment(999n, CID.invoice, CID.packing)
      ).to.be.revertedWithCustomError(env.tracker, "OrderNotFound");
    });
  });

  describe("openLetterOfCredit", function () {
    it("escrows the exact L/C amount into the LetterOfCredit", async function () {
      const env = await loadFixture(fixture);
      const { shipmentId } = await (async () => {
        await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline());
        await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);
        return { shipmentId: 1n };
      })();

      const locAddr = await env.loc.getAddress();
      const before = await env.token.balanceOf(locAddr);

      await expect(env.core.connect(env.importer).openLetterOfCredit(shipmentId))
        .to.emit(env.core, "LetterOfCreditOpened")
        .withArgs(shipmentId, env.importer.address, LC);

      expect(await env.token.balanceOf(locAddr)).to.equal(before + LC);
      const s = await env.core.getShipment(shipmentId);
      expect(s.phase).to.equal(Phase.LCFunded);
      expect((await env.loc.getLC(shipmentId)).funded).to.equal(true);
    });

    it("reverts when the importer has not approved the core", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline());
      await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);

      await env.token.connect(env.importer).approve(await env.core.getAddress(), 0);
      await expect(
        env.core.connect(env.importer).openLetterOfCredit(1n)
      ).to.be.revertedWithCustomError(env.token, "ERC20InsufficientAllowance");
    });

    it("reverts if the funding account is not the order's importer", async function () {
      const env = await loadFixture(fixture);
      await env.core.connect(env.importer).createOrder(env.exporter.address, Incoterm.FOB, LC, await futureDeadline());
      await env.core.connect(env.exporter).createShipment(1n, CID.invoice, CID.packing);

      await env.core.connect(env.admin).grantRoles([await env.core.ROLE_IMPORTER()], [env.outsider.address]);
      await expect(
        env.core.connect(env.outsider).openLetterOfCredit(1n)
      ).to.be.revertedWithCustomError(env.core, "Unauthorized");
    });
  });
});
