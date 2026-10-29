#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineChain, getAddress, type Hex } from "viem";
import { z } from "zod";
import { createTools } from "./tools.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`wifgate-mcp: missing ${name}`);
    process.exit(1);
  }
  return v;
}

const chainId = process.env.WIF_CHAIN_ID ? Number(process.env.WIF_CHAIN_ID) : undefined;
const rpcUrl = process.env.RH_RPC_URL;
const tools = createTools({
  privateKey: need("WIF_AGENT_PRIVATE_KEY") as Hex,
  gate: getAddress(need("WIFGATE_ADDRESS")),
  maxPrice: process.env.WIF_MAX_PRICE ?? "5",
  maxTotal: process.env.WIF_MAX_TOTAL ?? "20",
  allowedHosts: (process.env.WIF_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ...(rpcUrl ? { rpcUrl } : {}),
  ...(process.env.WIF_TOKEN ? { token: getAddress(process.env.WIF_TOKEN) } : {}),
  ...(chainId && rpcUrl
    ? { chain: defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }) }
    : {}),
});

const server = new McpServer({ name: "wifgate", version: "0.1.0" });
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }] });

server.registerTool(
  "wif_quote",
  {
    description: "Ask what an HTTP API costs in $WIF without paying. Always call this before wif_fetch on an unfamiliar URL.",
    inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).optional() },
  },
  async ({ url, method }) => {
    try { return text(await tools.quote(url, method)); } catch (e) { return failure(e); }
  },
);

server.registerTool(
  "wif_fetch",
  {
    description:
      "Call an HTTP API. If it answers 402 Payment Required and the host is allowed, pays the price in $WIF (2% of every payment is burned) and returns the response. Payments are capped per call and per session.",
    inputSchema: {
      url: z.string().url(),
      method: z.enum(["GET", "POST"]).optional(),
      body: z.string().max(20_000).optional().describe("Request body, usually a JSON string"),
    },
  },
  async ({ url, method, body }) => {
    try { return text(await tools.fetch(url, { ...(method ? { method } : {}), ...(body !== undefined ? { body } : {}) })); } catch (e) { return failure(e); }
  },
);

server.registerTool(
  "wif_wallet",
  { description: "Show the agent wallet, its $WIF balance, how much it has spent and what budget is left.", inputSchema: {} },
  async () => {
    try { return text(await tools.wallet()); } catch (e) { return failure(e); }
  },
);

await server.connect(new StdioServerTransport());
console.error("wifgate-mcp ready");
