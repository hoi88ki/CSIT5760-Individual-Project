/* TradeChain — minimal role dashboard (ethers v6, no build step). */
/* global ethers */

const ABI = [
  // orders / shipments
  "function createOrder(address seller, uint8 term, uint256 lcAmount, uint64 deadline) returns (uint256)",
  "function createShipment(uint256 orderId, string invoiceCID, string packingListCID) returns (uint256)",
  "function openLetterOfCredit(uint256 id)",
  "function anchorDocument(uint256 id, uint8 docType, string cid)",
  "function payCustomsDuty(uint256 id, uint256 dutyAmount)",
  "function confirmPickup(uint256 id)",
  "function confirmVesselLoading(uint256 id, string blCid)",
  "function confirmFinalDelivery(uint256 id)",
  "function reclaimExpiredLC(uint256 id)",
  "function forceFinalizeDelivery(uint256 id)",
  // views
  "function orderCount() view returns (uint256)",
  "function shipmentCount() view returns (uint256)",
  "function hasValidDocument(uint256 id, uint8 docType) view returns (bool)",
  "function settlementToken() view returns (address)",
  "function eblToken() view returns (address)",
  "function getShipment(uint256 id) view returns (tuple(uint256 id, uint256 orderId, uint64 createdAt, uint64 deadline, uint8 term, uint8 phase, bool lcFunded, bool lcPaid, bool dutyPaid, bool titleTransferred, uint256 lcAmount, uint256 dutyAmount, address seller, address buyer, address riskHolder, address dutyPayer))",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function decimals() view returns (uint8)",
];

const TERMS = ["EXW", "FOB", "CIF", "DDP"];
const PHASES = ["Created", "LCFunded", "PickedUp", "LoadedOnVessel", "Delivered", "Settled", "Reclaimed"];
const DOC_TYPES = ["CommercialInvoice", "PackingList", "CertificateOfOrigin", "InspectionCertificate", "InsuranceCertificate", "BillOfLadingOrAWB", "CustomsClearance"];

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $("log");
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n${el.textContent}`;
};

let provider;
let core;
let contractAddress;

async function getProvider() {
  if (window.ethereum) {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
  } else {
    provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  }
  return provider;
}

async function connect() {
  contractAddress = $("core").value.trim();
  if (!ethers.isAddress(contractAddress)) {
    alert("Enter a valid TradeChainCore address.");
    return;
  }
  localStorage.setItem("tradechain.core", contractAddress);

  await getProvider();
  core = new ethers.Contract(contractAddress, ABI, provider);

  const net = await provider.getNetwork();
  const signers = await provider.listAccounts();
  const select = $("account");
  select.innerHTML = "";
  for (const s of signers) {
    const addr = typeof s === "string" ? s : s.address;
    const opt = document.createElement("option");
    opt.value = addr;
    opt.textContent = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    select.appendChild(opt);
  }

  $("status").textContent = `Connected · chain ${net.chainId} · ${signers.length} accounts`;
  log(`Connected to core ${contractAddress} on chain ${net.chainId}`);
}

function activeSigner() {
  if (!provider) throw new Error("Connect first.");
  return provider.getSigner($("account").value);
}

async function run(label, fn) {
  try {
    log(`${label} …`);
    const tx = await fn();
    if (tx && tx.wait) {
      const rc = await tx.wait();
      log(`${label} ✔ (gas ${rc.gasUsed})`);
    } else {
      log(`${label} ✔`);
    }
    await refresh();
  } catch (err) {
    const reason = err?.shortMessage || err?.reason || err?.message || String(err);
    log(`${label} ✘ ${reason}`);
  }
}

const big = (id) => BigInt($(id).value.trim());

async function refresh() {
  if (!core) return;
  try {
    const id = $("shipmentId").value.trim();
    const counts = `orders: ${await core.orderCount()} · shipments: ${await core.shipmentCount()}`;
    if (!id) {
      $("shipment").textContent = counts;
      return;
    }
    const s = await core.getShipment(BigInt(id));
    const docs = {};
    for (let i = 0; i < DOC_TYPES.length; i++) docs[DOC_TYPES[i]] = await core.hasValidDocument(BigInt(id), i);
    $("shipment").textContent =
      `${counts}\n\n` +
      `shipment #${s.id} (order #${s.orderId}) · ${TERMS[Number(s.term)]} · phase ${PHASES[Number(s.phase)]}\n` +
      `seller ${s.seller}\nbuyer  ${s.buyer}\nriskHolder ${s.riskHolder}\n` +
      `lcAmount ${ethers.formatUnits(s.lcAmount, 6)} tUSD · lcPaid ${s.lcPaid} · duty ${ethers.formatUnits(s.dutyAmount, 6)} (paid ${s.dutyPaid})\n` +
      `titleTransferred ${s.titleTransferred}\n\n` +
      `documents: ${Object.entries(docs).map(([k, v]) => `${k}=${v}`).join(", ")}`;
  } catch (err) {
    $("shipment").textContent = `(no such shipment yet)`;
  }
}

async function approveToken() {
  const signer = await activeSigner();
  const tokenAddr = await core.settlementToken();
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  return token.approve(contractAddress, ethers.MaxUint256);
}

function wire() {
  $("connect").onclick = connect;
  $("core").value = localStorage.getItem("tradechain.core") || "";

  $("createOrder").onclick = () => run("createOrder", async () => {
    const signer = await activeSigner();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Number($("deadlineDays").value) * 86400);
    const amount = ethers.parseUnits($("lcAmount").value, 6);
    return core.connect(signer).createOrder($("seller").value.trim(), Number($("term").value), amount, deadline);
  });

  $("createShipment").onclick = () => run("createShipment", async () => {
    const signer = await activeSigner();
    return core.connect(signer).createShipment(big("orderId"), $("invoiceCid").value.trim(), $("packingCid").value.trim());
  });

  $("fund").onclick = () => run("approve token", approveToken);

  $("openLc").onclick = () => run("openLetterOfCredit", async () => {
    const signer = await activeSigner();
    return core.connect(signer).openLetterOfCredit(big("shipmentId"));
  });

  $("anchor").onclick = () => run("anchorDocument", async () => {
    const signer = await activeSigner();
    return core.connect(signer).anchorDocument(big("shipmentId"), Number($("docType").value), $("docCid").value.trim());
  });

  $("pickup").onclick = () => run("confirmPickup", async () => core.connect(await activeSigner()).confirmPickup(big("shipmentId")));
  $("loading").onclick = () => run("confirmVesselLoading", async () => core.connect(await activeSigner()).confirmVesselLoading(big("shipmentId"), $("blCid").value.trim()));
  $("dutyBtn").onclick = () => run("payCustomsDuty", async () => core.connect(await activeSigner()).payCustomsDuty(big("shipmentId"), ethers.parseUnits($("duty").value || "0", 6)));
  $("deliver").onclick = () => run("confirmFinalDelivery", async () => core.connect(await activeSigner()).confirmFinalDelivery(big("shipmentId")));
  $("reclaim").onclick = () => run("reclaimExpiredLC", async () => core.connect(await activeSigner()).reclaimExpiredLC(big("shipmentId")));
  $("force").onclick = () => run("forceFinalizeDelivery", async () => core.connect(await activeSigner()).forceFinalizeDelivery(big("shipmentId")));
  $("refresh").onclick = refresh;
}

wire();
