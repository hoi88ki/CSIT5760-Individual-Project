// Minimal human-readable ABI for the TradeChainCore facade and the ERC-20 used for approvals.
export const CORE_ABI = [
  // roles
  "function ROLE_EXPORTER() view returns (bytes32)",
  "function ROLE_IMPORTER() view returns (bytes32)",
  "function ROLE_BANK() view returns (bytes32)",
  "function ROLE_LOGISTICS() view returns (bytes32)",
  "function ROLE_VERIFIER() view returns (bytes32)",
  "function grantRoles(bytes32[] roles, address[] accounts)",
  "function mint(address to, uint256 amount)",
  // workflow
  "function createOrder(address exporter, uint8 term, uint256 lcAmount, uint64 deadline) returns (uint256)",
  "function createShipment(uint256 orderId, string invoiceCID, string packingListCID) returns (uint256)",
  "function openLetterOfCredit(uint256 id)",
  "function anchorDocument(uint256 id, uint8 docType, string cid)",
  "function payCustomsDuty(uint256 id, uint256 amount)",
  "function confirmPickup(uint256 id)",
  "function confirmVesselLoading(uint256 id, string blCid)",
  "function confirmFinalDelivery(uint256 id)",
  "function reclaimExpiredLC(uint256 id)",
  "function forceFinalizeDelivery(uint256 id)",
  "function revokeDocument(uint256 id, uint8 docType)",
  // registry / module administration (admin or ROLE_REGISTRY_ADMIN)
  "function setDocumentRegistry(address newRegistry)",
  "function setModuleRole(address module, bytes32 role, address account, bool granted)",
  "function documentRegistryOf(uint256 id, uint8 docType) view returns (address)",
  "function ROLE_REGISTRY_ADMIN() view returns (bytes32)",
  // views
  "function settlementToken() view returns (address)",
  "function shipmentTracker() view returns (address)",
  "function documentRegistry() view returns (address)",
  "function complianceEngine() view returns (address)",
  "function letterOfCredit() view returns (address)",
  "function orderCount() view returns (uint256)",
  "function shipmentCount() view returns (uint256)",
  "function hasValidDocument(uint256 id, uint8 docType) view returns (bool)",
  "function requiredDocumentsAt(uint256 id, uint8 phase) view returns (uint8)",
  "function payoutPhaseOf(uint8 term) view returns (uint8)",
  "function getShipment(uint256 id) view returns (tuple(uint256 id, uint256 orderId, address exporter, address importer, uint8 term, uint8 phase, uint64 createdAt, uint64 deadline, uint256 lcAmount, address riskHolder))",
  "function getLC(uint256 id) view returns (tuple(uint256 shipmentId, uint256 amount, bool funded, bool paid, bool reclaimed, uint256 dutyAmount, bool dutyPaid, address dutyPayer))",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

export const INCOTERMS = ["EXW", "FOB", "CIF", "DDP"];
export const PHASES = ["Created", "LCFunded", "PickedUp", "LoadedOnVessel", "Delivered", "Settled", "Reclaimed"];
export const DOC_TYPES = [
  "CommercialInvoice",
  "PackingList",
  "CertificateOfOrigin",
  "InspectionCertificate",
  "InsuranceCertificate",
  "BillOfLadingOrAWB",
  "CustomsClearance",
];
