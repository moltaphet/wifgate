import express, { type Express, type Request, type Response } from "express";
import { erc20Abi, formatUnits, parseUnits, type Address, type Chain, type PublicClient } from "viem";
import {
  ALLOW_HEADERS,
  BURN_ADDRESS,
  EXPOSE_HEADERS,
  MemoryStore,
  UpstashStore,
  wifGate,
  wifGateAbi,
  type GateConfig,
  type GateStore,
} from "wifgate/server";

export interface DemoOptions {
  gate: Address;
  token: Address;
  payTo: Address;
  secret: string;
  chain: Chain;
  publicClient: PublicClient;
  store?: GateStore;
  /** Allowed browser origins for the playground. "*" is fine: the API holds no cookies. */
  corsOrigin?: string;
}

const WIF = (n: string) => parseUnits(n, 18);

/** Paid routes: name, price, calls per payment, what it does. */
export const CATALOG = [
  { path: "/api/wif-stats", resource: "wif-stats", price: "1", calls: 1, description: "Live $WIF burn and WifGate volume, read from the chain" },
  { path: "/api/chain-pulse", resource: "chain-pulse", price: "0.5", calls: 10, validFor: 120, description: "Block height, gas price and base fee. One payment = 10 calls for 2 minutes" },
  { path: "/api/text-stats", resource: "text-stats", price: "2", calls: 1, description: "POST text, get word count, reading time and top keywords", method: "POST" },
] as const;

export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): GateStore {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  }
  return new MemoryStore();
}

export function createDemoApp(o: DemoOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20kb" }));

  // CORS so the browser playground can call us and read the x-wif-* headers.
  app.use((req, res, next) => {
    res.setHeader("access-control-allow-origin", o.corsOrigin ?? "*");
    res.setHeader("access-control-allow-headers", ALLOW_HEADERS);
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-expose-headers", EXPOSE_HEADERS);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  const store = o.store ?? new MemoryStore();
  const base = {
    payTo: o.payTo, gate: o.gate, token: o.token, secret: o.secret, chain: o.chain,
    publicClient: o.publicClient, store,
  } satisfies Partial<GateConfig>;

  const gateFor = (r: (typeof CATALOG)[number]) =>
    wifGate({
      ...base,
      resource: r.resource,
      price: WIF(r.price),
      calls: r.calls,
      validFor: "validFor" in r ? r.validFor : 300,
      description: r.description,
    });

  app.get("/", (_req, res) => {
    res.json({
      name: "WifGate demo API",
      protocol: "wifgate-v1 (HTTP 402, paid in $WIF)",
      gate: o.gate,
      payTo: o.payTo,
      routes: CATALOG.map((r) => ({
        method: "method" in r ? r.method : "GET",
        path: r.path,
        price: `${r.price} WIF`,
        callsPerPayment: r.calls,
        description: r.description,
      })),
    });
  });
  app.get("/health", (_req, res) => void res.json({ ok: true }));

  app.get("/api/wif-stats", gateFor(CATALOG[0]), async (_req, res, next) => {
    try {
      const [burned, volume, payments, supply, dead] = await Promise.all([
        o.publicClient.readContract({ address: o.gate, abi: wifGateAbi, functionName: "totalBurned" }),
        o.publicClient.readContract({ address: o.gate, abi: wifGateAbi, functionName: "totalVolume" }),
        o.publicClient.readContract({ address: o.gate, abi: wifGateAbi, functionName: "totalPayments" }),
        o.publicClient.readContract({ address: o.token, abi: erc20Abi, functionName: "totalSupply" }),
        o.publicClient.readContract({ address: o.token, abi: erc20Abi, functionName: "balanceOf", args: [BURN_ADDRESS] }),
      ]);
      res.json({
        wifGate: {
          totalBurned: formatUnits(burned, 18),
          totalVolume: formatUnits(volume, 18),
          totalPayments: payments.toString(),
        },
        token: {
          totalSupply: formatUnits(supply, 18),
          inBurnAddress: formatUnits(dead, 18),
          circulating: formatUnits(supply - dead, 18),
        },
      });
    } catch (e) {
      next(e);
    }
  });

  app.get("/api/chain-pulse", gateFor(CATALOG[1]), async (_req, res, next) => {
    try {
      const [block, gasPrice] = await Promise.all([o.publicClient.getBlock(), o.publicClient.getGasPrice()]);
      res.json({
        chainId: o.chain.id,
        blockNumber: block.number.toString(),
        blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
        baseFeePerGas: block.baseFeePerGas?.toString() ?? null,
        gasPrice: gasPrice.toString(),
        txCount: block.transactions.length,
      });
    } catch (e) {
      next(e);
    }
  });

  app.post("/api/text-stats", gateFor(CATALOG[2]), (req: Request, res: Response) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      // 4xx: the credit is consumed, the caller sent bad input. (5xx would refund it.)
      res.status(400).json({ error: "send JSON like {\"text\": \"...\"}" });
      return;
    }
    const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const stop = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "that", "for", "on", "with", "as", "this", "be"]);
    const freq = new Map<string, number>();
    for (const w of words) if (w.length > 2 && !stop.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => ({ word, count }));
    res.json({
      words: words.length,
      characters: text.length,
      readingMinutes: Math.max(1, Math.round(words.length / 220)),
      topKeywords: top,
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
