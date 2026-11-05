import React, { useState } from "react";
import { BrowserProvider, JsonRpcProvider, Contract, MaxUint256, isAddress, parseUnits, formatUnits } from "ethers";
import { CORE_ABI, ERC20_ABI, INCOTERMS, PHASES, DOC_TYPES } from "./abi.js";
import { uploadFile } from "./ipfs.js";

const rpc = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8545";

export default function App() {
  const [provider, setProvider] = useState(null);
  const [core, setCore] = useState(null);
  const [coreAddr, setCoreAddr] = useState(localStorage.getItem("tradechain.core") || "");
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("Not connected");
  const [log, setLog] = useState("Ready.");
  const [shipment, setShipment] = useState("—");

  const [order, setOrder] = useState({ exporter: "", term: "1", lcAmount: "100000", deadlineDays: "30" });
  const [ship, setShip] = useState({ orderId: "1", invoiceCid: "", packingCid: "" });
  const [doc, setDoc] = useState({ shipmentId: "1", docType: "3", cid: "" });
  const [mile, setMile] = useState({ shipmentId: "1", blCid: "" });
  const [duty, setDuty] = useState({ shipmentId: "1", amount: "0" });

  const append = (msg) => setLog((l) => `${new Date().toLocaleTimeString()}  ${msg}\n${l}`);

  async function connect() {
    try {
      let p;
      if (window.ethereum) {
        p = new BrowserProvider(window.ethereum);
        await p.send("eth_requestAccounts", []);
      } else {
        p = new JsonRpcProvider(rpc);
      }
      const list = (await p.listAccounts()).map((a) => (typeof a === "string" ? a : a.address));
      setProvider(p);
      setAccounts(list);
      setAccount(list[0] || "");
      const net = await p.getNetwork();
      setStatus(`Connected · chain ${net.chainId} · ${list.length} accounts`);
      append(`Connected on chain ${net.chainId}`);
      if (coreAddr && isAddress(coreAddr)) await loadCore(p, coreAddr);
    } catch (err) {
      append(`connect ✘ ${err.shortMessage || err.message}`);
    }
  }

  async function loadCore(p = provider, addr = coreAddr) {
    if (!p) return append("connect a wallet first");
    if (!isAddress(addr)) return alert("Enter a valid TradeChainCore address.");
    localStorage.setItem("tradechain.core", addr);
    const c = new Contract(addr, CORE_ABI, p);
    setCore(c);
    setStatus(`Core ${addr.slice(0, 6)}…${addr.slice(-4)}`);
    append(`Loaded core ${addr}`);
  }

  function signer() {
    if (!provider) throw new Error("Connect first.");
    return provider.getSigner(account);
  }

  async function run(label, fn) {
    try {
      append(`${label} …`);
      const tx = await fn();
      if (tx && tx.wait) {
        const rc = await tx.wait();
        append(`${label} ✔ (gas ${rc.gasUsed})`);
      } else {
        append(`${label} ✔`);
      }
      await refresh();
    } catch (err) {
      append(`${label} ✘ ${err.shortMessage || err.reason || err.message}`);
    }
  }

  async function approveToken() {
    const s = await signer();
    const tokenAddr = await core.settlementToken();
    const token = new Contract(tokenAddr, ERC20_ABI, s);
    return token.approve(await core.getAddress(), MaxUint256);
  }

  async function onUpload(e, setter, key) {
    const file = e.target.files?.[0];
    if (!file) return;
    const value = e.target.dataset.provider || "kubo";
    await run(`ipfs add ${file.name}`, async () => {
      const cid = await uploadFile(file, value);
      setter((f) => ({ ...f, [key]: cid }));
      return null;
    });
  }

  async function refresh() {
    if (!core) return;
    try {
      const id = mile.shipmentId;
      const counts = `orders ${await core.orderCount()} · shipments ${await core.shipmentCount()}`;
      if (!id) return setShipment(counts);
      const s = await core.getShipment(BigInt(id));
      const lc = await core.getLC(BigInt(id));
      const docs = [];
      for (let i = 0; i < DOC_TYPES.length; i++) {
        docs.push(`${DOC_TYPES[i]}=${await core.hasValidDocument(BigInt(id), i)}`);
      }
      setShipment(
        `${counts}\n\nshipment #${s.id} (order #${s.orderId}) · ${INCOTERMS[Number(s.term)]} · phase ${
          PHASES[Number(s.phase)]
        }\n` +
          `exporter ${s.exporter}\nimporter ${s.importer}\nriskHolder ${s.riskHolder}\n` +
          `L/C ${formatUnits(s.lcAmount, 6)} · funded ${lc.funded} · paid ${lc.paid} · duty ${formatUnits(
            lc.dutyAmount,
            6
          )}\n\n` +
          `documents: ${docs.join(", ")}`
      );
    } catch {
      setShipment("(no such shipment yet)");
    }
  }

  const set = (setter) => (e) => setter((f) => ({ ...f, [e.target.name]: e.target.value }));

  return (
    <div className="app">
      <header>
        <h1>
          Trade<span>Chain</span> · Role Dashboard
        </h1>
        <span className="status">{status}</span>
      </header>

      <main>
        <section>
          <h2>Connection</h2>
          <label>TradeChainCore address</label>
          <input value={coreAddr} onChange={(e) => setCoreAddr(e.target.value)} placeholder="0x…" />
          <button onClick={connect}>Connect / Load</button>
          <label>Active account</label>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a.slice(0, 6)}…{a.slice(-4)}
              </option>
            ))}
          </select>
          <p className="hint">
            Local demo: <code>npx hardhat node</code> then <code>npx hardhat run scripts/deploy.js --network localhost</code>,
            paste the core address. MetaMask is used automatically when present.
          </p>
        </section>

        <section>
          <h2>1 · Order &amp; Shipment</h2>
          <label>Exporter address</label>
          <input name="exporter" value={order.exporter} onChange={set(setOrder)} placeholder="0x…" />
          <div className="row">
            <div>
              <label>Incoterm</label>
              <select name="term" value={order.term} onChange={set(setOrder)}>
                {INCOTERMS.map((t, i) => (
                  <option key={t} value={i}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>L/C amount (tUSD)</label>
              <input name="lcAmount" value={order.lcAmount} onChange={set(setOrder)} />
            </div>
          </div>
          <label>Deadline (days)</label>
          <input name="deadlineDays" value={order.deadlineDays} onChange={set(setOrder)} />
          <button
            onClick={() =>
              run("createOrder", async () => {
                const d = BigInt(Math.floor(Date.now() / 1000) + Number(order.deadlineDays) * 86400);
                return core.connect(await signer()).createOrder(order.exporter, Number(order.term), parseUnits(order.lcAmount, 6), d);
              })
            }
          >
            Importer → createOrder
          </button>
          <div className="row">
            <div>
              <label>Order id</label>
              <input name="orderId" value={ship.orderId} onChange={set(setShip)} />
            </div>
            <div>
              <label>Shipment id</label>
              <input name="shipmentId" value={doc.shipmentId} onChange={set(setDoc)} />
            </div>
          </div>
          <label>Invoice CID</label>
          <input name="invoiceCid" value={ship.invoiceCid} onChange={set(setShip)} placeholder="bafy…" />
          <label>Packing-list CID</label>
          <input name="packingCid" value={ship.packingCid} onChange={set(setShip)} placeholder="bafy…" />
          <button
            onClick={() =>
              run("createShipment", async () =>
                core.connect(await signer()).createShipment(ship.orderId, ship.invoiceCid, ship.packingCid)
              )
            }
          >
            Exporter → createShipment
          </button>
        </section>

        <section>
          <h2>2 · Documents &amp; Funding</h2>
          <button onClick={() => run("approve token", approveToken)}>Approve TradeUSD</button>
          <button
            onClick={() => run("openLetterOfCredit", async () => core.connect(await signer()).openLetterOfCredit(doc.shipmentId))}
          >
            Importer → openLetterOfCredit
          </button>
          <label>DocType</label>
          <select name="docType" value={doc.docType} onChange={set(setDoc)}>
            {DOC_TYPES.slice(2).map((d, i) => (
              <option key={d} value={i + 2}>
                {d}
              </option>
            ))}
          </select>
          <label>Document CID</label>
          <input name="cid" value={doc.cid} onChange={set(setDoc)} placeholder="bafy…" />
          <input type="file" data-provider="kubo" onChange={(e) => onUpload(e, setDoc, "cid")} />
          <button
            onClick={() => run("anchorDocument", async () => core.connect(await signer()).anchorDocument(doc.shipmentId, Number(doc.docType), doc.cid))}
          >
            Authorised role → anchorDocument
          </button>
        </section>

        <section>
          <h2>3 · Milestones</h2>
          <label>B/L or AWB CID</label>
          <input name="blCid" value={mile.blCid} onChange={set(setMile)} />
          <input type="file" data-provider="kubo" onChange={(e) => onUpload(e, setMile, "blCid")} />
          <button onClick={() => run("confirmPickup", async () => core.connect(await signer()).confirmPickup(doc.shipmentId))}>
            Logistics → confirmPickup
          </button>
          <button
            onClick={() => run("confirmVesselLoading", async () => core.connect(await signer()).confirmVesselLoading(doc.shipmentId, mile.blCid))}
          >
            Logistics → confirmVesselLoading
          </button>
          <div className="row">
            <div>
              <label>Duty (tUSD)</label>
              <input name="amount" value={duty.amount} onChange={set(setDuty)} />
            </div>
            <div>
              <label>&nbsp;</label>
              <button
                onClick={() =>
                  run("payCustomsDuty", async () =>
                    core.connect(await signer()).payCustomsDuty(doc.shipmentId, parseUnits(duty.amount || "0", 6))
                  )
                }
              >
                payCustomsDuty
              </button>
            </div>
          </div>
          <button
            onClick={() => run("confirmFinalDelivery", async () => core.connect(await signer()).confirmFinalDelivery(doc.shipmentId))}
          >
            Importer → confirmFinalDelivery
          </button>
          <button onClick={() => run("reclaimExpiredLC", async () => core.connect(await signer()).reclaimExpiredLC(doc.shipmentId))}>
            reclaimExpiredLC (importer/bank/admin)
          </button>
          <button onClick={() => run("forceFinalizeDelivery", async () => core.connect(await signer()).forceFinalizeDelivery(doc.shipmentId))}>
            Bank → forceFinalizeDelivery
          </button>
        </section>

        <section>
          <h2>Shipment viewer</h2>
          <button onClick={refresh}>Load shipment</button>
          <pre>{shipment}</pre>
        </section>

        <section className="logs">
          <h2>Activity log</h2>
          <pre>{log}</pre>
        </section>
      </main>
    </div>
  );
}
