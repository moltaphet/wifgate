import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { createGate, wifGate } from "wifgate/server";
import { startChain, type Chainlet } from "../../wifgate/test/harness.js";
import { createTools, hostAllowed } from "../src/tools.js";

let chain: Chainlet;
let server: Server;
let base: string;
let host: string;

beforeAll(async () => {
  chain = await startChain();
  const seller = (await chain.newWallet(0n)).account.address;
  const common = {
    payTo: seller, gate: chain.gate, token: chain.wif, secret: "mcp-test-secret-mcp-test-secret",
    chain: chain.chain, publicClient: chain.publicClient,
  };
  const app = express();
  app.get("/cheap", wifGate({ ...common, resource: "cheap", price: parseUnits("1", 18) }), (_req, res) => res.json({ ok: "cheap" }));
  app.get("/pricey", wifGate({ ...common, resource: "pricey", price: parseUnits("50", 18) }), (_req, res) => res.json({ ok: "pricey" }));
  app.get("/big", wifGate({ ...common, resource: "big", price: parseUnits("1", 18) }), (_req, res) => res.send("x".repeat(30_000)));
  app.get("/redirect", (_req, res) => res.redirect("http://evil.example/steal"));
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  host = "127.0.0.1";
  void createGate;
});

afterAll(() => {
  server?.close();
  chain?.stop();
});

async function tools(over: Partial<Parameters<typeof createTools>[0]> = {}) {
  const w = await chain.newWallet(parseUnits("100", 18));
  return createTools({
    privateKey: w.key, gate: chain.gate, token: chain.wif, chain: chain.chain, rpcUrl: chain.rpcUrl,
    maxPrice: "5", maxTotal: "10", allowedHosts: [host], ...over,
  });
}

describe("hostAllowed", () => {
  it("matches exact hosts and wildcard subdomains only", () => {
    expect(hostAllowed("api.example.com", ["api.example.com"])).toBe(true);
    expect(hostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("evilexample.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("api.example.com.evil.io", ["*.example.com"])).toBe(false);
    expect(hostAllowed("anything", [])).toBe(false);
    expect(hostAllowed("anything", [""])).toBe(false);
  });
});

describe("MCP tools", () => {
  it("quotes without paying", async () => {
    const t = await tools();
    const q = await t.quote(`${base}/cheap`);
    expect(q).toMatchObject({ requiresPayment: true, priceWif: "1", withinLimits: true, hostAllowed: true });
    expect(t.wf.spent).toBe(0n);
  });

  it("flags quotes that exceed limits or hit disallowed hosts", async () => {
    const t = await tools({ allowedHosts: [] });
    const q = await t.quote(`${base}/pricey`);
    expect(q).toMatchObject({ priceWif: "50", withinLimits: false, hostAllowed: false });
  });

  it("pays an allowed host and reports the payment", async () => {
    const t = await tools();
    const r = await t.fetch(`${base}/cheap`);
    expect(r).toMatchObject({ status: 200, paid: true });
    expect((r as any).lastPayment.paidWif).toBe("1");
    expect((r as any).lastPayment.burnedWif).toBe("0.02");
    const w = await t.wallet();
    expect(w.spentWif).toBe("1");
    expect(w.remainingBudgetWif).toBe("9");
    expect(w.balanceWif).toBe("99");
  });

  it("refuses to pay hosts outside the allowlist", async () => {
    const t = await tools({ allowedHosts: ["only.example.com"] });
    const r = await t.fetch(`${base}/cheap`);
    expect(r).toMatchObject({ status: 402, paid: false });
    expect(t.wf.spent).toBe(0n);
  });

  it("enforces the per-call and session caps", async () => {
    const t = await tools();
    await expect(t.fetch(`${base}/pricey`)).rejects.toThrow(/maxPricePerCall/);
    const small = await tools({ maxPrice: "5", maxTotal: "2" });
    expect((await small.fetch(`${base}/cheap`)).status).toBe(200);
    expect((await small.fetch(`${base}/cheap`)).status).toBe(200);
    await expect(small.fetch(`${base}/cheap`)).rejects.toThrow(/maxTotalSpend/);
    expect(small.wf.spent).toBe(parseUnits("2", 18));
  });

  it("truncates huge responses", async () => {
    const t = await tools();
    const r = (await t.fetch(`${base}/big`)) as any;
    expect(r.body.length).toBeLessThan(20_100);
    expect(r.body.endsWith("[truncated]")).toBe(true);
  });

  it("does not follow redirects (payment headers must not leak)", async () => {
    const t = await tools();
    await expect(t.fetch(`${base}/redirect`)).rejects.toThrow();
  });

  it("rejects non-http URLs and embedded credentials", async () => {
    const t = await tools();
    await expect(t.quote("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(t.fetch("http://user:pw@127.0.0.1/x")).rejects.toThrow(/credentials/);
  });
});
