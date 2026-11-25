import React, { useEffect, useState } from "react";
import { BrowserProvider, JsonRpcProvider, Contract, MaxUint256, isAddress, parseUnits, formatUnits } from "ethers";
import { CORE_ABI, ERC20_ABI, INCOTERMS, PAYMENT_TERMS, PHASES, CUSTODY, DOC_TYPES } from "./abi.js";
import { uploadFile, fetchFromKubo } from "./ipfs.js";

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

  const [ipfs, setIpfs] = useState({ node: "http://127.0.0.1:5001" });
  const [order, setOrder] = useState({
    exporter: "",
    term: "1",
    lcAmount: "100000",
    deadlineDays: "30",
    paymentTerm: "0",
    deferredDays: "3",
  });
  const [ship, setShip] = useState({ orderId: "1", invoiceCid: "", packingCid: "" });
  const [doc, setDoc] = useState({ shipmentId: "1", docType: "3", cid: "" });
  const [mile, setMile] = useState({ shipmentId: "1", blCid: "" });
  const [duty, setDuty] = useState({ shipmentId: "1", amount: "0" });
  const [viewer, setViewer] = useState({ cid: "", node: "http://127.0.0.1:5001" });

  const append = (msg) => setLog((l) => `${new Date().toLocaleTimeString()}  ${msg}\n${l}`);

  async function connect() {
    try {
      let p;
      let list;
      if (window.ethereum) {
        p = new BrowserProvider(window.ethereum);
        list = await p.send("eth_requestAccounts", []);
      } else {
        p = new JsonRpcProvider(rpc);
        list = (await p.listAccounts()).map((a) => (typeof a === "string" ? a : a.address));
      }
      const selected = list[0] || "";
      setProvider(p);
      setAccounts(list);
      setAccount(selected);
      const net = await p.getNetwork();
      setStatus(`${window.ethereum ? "MetaMask" : "RPC"} · chain ${net.chainId} · ${selected || "read-only"}`);
      append(`Connected on chain ${net.chainId}${selected ? ` as ${selected}` : " (read-only)"}`);
      if (coreAddr && isAddress(coreAddr)) await loadCore(p, coreAddr, selected);
    } catch (err) {
      append(`connect ✘ ${err.shortMessage || err.message}`);
    }
  }

  useEffect(() => {
    const wallet = window.ethereum;
    if (!wallet?.on) return undefined;

    const reloadWallet = async (changedAccounts) => {
      try {
        const p = new BrowserProvider(wallet);
        const list = changedAccounts || (await p.send("eth_accounts", []));
        const selected = list[0] || "";
        const net = await p.getNetwork();
        setProvider(p);
        setAccounts(list);
        setAccount(selected);
        setStatus(`${selected ? "MetaMask" : "Wallet disconnected"} · chain ${net.chainId}${selected ? ` · ${selected}` : " · read-only"}`);
        if (coreAddr && isAddress(coreAddr)) await loadCore(p, coreAddr, selected);
      } catch (err) {
        append(`wallet update ✘ ${err.shortMessage || err.message}`);
      }
    };
    const onAccountsChanged = (nextAccounts) => reloadWallet(nextAccounts);
    const onChainChanged = () => reloadWallet();
    wallet.on("accountsChanged", onAccountsChanged);
    wallet.on("chainChanged", onChainChanged);
    return () => {
      wallet.removeListener?.("accountsChanged", onAccountsChanged);
      wallet.removeListener?.("chainChanged", onChainChanged);
    };
  }, [coreAddr]);

  async function loadCore(p = provider, addr = coreAddr, activeAccount = account) {
    if (!p) return append("connect a wallet first");
    if (!isAddress(addr)) return alert("Enter a valid TradeChainCore address.");
    localStorage.setItem("tradechain.core", addr);
    const c = new Contract(addr, CORE_ABI, p);
    setCore(c);
    const net = await p.getNetwork();
    const walletLabel = activeAccount ? `${activeAccount.slice(0, 6)}…${activeAccount.slice(-4)}` : "Read-only";
    setStatus(`${walletLabel} · chain ${net.chainId} · core ${addr.slice(0, 6)}…${addr.slice(-4)}`);
    append(`Loaded core ${addr}`);
  }

  function signer() {
    if (!provider || !account) throw new Error("Connect a wallet account first.");
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
    // Two allowances: the core pulls escrow/duty tokens, and the LetterOfCredit module
    // pulls the applicant's reimbursement straight to the issuing bank.
    const s = await signer();
    const tokenAddr = await core.settlementToken();
    const token = new Contract(tokenAddr, ERC20_ABI, s);
    await (await token.approve(await core.getAddress(), MaxUint256)).wait();
    return token.approve(await core.letterOfCredit(), MaxUint256);
  }

  async function onUpload(e, setter, key) {
    const file = e.target.files?.[0];
    if (!file) return;
    const provider = e.target.dataset.provider || "kubo";
    await run(`ipfs add ${file.name}`, async () => {
      const cid = await uploadFile(file, { provider, apiBase: ipfs.node });
      setter((f) => ({ ...f, [key]: cid }));
      return null;
    });
  }

  // Any involved party can read a document by CID from the role node that holds a copy.
  async function viewDocument() {
    await run(`ipfs cat ${viewer.cid || "…"}`, async () => {
      const blob = await fetchFromKubo(viewer.cid, viewer.node);
      window.open(URL.createObjectURL(blob), "_blank");
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
      const [ok, missing] = await core.examinePresentation(BigInt(id));
      const payTerm = PAYMENT_TERMS[Number(lc.term)];
      setShipment(
        `${counts}\n\nshipment #${s.id} (order #${s.orderId}) · ${INCOTERMS[Number(s.term)]} · phase ${
          PHASES[Number(s.phase)]
        } · custody ${CUSTODY[Number(s.custody)]}\n` +
          `beneficiary (exporter) ${s.exporter}\napplicant (importer) ${s.importer}\nriskHolder ${s.riskHolder}\n` +
          `L/C ${formatUnits(s.lcAmount, 6)} tUSD · ${payTerm}${Number(lc.term) === 1 ? ` (+${lc.deferredDays}d)` : ""}\n` +
          `issuing bank ${lc.issuingBank}\nissued ${lc.issued} · presented ${lc.presented} · honored ${lc.honored} · paid ${lc.paid} · reimbursed ${lc.reimbursed} · reclaimed ${lc.reclaimed}\n` +
          `duty ${formatUnits(lc.dutyAmount, 6)}${lc.dutyPaid ? " (paid)" : " (unpaid)"}\n` +
          `examination: ${ok ? "presentation set complete — the bank may honor" : `not presentable yet (missing ${DOC_TYPES[Number(missing)]})`}\n\n` +
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
          <button onClick={connect}>Connect MetaMask / Load</button>
          <label>Active account</label>
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.map((a) => (
              <option key={a} value={a}>
                {a.slice(0, 6)}…{a.slice(-4)}
              </option>
            ))}
          </select>
          <p className="hint">
            MetaMask: unlock it, select the intended account and network, then connect above. Without MetaMask,
            the dashboard uses the configured JSON-RPC endpoint (Hardhat exposes unlocked test accounts;
            other RPC endpoints are normally read-only). Local demo: run <code>npx hardhat node</code>,
            deploy to localhost, then paste the core address.
          </p>
        </section>

        <section>
          <h2>1 · Apply for credit → bank issues → shipment</h2>
          <label>Beneficiary (exporter) address</label>
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
          <div className="row">
            <div>
              <label>Payment term</label>
              <select name="paymentTerm" value={order.paymentTerm} onChange={set(setOrder)}>
                {PAYMENT_TERMS.map((t, i) => (
                  <option key={t} value={i}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Deferral (days, Deferred only)</label>
              <input name="deferredDays" value={order.deferredDays} onChange={set(setOrder)} />
            </div>
          </div>
          <label>Deadline (days)</label>
          <input name="deadlineDays" value={order.deadlineDays} onChange={set(setOrder)} />
          <button
            onClick={() =>
              run("createOrder (apply for L/C)", async () => {
                // Base the deadline on the chain clock (a shifted local node would reject wall-clock math).
                let now = Math.floor(Date.now() / 1000);
                try {
                  now = Number((await provider.getBlock("latest")).timestamp);
                } catch {}
                const d = BigInt(now + 1) + BigInt(Number(order.deadlineDays) * 86400);
                const deferred = Number(order.paymentTerm) === 1;
                return core
                  .connect(await signer())
                  .createOrder(
                    order.exporter,
                    Number(order.term),
                    parseUnits(order.lcAmount, 6),
                    d,
                    Number(order.paymentTerm),
                    deferred ? BigInt(order.deferredDays || "0") : 0
                  );
              })
            }
          >
            Importer → createOrder (apply for L/C)
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
          <button
            onClick={() =>
              run("issueLetterOfCredit", async () =>
                core.connect(await signer()).issueLetterOfCredit(ship.orderId)
              )
            }
          >
            Bank → issueLetterOfCredit (funds the escrow)
          </button>
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
          <p className="hint">
            The bank — not the importer — funds the escrow: connect the bank account and approve TradeUSD
            below first. The named exporter can ship only after the credit is issued and operative.
          </p>
        </section>

        <section>
          <h2>2 · Documents, presentation &amp; examination</h2>
          <label>IPFS node (this role's kubo API)</label>
          <input name="node" value={ipfs.node} onChange={set(setIpfs)} placeholder="http://127.0.0.1:5001" />
          <p className="hint">
            Per-role IPFS model: each role runs its own kubo node (e.g. exporter :5001, importer :5011,
            bank :5021) and keeps its own copy. Any involved party can read a document by its CID from
            the node that holds it — see the document viewer below.
          </p>
          <button onClick={() => run("approve token", approveToken)}>Approve TradeUSD</button>
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
          <button
            onClick={() => run("presentDocuments", async () => core.connect(await signer()).presentDocuments(doc.shipmentId))}
          >
            Exporter → presentDocuments
          </button>
          <button
            onClick={() => run("honorPresentation", async () => core.connect(await signer()).honorPresentation(doc.shipmentId))}
          >
            Bank → honorPresentation (examines &amp; honors)
          </button>
          <button
            onClick={() => run("drawDeferredPayment", async () => core.connect(await signer()).drawDeferredPayment(doc.shipmentId))}
          >
            Anyone → drawDeferredPayment (after maturity)
          </button>
          <button
            onClick={() => run("reimburseIssuingBank", async () => core.connect(await signer()).reimburseIssuingBank(ship.orderId))}
          >
            Importer → reimburseIssuingBank (after honor)
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
          <button onClick={() => run("forceFinalizeDelivery", async () => core.connect(await signer()).forceFinalizeDelivery(doc.shipmentId))}>
            Bank → forceFinalizeDelivery
          </button>
          <button onClick={() => run("reclaimExpiredLC", async () => core.connect(await signer()).reclaimExpiredLC(ship.orderId))}>
            reclaimExpiredLC (unused credit → issuing bank)
          </button>
        </section>

        <section>
          <h2>Shipment viewer</h2>
          <button onClick={refresh}>Load shipment</button>
          <pre>{shipment}</pre>
        </section>

        <section>
          <h2>Document viewer (any role)</h2>
          <label>IPFS node holding the copy</label>
          <input
            name="node"
            value={viewer.node}
            onChange={set(setViewer)}
            placeholder="http://127.0.0.1:5001"
          />
          <label>Document CID (anchored on-chain)</label>
          <input name="cid" value={viewer.cid} onChange={set(setViewer)} placeholder="bafy…" />
          <button onClick={viewDocument}>Open document</button>
          <p className="hint">
            Point at the role node that holds the copy (e.g. the exporter's :5001) and open the CID that
            was anchored via <code>DocumentRegistry</code>. The CID guarantees integrity regardless of
            which node serves the bytes.
          </p>
        </section>

        <section className="logs">
          <h2>Activity log</h2>
          <pre>{log}</pre>
        </section>
      </main>
    </div>
  );
}
