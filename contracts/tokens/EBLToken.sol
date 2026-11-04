// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title EBLToken — Electronic Bill of Lading (title) token
/// @notice Standalone ERC-721 (one token per shipment) owned by the TradeChainCore contract.
///         Minted to the core (escrow), its `tokenURI` is set at vessel loading, and title is
///         transferred to the Buyer at final delivery. Only the core (MINTER_ROLE) can act.
contract EBLToken is ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 private _nextId;

    error TokenDoesNotExist(uint256 tokenId);

    /// @param admin The core contract, granted DEFAULT_ADMIN_ROLE and MINTER_ROLE.
    constructor(address admin) ERC721("TradeChain Electronic Bill of Lading", "TC-EBL") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    /// @notice Mints a new eB/L title token to `to`.
    function mint(address to, string calldata uri) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
        tokenId = ++_nextId;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Updates the off-chain document pointer (called when the B/L/AWB is anchored).
    function setTokenURI(uint256 tokenId, string calldata uri) external onlyRole(MINTER_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist(tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @notice Transfers eB/L title to the Buyer at final delivery.
    function transferTitle(uint256 tokenId, address to) external onlyRole(MINTER_ROLE) {
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert TokenDoesNotExist(tokenId);
        _transfer(owner, to, tokenId);
    }

    /// @notice True when the token exists (has been minted and not burned).
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
