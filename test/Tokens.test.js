const { expect } = require("chai");
const { ethers } = require("hardhat");
const { Incoterm, PaymentTerm, Phase, futureDeadline } = require("./helpers/fixture");

describe("Token units", function () {
  let admin, other, outsider;

  before(async function () {
    [admin, other, outsider] = await ethers.getSigners();
  });

  describe("TradeUSD", function () {
    async function deploy() {
      const USD = await ethers.getContractFactory("TradeUSD");
      const usd = await USD.deploy(admin.address, "TradeChain USD", "tUSD", 6);
      await usd.waitForDeployment();
      return usd;
    }

    it("has correct metadata and a gated mint", async function () {
      const usd = await deploy();
      expect(await usd.name()).to.equal("TradeChain USD");
      expect(await usd.symbol()).to.equal("tUSD");
      expect(await usd.decimals()).to.equal(6);

      await usd.mint(other.address, 123n);
      expect(await usd.balanceOf(other.address)).to.equal(123n);
      expect(await usd.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
      expect(await usd.supportsInterface("0xffffffff")).to.equal(false);

      await expect(usd.connect(outsider).mint(outsider.address, 1n)).to.be.revertedWithCustomError(
        usd,
        "AccessControlUnauthorizedAccount"
      );
      await expect(usd.mint(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(usd, "ZeroAddress");
    });

    it("rejects a zero admin", async function () {
      const USD = await ethers.getContractFactory("TradeUSD");
      await expect(USD.deploy(ethers.ZeroAddress, "x", "x", 6)).to.be.revertedWithCustomError(USD, "ZeroAddress");
    });
  });

  describe("TradeChainCore.mint", function () {
    it("reverts when the injected settlement token does not grant the core mint rights", async function () {
      const USD = await ethers.getContractFactory("TradeUSD");
      const usd = await USD.deploy(admin.address, "External USD", "xUSD", 6);
      await usd.waitForDeployment();

      const Core = await ethers.getContractFactory("TradeChainCore");
      const core = await Core.deploy(await usd.getAddress());
      await core.waitForDeployment();

      await expect(core.mint(other.address, 1n)).to.be.revertedWithCustomError(core, "NotTokenAdmin");
    });
  });

  describe("ShipmentTracker — e-B/L title token (ERC-721)", function () {
    // `admin` acts as the core: it deploys the tracker and is the only account allowed to mutate.
    async function deploy() {
      const T = await ethers.getContractFactory("ShipmentTracker");
      const tracker = await T.deploy(admin.address);
      await tracker.waitForDeployment();
      return tracker;
    }

    async function withShipment(tracker) {
      await tracker.createOrder(
        other.address,
        outsider.address,
        Incoterm.FOB,
        PaymentTerm.Sight,
        0n,
        100n,
        await futureDeadline()
      );
      await tracker.setPhase(1n, Phase.LCIssued);
      await tracker.ship(1n, outsider.address);
    }

    it("mints, updates the URI and transfers the title (core only)", async function () {
      const tracker = await deploy();
      await withShipment(tracker);

      await tracker.mint(admin.address, 1n, "ipfs://bl");
      expect(await tracker.ownerOf(1n)).to.equal(admin.address);
      expect(await tracker.tokenURI(1n)).to.equal("ipfs://bl");
      expect(await tracker.exists(1n)).to.equal(true);

      await tracker.setTokenURI(1n, "ipfs://bl2");
      expect(await tracker.tokenURI(1n)).to.equal("ipfs://bl2");

      await tracker.transferTitle(1n, other.address);
      expect(await tracker.ownerOf(1n)).to.equal(other.address);

      await expect(tracker.connect(outsider).mint(outsider.address, 2n, "x")).to.be.revertedWithCustomError(
        tracker,
        "OnlyCore"
      );
      await expect(tracker.connect(outsider).transferTitle(1n, outsider.address)).to.be.revertedWithCustomError(
        tracker,
        "OnlyCore"
      );
    });

    it("blocks every public transfer of the document of title", async function () {
      const tracker = await deploy();
      await withShipment(tracker);
      await tracker.mint(admin.address, 1n, "ipfs://bl");

      await expect(
        tracker.connect(admin).transferFrom(admin.address, other.address, 1n)
      ).to.be.revertedWithCustomError(tracker, "TransferRestricted");
      await expect(
        tracker.connect(admin)["safeTransferFrom(address,address,uint256)"](admin.address, other.address, 1n)
      ).to.be.revertedWithCustomError(tracker, "TransferRestricted");
    });

    it("requires the shipment to exist before minting the title", async function () {
      const tracker = await deploy();
      await expect(tracker.mint(admin.address, 42n, "ipfs://bl")).to.be.revertedWithCustomError(
        tracker,
        "ShipmentNotFound"
      );
    });

    it("reverts URI/title operations on non-existent tokens", async function () {
      const tracker = await deploy();
      await expect(tracker.setTokenURI(42n, "x")).to.be.revertedWithCustomError(tracker, "TokenDoesNotExist");
      await expect(tracker.transferTitle(42n, other.address)).to.be.revertedWithCustomError(
        tracker,
        "TokenDoesNotExist"
      );
    });

    it("advertises the ERC-721 and AccessControl interfaces", async function () {
      const tracker = await deploy();
      expect(await tracker.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC-165
      expect(await tracker.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
      expect(await tracker.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
      expect(await tracker.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
