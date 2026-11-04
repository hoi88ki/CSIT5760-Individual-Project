// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title TradeCertNFT — verifiable trade certificate token
/// @notice Standalone ERC-721 owned by TradeChainCore. Minted only inside the authorised
///         `anchorDocument()` / `confirmVesselLoading()` paths, it turns an off-chain attestation
///         into a verifiable token checked at payout. Revocation is implemented as a burn.
contract TradeCertNFT is ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 private _nextId;

    error TokenDoesNotExist(uint256 tokenId);

    /// @param admin The core contract, granted DEFAULT_ADMIN_ROLE and MINTER_ROLE.
    constructor(address admin) ERC721("TradeChain Certificate", "TCERT") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mints a certificate token to its issuer truncated to `uri` metadata.
    function mint(address to, string calldata uri) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = ++_nextId;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Revokes a certificate by burning it (document becomes invalid at payout).
    function revoke(uint256 tokenId) external onlyRole(MINTER_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist(tokenId);
        _burn(tokenId);
    }

    /// @notice True when the certificate still exists (unrevoked).
    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    /// @notice The next token id to be minted.
    function nextTokenId() external view returns (uint256) {
        return _nextId;
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721URIStorage, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
