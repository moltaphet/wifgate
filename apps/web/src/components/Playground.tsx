"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createWalletClient, custom, erc20Abi, formatUnits, parseUnits, type Address, type WalletClient } from "viem";
import {
  createWifFetch,
  InsufficientWifError,
  PaymentLimitError,
  PaymentRejectedError,
  UntrustedChallengeError,
  type WifEvent,
  type WifFetch,
} from "wifgate/client";
import { API_URL, GATE, TOKEN, chain, explorerTx, isConfigured, publicClient } from "@/lib/config";
import { fmtWif, short } from "@/lib/format";

interface Route {
  method: string;
  path: string;
  price: string;
  callsPerPayment: number;
  description: string;
}
interface LogItem {
  id: number;
  t: string;
  kind: "info" | "ok" | "err";
  msg: ReactNode;
}
type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?(e: string, cb: () => void): void; removeListener?(e: string, cb: () => void): void };

const SAMPLE = "Pay-per-request APIs let agents buy exactly the data they need, and every payment burns WIF.";
const PRICE_RE = /^\d+(\.\d{1,18})?$/;

function ethereum(): Eip1193 | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum;
}

export function Playground() {
  const [routes, setRoutes] = useState<Route[] | undefined>();
  const [apiError, setApiError] = useState<string | undefined>();
  const [selected, setSelected] = useState(0);
  const [text, setText] = useState(SAMPLE);
  const [maxPrice, setMaxPrice] = useState("5");
  const [account, setAccount] = useState<Address | undefined>();
  const [wifBalance, setWifBalance] = useState<bigint | undefined>();
  const [ethBalance, setEthBalance] = useState<bigint | undefined>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogItem[]>([]);
  const [output, setOutput] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const walletRef = useRef<WalletClient | undefined>();
  const wfRef = useRef<{ key: string; wf: WifFetch } | undefined>();
  const startRef = useRef(0);
  const idRef = useRef(0);

  const push = useCallback((kind: LogItem["kind"], msg: ReactNode) => {
    const t = ((Date.now() - startRef.current) / 1000).toFixed(1);
    setLog((l) => [...l, { id: idRef.current++, t: `+${t}s`, kind, msg }]);
  }, []);

  // Load the demo API's catalogue.
  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { routes: Route[] }) => alive && setRoutes(j.routes))
      .catch((e: Error) => alive && setApiError(`Could not reach the demo API at ${API_URL} (${e.message}).`));
    return () => {
      alive = false;
    };
  }, []);

  const refreshBalances = useCallback(async (addr: Address) => {
    try {
      const [w, e] = await Promise.all([
        publicClient.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [addr] }),
        publicClient.getBalance({ address: addr }),
      ]);
      setWifBalance(w);
      setEthBalance(e);
    } catch {
      /* balances are informational */
    }
  }, []);

  // Forget the session when the wallet changes account or network.
  useEffect(() => {
    const eth = ethereum();
    if (!eth?.on) return;
    const reset = () => {
      setAccount(undefined);
      walletRef.current = undefined;
      wfRef.current = undefined;
      setNotice("Wallet changed. Connect again to continue.");
    };
    eth.on("accountsChanged", reset);
    eth.on("chainChanged", reset);
    return () => {
      eth.removeListener?.("accountsChanged", reset);
      eth.removeListener?.("chainChanged", reset);
    };
  }, []);

  const connect = async () => {
    setNotice(undefined);
    const eth = ethereum();
    if (!eth) {
      setNotice("No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet, then reload.");
      return;
    }
    try {
      const probe = createWalletClient({ chain, transport: custom(eth) });
      const [addr] = await probe.requestAddresses();
      if (!addr) throw new Error("The wallet returned no account.");
      if ((await probe.getChainId()) !== chain.id) {
        try {
          await probe.switchChain({ id: chain.id });
        } catch {
          await probe.addChain({ chain });
        }
      }
      walletRef.current = createWalletClient({ account: addr, chain, transport: custom(eth) });
      wfRef.current = undefined;
      setAccount(addr);
      void refreshBalances(addr);
    } catch (e) {
      setNotice(e instanceof Error ? e.message.split("\n")[0] ?? "Could not connect." : "Could not connect.");
    }
  };

  const onEvent = useCallback(
    (e: WifEvent) => {
      switch (e.type) {
        case "challenge":
          push("info", <>402 Payment Required: <b>{fmtWif(BigInt(e.requirements.price))} WIF</b> for “{e.requirements.resource}” ({e.requirements.calls} call{e.requirements.calls > 1 ? "s" : ""} per payment).</>);
          break;
        case "approving":
          push("info", "Approve in your wallet: let WifGate move this amount of $WIF. It cannot move more.");
          break;
        case "approved":
          push("ok", <>Approved. <a href={explorerTx(e.txHash)} target="_blank" rel="noreferrer">{short(e.txHash, 8, 6)}</a></>);
          break;
        case "paying":
          push("info", "Confirm the payment in your wallet.");
          break;
        case "paid":
          push("ok", <>Paid {fmtWif(e.record.amount)} WIF, burned {fmtWif(e.record.burned, 4)}. <a href={explorerTx(e.record.txHash)} target="_blank" rel="noreferrer">{short(e.record.txHash, 8, 6)}</a></>);
          break;
        case "signed":
          push("info", "Signed the proof with your wallet. This stops anyone else reusing your transaction.");
          break;
        case "retry":
          push("info", `The server has not seen the payment yet (${e.reason}). Retrying, attempt ${e.attempt}.`);
          break;
        case "redeemed":
          push(e.status < 400 ? "ok" : "err", `Server answered ${e.status}.`);
          break;
      }
    },
    [push],
  );

  const route = routes?.[selected];
  const limitOk = PRICE_RE.test(maxPrice) && parseUnits(maxPrice, 18) > 0n;

  const call = async () => {
    if (!route || !walletRef.current || !account) return;
    if (!limitOk) {
      setNotice("Enter a spending limit above zero, for example 5.");
      return;
    }
    setNotice(undefined);
    setOutput(undefined);
    setLog([]);
    startRef.current = Date.now();
    setBusy(true);

    // One client per wallet and limit, so a multi-call payment keeps its credits between clicks.
    const key = `${account}:${maxPrice}`;
    if (wfRef.current?.key !== key) {
      const cap = parseUnits(maxPrice, 18);
      wfRef.current = {
        key,
        wf: createWifFetch({
          walletClient: walletRef.current,
          publicClient,
          gate: GATE,
          token: TOKEN,
          maxPricePerCall: cap,
          maxTotalSpend: cap * 20n,
          onEvent,
        }),
      };
    }
    const wf = wfRef.current.wf;
    const init: RequestInit =
      route.method === "POST"
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }
        : { method: route.method };

    push("info", `${route.method} ${route.path}`);
    try {
      const res = await wf(`${API_URL}${route.path}`, init);
      const credits = res.headers.get("x-wif-credits");
      const body = await res.text();
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* not JSON */
      }
      setOutput(pretty);
      push(res.ok ? "ok" : "err", `${res.status} ${res.statusText || ""}`.trim() + (credits ? ` · ${credits} call${credits === "1" ? "" : "s"} left on this payment` : ""));
    } catch (e) {
      push("err", explain(e));
    } finally {
      setBusy(false);
      void refreshBalances(account);
    }
  };

  const gateMismatch = useMemo(() => !isConfigured, []);

  return (
    <div className="pg">
      <div className="panel">
        <section className="panel__sec">
          <h2 className="panel__title">1. Wallet <span>{chain.name}</span></h2>
          {account ? (
            <dl className="kv">
              <dt>Account</dt><dd>{short(account, 8, 6)}</dd>
              <dt>$WIF</dt><dd>{fmtWif(wifBalance)}</dd>
              <dt>ETH for gas</dt><dd>{ethBalance === undefined ? "—" : Number(formatUnits(ethBalance, 18)).toFixed(5)}</dd>
            </dl>
          ) : (
            <button className="btn btn--small" onClick={connect}>Connect wallet</button>
          )}
          {wifBalance !== undefined && wifBalance === 0n && (
            <p className="notice">This wallet holds no $WIF. Get some first; each call below costs a small amount.</p>
          )}
        </section>

        <section className="panel__sec">
          <h2 className="panel__title">2. Pick a paid endpoint <span>{API_URL.replace(/^https?:\/\//, "")}</span></h2>
          {apiError && <p className="notice">{apiError} Start it with <code>npm start -w wifgate-demo-api</code>.</p>}
          {!routes && !apiError && <p>Loading endpoints…</p>}
          {routes && (
            <ul className="routes">
              {routes.map((r, i) => (
                <li key={r.path}>
                  <button className="route" aria-pressed={i === selected} onClick={() => setSelected(i)}>
                    <span className="route__top"><span>{r.method} {r.path}</span><span className="route__price">{r.price}</span></span>
                    <span className="route__desc">{r.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {route?.method === "POST" && (
            <div className="field">
              <label htmlFor="body">Text to analyse</label>
              <textarea id="body" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
            </div>
          )}
        </section>

        <section className="panel__sec">
          <h2 className="panel__title">3. Set a limit, then call</h2>
          <div className="field" style={{ marginTop: 0 }}>
            <label htmlFor="limit">Never pay more than (WIF per call)</label>
            <input id="limit" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.trim())} aria-invalid={!limitOk} />
          </div>
          <p style={{ margin: "14px 0 0" }}>
            <button className="btn btn--stamp" onClick={call} disabled={!account || !route || busy || gateMismatch}>
              {busy ? "Working…" : route ? `Call ${route.path}` : "Call"}
            </button>
          </p>
          {gateMismatch && <p className="notice">The WifGate contract address is not configured, so payments are disabled.</p>}
          {notice && <p className="notice">{notice}</p>}
        </section>
      </div>

      <div className="console" aria-live="polite">
        <div className="console__bar"><span>what is happening</span><span>{busy ? "running" : "idle"}</span></div>
        <div className="console__body">
          {log.length === 0 ? (
            <p className="console__empty">Connect a wallet, pick an endpoint and press Call. Each protocol step shows up here as it happens.</p>
          ) : (
            <ol className="log">
              {log.map((l) => (
                <li key={l.id} className={`log__item log__item--${l.kind === "info" ? "i" : l.kind}`}>
                  <span className="log__t">{l.t}</span>
                  <span className="log__msg">{l.msg}</span>
                </li>
              ))}
            </ol>
          )}
          {output !== undefined && <pre className="out">{output}</pre>}
        </div>
      </div>
    </div>
  );
}

function explain(e: unknown): string {
  if (e instanceof InsufficientWifError) return "Your wallet does not hold enough $WIF for this call. Nothing was spent.";
  if (e instanceof PaymentLimitError) return "The price is above your spending limit, so no payment was made. Raise the limit to continue.";
  if (e instanceof UntrustedChallengeError) return "The server asked to be paid through a contract this page does not trust. Nothing was spent.";
  if (e instanceof PaymentRejectedError) return `You paid, but the server did not accept the proof (${e.serverError?.error ?? "unknown"}). Your transaction: ${short(e.txHash, 8, 6)}.`;
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|denied/i.test(msg)) return "You declined the request in your wallet. Nothing was spent.";
  return msg.split("\n")[0] ?? "Something went wrong.";
}
