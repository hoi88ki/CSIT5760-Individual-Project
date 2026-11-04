const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Token units", function () {
  let admin, other, outsider;

  before(async function () {
    [admin, other, outsider] = await ethers.getSigners();
  });

  describe("EBLToken", function () {
    async function deploy() {
      const EBL = await ethers.getContractFactory("EBLToken");
      const ebl = await EBL.deploy(admin.address);
      await ebl.waitForDeployment();
      return ebl;
    }

    it("has correct metadata and an empty supply", async function () {
      const ebl = await deploy();
      expect(await ebl.name()).to.equal("TradeChain Electronic Bill of Lading");
      expect(await ebl.symbol()).to.equal("TC-EBL");
      expect(await ebl.nextTokenId()).to.equal(1n);
    });

    it("mints, updates the URI and transfers title (admin/minter only)", async function () {
      const ebl = await deploy();
      await ebl.mint(admin.address, "ipfs://invoice");
      expect(await ebl.ownerOf(1n)).to.equal(admin.address);
      expect(await ebl.tokenURI(1n)).to.equal("ipfs://invoice");
      expect(await ebl.exists(1n)).to.equal(true);

      await ebl.setTokenURI(1n, "ipfs://bl");
      expect(await ebl.tokenURI(1n)).to.equal("ipfs://bl");

      await ebl.transferTitle(1n, other.address);
      expect(await ebl.ownerOf(1n)).to.equal(other.address);

      await expect(ebl.connect(outsider).mint(outsider.address, "x")).to.be.revertedWithCustomError(
        ebl,
        "AccessControlUnauthorizedAccount"
      );
      await expect(ebl.connect(outsider).transferTitle(1n, outsider.address)).to.be.revertedWithCustomError(
        ebl,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("reverts URI/title operations on non-existent tokens", async function () {
      const ebl = await deploy();
      await expect(ebl.setTokenURI(42n, "x")).to.be.revertedWithCustomError(ebl, "TokenDoesNotExist");
      await expect(ebl.transferTitle(42n, other.address)).to.be.revertedWithCustomError(ebl, "TokenDoesNotExist");
    });
  });

  describe("TradeCertNFT", function () {
    async function deploy() {
      const Cert = await ethers.getContractFactory("TradeCertNFT");
      const cert = await Cert.deploy(admin.address);
      await cert.waitForDeployment();
      return cert;
    }

    it("mints a certificate and burns it on revocation", async function () {
      const cert = await deploy();
      await cert.mint(admin.address, "ipfs://cert");
      expect(await cert.ownerOf(1n)).to.equal(admin.address);
      expect(await cert.tokenURI(1n)).to.equal("ipfs://cert");
      expect(await cert.exists(1n)).to.equal(true);

      await cert.revoke(1n);
      expect(await cert.exists(1n)).to.equal(false);
    });

    it("restricts mint/revoke and rejects revoking a missing token", async function () {
      const cert = await deploy();
      await expect(cert.connect(outsider).mint(outsider.address, "x")).to.be.revertedWithCustomError(
        cert,
        "AccessControlUnauthorizedAccount"
      );
      await expect(cert.revoke(7n)).to.be.revertedWithCustomError(cert, "TokenDoesNotExist");
    });
  });
});
