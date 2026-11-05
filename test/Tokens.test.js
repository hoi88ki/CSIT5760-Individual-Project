const { expect } = require("chai");
const { ethers } = require("hardhat");

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

  describe("ShipmentNFT", function () {
    async function deploy() {
      const NFT = await ethers.getContractFactory("ShipmentNFT");
      const nft = await NFT.deploy(admin.address);
      await nft.waitForDeployment();
      return nft;
    }

    it("mints, updates the URI and transfers the title (controller only)", async function () {
      const nft = await deploy();
      await nft.mint(admin.address, 1n, "ipfs://bl");
      expect(await nft.ownerOf(1n)).to.equal(admin.address);
      expect(await nft.tokenURI(1n)).to.equal("ipfs://bl");
      expect(await nft.exists(1n)).to.equal(true);

      await nft.setTokenURI(1n, "ipfs://bl2");
      expect(await nft.tokenURI(1n)).to.equal("ipfs://bl2");

      await nft.transferTitle(1n, other.address);
      expect(await nft.ownerOf(1n)).to.equal(other.address);

      await expect(nft.connect(outsider).mint(outsider.address, 2n, "x")).to.be.revertedWithCustomError(
        nft,
        "AccessControlUnauthorizedAccount"
      );
      await expect(nft.connect(outsider).transferTitle(1n, outsider.address)).to.be.revertedWithCustomError(
        nft,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts URI/title operations on non-existent tokens", async function () {
      const nft = await deploy();
      await expect(nft.setTokenURI(42n, "x")).to.be.revertedWithCustomError(nft, "TokenDoesNotExist");
      await expect(nft.transferTitle(42n, other.address)).to.be.revertedWithCustomError(nft, "TokenDoesNotExist");
    });

    it("advertises the ERC-721 and AccessControl interfaces", async function () {
      const nft = await deploy();
      expect(await nft.supportsInterface("0x01ffc9a7")).to.equal(true); // ERC-165
      expect(await nft.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
      expect(await nft.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
      expect(await nft.supportsInterface("0xffffffff")).to.equal(false);
    });
  });
});
