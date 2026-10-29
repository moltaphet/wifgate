import { erc20Abi, formatUnits, getAddress, parseUnits, type Address, type Chain, type Hex } from "viem";
import { createWifFetchFromKey, type WifFetch } from "wifgate/client";
import { WIF_ADDRESS } from "wifgate";

export interface ToolsConfig {
  privateKey: Hex;
  gate: Address;
  /** Max $WIF for a single payment, human units (e.g. "5"). */
  maxPrice: string;
  /** Max $WIF over the whole session, human units. */
  maxTotal: string;
  /** Hosts the assistant may PAY. Exact names or `*.example.com`. Empty = payments are refused. */
  allowedHosts: string[];
  rpcUrl?: string;
  chain?: Chain;
  token?: Address;
  /** Test hook. */
  fetch?: typeof fetch;
}

const MAX_BODY_CHARS = 20_000;

export function hostAllowed(hostname: string, allowed: string[]): boolean {
  const h = hostname.toLowerCase();
  return allowed.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (r.startsWith("*.")) return h.endsWith(r.slice(1)) && h.length > r.length - 1;
    return h === r;
  });
}

function parseUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http(s) URLs are supported");
  if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
  return u;
}

export function createTools(cfg: ToolsConfig) {
  const maxPrice = parseUnits(cfg.maxPrice, 18);
  const maxTotal = parseUnits(cfg.maxTotal, 18);
  const wf: WifFetch = createWifFetchFromKey({
    privateKey: cfg.privateKey,
    gate: cfg.gate,
    maxPricePerCall: maxPrice,
    maxTotalSpend: maxTotal,
    ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
    ...(cfg.chain ? { chain: cfg.chain } : {}),
    ...(cfg.token ? { token: cfg.token } : {}),
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
  });
  const token = getAddress(cfg.token ?? WIF_ADDRESS);

  return {
    wf,

    /** What would this cost? Safe: never pays. */
    async quote(rawUrl: string, method = "GET") {
      const url = parseUrl(rawUrl);
      const q = await wf.quote(url, { method, redirect: "error" });
      if (!q) return { requiresPayment: false as const };
      return {
        requiresPayment: true as const,
        resource: q.resource,
        priceWif: formatUnits(BigInt(q.price), 18),
        callsPerPayment: q.calls,
        creditsValidSeconds: q.validFor,
        burnedShare: `${q.burnBps / 100}%`,
        payTo: q.payTo,
        description: q.description ?? null,
        withinLimits: BigInt(q.price) <= maxPrice && wf.spent + BigInt(q.price) <= maxTotal,
        hostAllowed: hostAllowed(url.hostname, cfg.allowedHosts),
      };
    },

    /** Call a URL, paying with $WIF if it answers 402 and the host is allowed. */
    async fetch(rawUrl: string, opts: { method?: string; body?: string; contentType?: string } = {}) {
      const url = parseUrl(rawUrl);
      const init: RequestInit = { method: opts.method ?? "GET", redirect: "error" };
      if (opts.body !== undefined) {
        init.body = opts.body;
        init.headers = { "content-type": opts.contentType ?? "application/json" };
      }

      let res: Response;
      if (hostAllowed(url.hostname, cfg.allowedHosts)) {
        res = await wf(url, init);
      } else {
        // Not allowed to pay here: a plain request, and a clear message if it wants money.
        res = await (cfg.fetch ?? fetch)(new Request(url, init));
        if (res.status === 402) {
          return {
            status: 402,
            paid: false,
            error: `This host (${url.hostname}) is not in WIF_ALLOWED_HOSTS, so no payment was made. Ask the user to allow it.`,
          };
        }
      }
      const text = await res.text();
      const last = wf.history[wf.history.length - 1];
      return {
        status: res.status,
        paid: Boolean(res.headers.get("x-wif-payment")),
        creditsRemaining: res.headers.get("x-wif-credits"),
        body: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[truncated]` : text,
        lastPayment: last
          ? { resource: last.resource, paidWif: formatUnits(last.amount, 18), burnedWif: formatUnits(last.burned, 18), tx: last.txHash }
          : null,
      };
    },

    async wallet() {
      const balance = await getBalance();
      return {
        address: wf.address,
        balanceWif: formatUnits(balance, 18),
        spentWif: formatUnits(wf.spent, 18),
        remainingBudgetWif: formatUnits(maxTotal - wf.spent, 18),
        maxPricePerCallWif: cfg.maxPrice,
        allowedHosts: cfg.allowedHosts,
        payments: wf.history.map((p) => ({ resource: p.resource, paidWif: formatUnits(p.amount, 18), burnedWif: formatUnits(p.burned, 18), tx: p.txHash })),
      };
    },
  };

  async function getBalance(): Promise<bigint> {
    const { createPublicClient, http } = await import("viem");
    const { robinhoodChain, ROBINHOOD_RPC_URL } = await import("wifgate");
    const client = createPublicClient({ chain: cfg.chain ?? robinhoodChain, transport: http(cfg.rpcUrl ?? ROBINHOOD_RPC_URL) });
    return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wf.address] });
  }
}

export type Tools = ReturnType<typeof createTools>;
