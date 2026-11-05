// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ShipmentNFT — ERC-721 document-of-title / shipment-ownership token
/// @notice One token per shipment (id == shipment id). Minted to, and escrowed by, the
///         `TradeChainCore` until the settlement milestone, then transferred to the importer.
///         Transfer is **milestone-gated**: only the core (`CONTROLLER_ROLE`) can mint or move it,
///         and the core only does so at the Incoterm-appropriate point.
/// @dev    The B/L (or AWB) CID is attached as the token URI at `confirmVesselLoading`.
contract ShipmentNFT is ERC721URIStorage, AccessControl {
    bytes32 public constant CONTROLLER_ROLE = keccak256("CONTROLLER_ROLE");

    error TokenDoesNotExist(uint256 tokenId);

    /// @param admin The TradeChainCore (granted DEFAULT_ADMIN_ROLE and CONTROLLER_ROLE).
    constructor(address admin) ERC721("TradeChain Shipment Title", "TC-SHP") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONTROLLER_ROLE, admin);
    }

    /// @notice Mints the title token for a shipment (id == tokenId).
    function mint(address to, uint256 tokenId, string calldata uri) external onlyRole(CONTROLLER_ROLE) {
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Updates the off-chain document pointer (called when the B/L/AWB is anchored).
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyRole(CONTROLLER_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist(tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Transfers the document of title (milestone-gated by the caller/core).
    function transferTitle(uint256 tokenId, address to) external onlyRole(CONTROLLER_ROLE) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert TokenDoesNotExist(tokenId);
        _transfer(owner, to, tokenId);
    }

    /// @notice True when the token exists (minted and not burned).
    function exists(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721URIStorage, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
