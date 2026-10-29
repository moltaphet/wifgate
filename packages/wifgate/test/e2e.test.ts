import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWalletClient,
  custom,
  erc20Abi,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createWifFetch, InsufficientWifError, PaymentLimitError, PaymentRejectedError, UntrustedChallengeError, type WifFetch } from "../src/client.js";
import { BURN_ADDRESS, HEADERS } from "../src/constants.js";
import { createGate, MemoryStore, wifGate, withWifGate } from "../src/server.js";
import { wifGateAbi } from "../src/abi.js";
import { computePaymentId, encodeProof, proofMessage, resourceIdOf } from "../src/protocol.js";
import type { GateErrorBody, PaymentRequirements } from "../src/types.js";
import { ONE, startChain, type Chainlet } from "./harness.js";

const SECRET = "test-secret-test-secret-test-secret";
const PRICE = 5n * ONE;

let chain: Chainlet;
let server: Server;
let base: string;
let seller: Address;
const clock = { t: Math.floor(Date.now() / 1000) };
const now = () => clock.t;
let failNext = false;
let sharedStore: MemoryStore;

function cfg(resource: string, extra: Record<string, unknown> = {}) {
  return {
    payTo: seller, resource, price: PRICE, gate: chain.gate, secret: SECRET, token: chain.wif,
    chain: chain.chain, rpcUrl: chain.rpcUrl, publicClient: chain.publicClient, now,
    ...extra,
  };
}

async function wallet(balance?: bigint) {
  const w = await chain.newWallet(balance);
  const walletClient = createWalletClient({ account: w.account, chain: chain.chain, transport: http(chain.rpcUrl) });
  return { ...w, walletClient };
}

async function client(over: Record<string, unknown> = {}, w?: Awaited<ReturnType<typeof wallet>>) {
  const ww = w ?? (await wallet());
  const proofs: string[] = [];
  const recorder: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const p = req.headers.get(HEADERS.proof);
    if (p) proofs.push(p);
    return fetch(req);
  };
  const wf = createWifFetch({
    walletClient: ww.walletClient, publicClient: chain.publicClient, gate: chain.gate, token: chain.wif,
    maxPricePerCall: 10n * ONE, fetch: recorder, ...over,
  });
  return { wf, proofs, ...ww };
}

const balanceOf = (a: Address) =>
  chain.publicClient.readContract({ address: chain.wif, abi: erc20Abi, functionName: "balanceOf", args: [a] });

/** Pay a challenge by hand and build the proof header, so tests can tamper with it. */
async function manualPay(w: Awaited<ReturnType<typeof wallet>>, r: PaymentRequirements, opts: { amount?: bigint; payTo?: Address } = {}) {
  const approve = await w.walletClient.writeContract({
    address: chain.wif, abi: erc20Abi, functionName: "approve", args: [chain.gate, 10n ** 30n], chain: chain.chain,
  });
  await chain.publicClient.waitForTransactionReceipt({ hash: approve });
  const hash = await w.walletClient.writeContract({
    address: chain.gate, abi: wifGateAbi, functionName: "pay", chain: chain.chain,
    args: [opts.payTo ?? r.payTo, r.resourceId, r.nonce, opts.amount ?? BigInt(r.price)],
  });
  await chain.publicClient.waitForTransactionReceipt({ hash });
  const paymentId = computePaymentId({ payer: w.account.address, payTo: opts.payTo ?? r.payTo, resourceId: r.resourceId, nonce: r.nonce });
  const signature = await w.walletClient.signMessage({
    message: proofMessage({ chainId: r.chainId, gate: r.gate, resource: r.resource, paymentId }),
  });
  const terms = { price: r.price, calls: r.calls, validFor: r.validFor, expiry: r.expiry, salt: r.salt };
  return { hash, paymentId, signature, terms, nonce: r.nonce, header: encodeProof({ v: 1, nonce: r.nonce, txHash: hash, signature, terms }) };
}

async function challenge(path: string): Promise<{ r: PaymentRequirements; res: Response }> {
  const res = await fetch(base + path);
  expect(res.status).toBe(402);
  const body = (await res.json()) as GateErrorBody;
  return { r: body.requirements!, res };
}

async function withProof(path: string, header: string, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers: { [HEADERS.proof]: header, ...extra } });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { res, json: json as any };
}

beforeAll(async () => {
  chain = await startChain();
  seller = (await wallet(0n)).account.address;
  sharedStore = new MemoryStore(now);

  const app = express();
  app.use(express.json());
  app.get("/one", wifGate(cfg("one")), (req: any, res) => res.json({ data: "one", paymentId: req.wifgate.paymentId }));
  app.get("/three", wifGate(cfg("three", { calls: 3, validFor: 60 })), (_req, res) => res.json({ data: "three" }));
  app.get("/short", wifGate(cfg("short", { calls: 3, validFor: 5, now: () => Math.floor(Date.now() / 1000) })), (_req, res) => res.json({ data: "short" }));
  app.get("/other", wifGate(cfg("other")), (_req, res) => res.json({ data: "other" }));
  app.get("/cheap", wifGate(cfg("cheap", { price: ONE })), (_req, res) => res.json({ data: "cheap" }));
  app.get("/dynamic", wifGate(cfg("dynamic", { price: (r: { url: string }) => (new URL(r.url, "http://x").searchParams.get("big") ? 8n * ONE : 2n * ONE) })), (_req, res) => res.json({ data: "dynamic" }));
  app.get("/flaky", wifGate(cfg("flaky")), (_req, res) => {
    if (failNext) { failNext = false; res.status(500).json({ error: "boom" }); return; }
    res.json({ data: "flaky" });
  });
  app.post("/echo", wifGate(cfg("echo")), (req, res) => res.json({ got: req.body }));
  app.get("/shared-a", wifGate(cfg("shared", { store: sharedStore })), (_req, res) => res.json({ data: "a" }));
  app.get("/shared-b", wifGate(cfg("shared", { store: sharedStore })), (_req, res) => res.json({ data: "b" }));
  app.get("/otherkey", wifGate(cfg("shared", { store: sharedStore, secret: "a-completely-different-secret-value" })), (_req, res) => res.json({ data: "x" }));
  app.get("/free402", (_req, res) => res.status(402).json({ hello: "not wifgate" }));
  app.get("/evil", (_req, res) => {
    // A malicious server naming a gate contract the client never configured.
    const nonce = `0x${"11".repeat(32)}`;
    res.status(402).json({
      error: "payment_required", message: "pay", retryable: false,
      requirements: {
        scheme: "wifgate-v1", chainId: 31337, gate: "0x00000000000000000000000000000000000000AA",
        token: chain.wif, payTo: seller, resource: "evil", resourceId: resourceIdOf("evil"),
        price: PRICE.toString(), calls: 1, validFor: 60, burnBps: 200,
        expiry: Math.floor(Date.now() / 1000) + 300, salt: `0x${"22".repeat(16)}`, nonce,
      },
    });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  chain?.stop();
});

describe("happy path", () => {
  it("returns a well-formed 402 challenge to unpaid callers", async () => {
    const { r, res } = await challenge("/one");
    expect(r).toMatchObject({
      scheme: "wifgate-v1", chainId: 31337, gate: getAddress(chain.gate), token: getAddress(chain.wif),
      payTo: getAddress(seller), resource: "one", price: PRICE.toString(), calls: 1, burnBps: 200,
    });
    expect(r.resourceId).toBe(resourceIdOf("one"));
    expect(r.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.headers.get(HEADERS.requirements)).toBeTruthy();
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("every challenge is unique", async () => {
    const a = (await challenge("/one")).r;
    const b = (await challenge("/one")).r;
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.salt).not.toBe(b.salt);
  });

  it("pays, burns 2%, pays the seller 98% and serves the response", async () => {
    const c = await client();
    const sellerBefore = await balanceOf(seller);
    const deadBefore = await balanceOf(BURN_ADDRESS);
    const totalBefore = await chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalBurned" });

    const res = await c.wf(base + "/one");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBe("one");

    expect(c.wf.spent).toBe(PRICE);
    expect(c.wf.history).toHaveLength(1);
    expect(c.wf.history[0]!.burned).toBe((PRICE * 200n) / 10_000n);
    expect(await balanceOf(seller) - sellerBefore).toBe(PRICE - (PRICE * 200n) / 10_000n);
    expect(await balanceOf(BURN_ADDRESS) - deadBefore).toBe((PRICE * 200n) / 10_000n);
    const totalAfter = await chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalBurned" });
    expect(totalAfter - totalBefore).toBe((PRICE * 200n) / 10_000n);
    expect(res.headers.get(HEADERS.payer)).toBe(getAddress(c.account.address));
    expect(res.headers.get(HEADERS.payment)).toBe(body.paymentId);
    expect(await balanceOf(chain.gate)).toBe(0n);
  });

  it("emits progress events in protocol order", async () => {
    const types: string[] = [];
    const c = await client({ onEvent: (e: { type: string }) => types.push(e.type) });
    await c.wf(base + "/cheap");
    expect(types).toEqual(["challenge", "approving", "approved", "paying", "paid", "signed", "redeemed"]);
    // an observer that throws must not break the payment
    const c2 = await client({ onEvent: () => { throw new Error("observer bug"); } });
    expect((await c2.wf(base + "/cheap")).status).toBe(200);
  });

  it("quote() reports the price without paying", async () => {
    const c = await client();
    const q = await c.wf.quote(base + "/one");
    expect(q?.price).toBe(PRICE.toString());
    expect(c.wf.spent).toBe(0n);
    expect(await c.wf.quote(base + "/nonexistent")).toBeNull();
  });

  it("uses dynamic pricing", async () => {
    const c = await client();
    expect((await c.wf.quote(base + "/dynamic"))?.price).toBe((2n * ONE).toString());
    expect((await c.wf.quote(base + "/dynamic?big=1"))?.price).toBe((8n * ONE).toString());
    const res = await c.wf(base + "/dynamic?big=1");
    expect(res.status).toBe(200);
    expect(c.wf.spent).toBe(8n * ONE);
  });

  it("keeps request bodies intact across the 402 retry", async () => {
    const c = await client();
    const res = await c.wf(base + "/echo", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "hello", n: [1, 2, 3] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { q: "hello", n: [1, 2, 3] } });
  });

  it("passes through 402s that are not WifGate", async () => {
    const c = await client();
    const res = await c.wf(base + "/free402");
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ hello: "not wifgate" });
    expect(c.wf.spent).toBe(0n);
  });
});

describe("credits and sessions", () => {
  it("one payment buys several calls, then pays again", async () => {
    const c = await client();
    const remaining: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await c.wf(base + "/three");
      expect(res.status).toBe(200);
      remaining.push(res.headers.get(HEADERS.credits)!);
    }
    expect(remaining).toEqual(["2", "1", "0", "2"]);
    expect(c.wf.history).toHaveLength(2);
    expect(c.wf.spent).toBe(2n * PRICE);
  });

  it("parallel calls on a multi-call route share one payment", async () => {
    const c = await client();
    const results = await Promise.all(Array.from({ length: 3 }, () => c.wf(base + "/three")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(c.wf.history).toHaveLength(1);
  });

  it("parallel calls on a single-call route pay once each", async () => {
    const c = await client();
    const results = await Promise.all(Array.from({ length: 4 }, () => c.wf(base + "/cheap")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(c.wf.history).toHaveLength(4);
    expect(new Set(c.wf.history.map((h) => h.paymentId)).size).toBe(4);
  });

  it("credits expire after validFor and the client transparently pays again", async () => {
    const c = await client();
    expect((await c.wf(base + "/short")).status).toBe(200);
    expect((await c.wf(base + "/short")).status).toBe(200); // still inside the window, no new payment
    expect(c.wf.history).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 6500));
    const res = await c.wf(base + "/short");
    expect(res.status).toBe(200);
    expect(c.wf.history).toHaveLength(2);
  });

  it("rejects forged, truncated and cross-route session tokens", async () => {
    const c = await client();
    const res = await c.wf(base + "/three");
    expect(res.status).toBe(200);
    const token = res.headers.get(HEADERS.session)!;
    expect(token).toBeTruthy();

    const ok = await fetch(base + "/three", { headers: { [HEADERS.session]: token } });
    expect(ok.status).toBe(200);

    const forged = token.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
    const bad1 = await fetch(base + "/three", { headers: { [HEADERS.session]: forged } });
    expect(bad1.status).toBe(402);
    expect(((await bad1.json()) as GateErrorBody).error).toBe("session_invalid");

    const bad2 = await fetch(base + "/other", { headers: { [HEADERS.session]: token } }); // other route
    expect(bad2.status).toBe(402);
    expect(((await bad2.json()) as GateErrorBody).error).toBe("session_invalid");

    const bad3 = await fetch(base + "/three", { headers: { [HEADERS.session]: "garbage" } });
    expect(((await bad3.json()) as GateErrorBody).error).toBe("session_invalid");
  });

  it("refunds the credit when the handler fails, and resumes without paying again", async () => {
    const c = await client();
    failNext = true;
    const r1 = await c.wf(base + "/flaky");
    expect(r1.status).toBe(500);
    const r2 = await c.wf(base + "/flaky");
    expect(r2.status).toBe(200);
    expect(c.wf.history).toHaveLength(1); // only one payment for two attempts
    expect(c.wf.spent).toBe(PRICE);
  });
});

describe("attacks on the proof", () => {
  it("replaying a spent proof is refused", async () => {
    const c = await client();
    await c.wf(base + "/one");
    const { json, res } = await withProof("/one", c.proofs[0]!);
    expect(res.status).toBe(402);
    expect(json.error).toBe("credits_exhausted");
    expect(json.requirements).toBeTruthy(); // gives a fresh challenge to pay properly
  });

  it("a stolen tx hash is useless without the payer's signature", async () => {
    const victim = await wallet();
    const attacker = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(victim, r);

    const forgedSig = await attacker.walletClient.signMessage({
      message: proofMessage({ chainId: r.chainId, gate: r.gate, resource: r.resource, paymentId: paid.paymentId }),
    });
    const header = encodeProof({ v: 1, nonce: paid.nonce, txHash: paid.hash, signature: forgedSig, terms: paid.terms });
    const { res, json } = await withProof("/one", header);
    expect(res.status).toBe(402);
    expect(json.error).toBe("bad_signature");

    // The real payer can still redeem.
    const good = await withProof("/one", paid.header);
    expect(good.res.status).toBe(200);
  });

  it("a signature over a different message is refused", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(w, r);
    const sig = await w.walletClient.signMessage({ message: "something else" });
    const { json } = await withProof("/one", encodeProof({ v: 1, nonce: paid.nonce, txHash: paid.hash, signature: sig, terms: paid.terms }));
    expect(json.error).toBe("bad_signature");
  });

  it("underpaying is refused", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(w, r, { amount: PRICE - 1n });
    const { json, res } = await withProof("/one", paid.header);
    expect(res.status).toBe(402);
    expect(json.error).toBe("underpaid");
  });

  it("overpaying is accepted", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(w, r, { amount: PRICE * 3n });
    const { res } = await withProof("/one", paid.header);
    expect(res.status).toBe(200);
  });

  it("a payment for one route cannot unlock another", async () => {
    const w = await wallet();
    const { r } = await challenge("/cheap");
    const paid = await manualPay(w, r);
    const { json } = await withProof("/one", paid.header); // /one costs more and has another nonce
    expect(json.error).toBe("bad_challenge");
  });

  it("paying someone else instead of the seller does not count", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const other = (await wallet(0n)).account.address;
    const paid = await manualPay(w, r, { payTo: other });
    const { json } = await withProof("/one", paid.header);
    expect(json.error).toBe("wrong_payment");
  });

  it("tampered terms are refused (price lowered)", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(w, r);
    const tampered = { ...paid.terms, price: "1" };
    const { json } = await withProof("/one", encodeProof({ v: 1, nonce: paid.nonce, txHash: paid.hash, signature: paid.signature, terms: tampered }));
    expect(json.error).toBe("bad_challenge");
  });

  it("tampered terms are refused (more calls)", async () => {
    const w = await wallet();
    const { r } = await challenge("/three");
    const paid = await manualPay(w, r);
    const tampered = { ...paid.terms, calls: 1000 };
    const { json } = await withProof("/three", encodeProof({ v: 1, nonce: paid.nonce, txHash: paid.hash, signature: paid.signature, terms: tampered }));
    expect(json.error).toBe("bad_challenge");
  });

  it("expired challenges are refused", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(w, r);
    clock.t += 10_000;
    try {
      const { json } = await withProof("/one", paid.header);
      expect(json.error).toBe("challenge_expired");
    } finally {
      clock.t -= 10_000;
    }
  });

  it("an unknown transaction is retryable, not fatal", async () => {
    const w = await wallet();
    const { r } = await challenge("/one");
    const paid = await manualPay(w, r);
    const header = encodeProof({ v: 1, nonce: paid.nonce, txHash: `0x${"ab".repeat(32)}`, signature: paid.signature, terms: paid.terms });
    const { res, json } = await withProof("/one", header);
    expect(res.status).toBe(402);
    expect(json.error).toBe("receipt_not_found");
    expect(json.retryable).toBe(true);
  });

  it("a reverted transaction is refused", async () => {
    const w = await wallet(0n); // no WIF: the pay() call reverts on-chain
    const { r } = await challenge("/one");
    const approve = await w.walletClient.writeContract({ address: chain.wif, abi: erc20Abi, functionName: "approve", args: [chain.gate, 1n], chain: chain.chain });
    await chain.publicClient.waitForTransactionReceipt({ hash: approve });
    // Force a mined revert by sending the tx with an explicit gas limit (skips simulation).
    const hash = await w.walletClient.writeContract({
      address: chain.gate, abi: wifGateAbi, functionName: "pay", chain: chain.chain, gas: 300_000n,
      args: [r.payTo, r.resourceId, r.nonce, BigInt(r.price)],
    });
    const rc = await chain.publicClient.waitForTransactionReceipt({ hash });
    expect(rc.status).toBe("reverted");
    const terms = { price: r.price, calls: r.calls, validFor: r.validFor, expiry: r.expiry, salt: r.salt };
    const sig = await w.walletClient.signMessage({ message: "x" });
    const { json } = await withProof("/one", encodeProof({ v: 1, nonce: r.nonce, txHash: hash, signature: sig, terms }));
    expect(json.error).toBe("tx_failed");
  });

  it("malformed proofs get 400, not a challenge", async () => {
    const { res, json } = await withProof("/one", "not-a-proof");
    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_proof");
  });
});

describe("multiple server instances", () => {
  it("a shared store makes redemption exactly-once across instances", async () => {
    const w = await wallet();
    const { r } = await challenge("/shared-a");
    const paid = await manualPay(w, r);
    const first = await withProof("/shared-a", paid.header);
    expect(first.res.status).toBe(200);
    // Same proof against another instance (same secret, same store) must not get a second credit.
    const second = await withProof("/shared-b", paid.header);
    expect(second.res.status).toBe(402);
    expect(second.json.error).toBe("credits_exhausted");
  });

  it("a challenge from one secret is not honoured by another", async () => {
    const w = await wallet();
    const { r } = await challenge("/shared-a");
    const paid = await manualPay(w, r);
    const { json } = await withProof("/otherkey", paid.header);
    expect(json.error).toBe("bad_challenge");
  });
});

describe("client safety", () => {
  it("refuses a gate contract it does not trust, spending nothing", async () => {
    const c = await client();
    await expect(c.wf(base + "/evil")).rejects.toBeInstanceOf(UntrustedChallengeError);
    expect(c.wf.spent).toBe(0n);
    expect(await balanceOf(c.account.address)).toBe(1000n * ONE);
  });

  it("enforces maxPricePerCall", async () => {
    const c = await client({ maxPricePerCall: PRICE - 1n });
    await expect(c.wf(base + "/one")).rejects.toBeInstanceOf(PaymentLimitError);
    expect(c.wf.spent).toBe(0n);
  });

  it("enforces maxTotalSpend across calls", async () => {
    const c = await client({ maxTotalSpend: 2n * PRICE });
    expect((await c.wf(base + "/one")).status).toBe(200);
    expect((await c.wf(base + "/one")).status).toBe(200);
    await expect(c.wf(base + "/one")).rejects.toBeInstanceOf(PaymentLimitError);
    expect(c.wf.spent).toBe(2n * PRICE);
  });

  it("does not pay when the wallet lacks $WIF", async () => {
    const poor = await wallet(1n);
    const c = await client({}, poor);
    await expect(c.wf(base + "/one")).rejects.toBeInstanceOf(InsufficientWifError);
    expect(c.wf.spent).toBe(0n);
  });

  it("approves only the exact price by default", async () => {
    const c = await client();
    await c.wf(base + "/one");
    const allowance = await chain.publicClient.readContract({
      address: chain.wif, abi: erc20Abi, functionName: "allowance", args: [c.account.address, chain.gate],
    });
    expect(allowance).toBe(0n); // consumed by the payment
  });

  it("supports an unlimited-approval mode for agents", async () => {
    const c = await client({ approve: "unlimited" });
    await c.wf(base + "/one");
    await c.wf(base + "/one");
    const allowance = await chain.publicClient.readContract({
      address: chain.wif, abi: erc20Abi, functionName: "allowance", args: [c.account.address, chain.gate],
    });
    expect(allowance).toBeGreaterThan(10n ** 30n);
  });

  it("rejects construction without a positive spending cap", async () => {
    const w = await wallet();
    expect(() => createWifFetch({
      walletClient: w.walletClient, publicClient: chain.publicClient, gate: chain.gate, token: chain.wif, maxPricePerCall: 0n,
    })).toThrow();
  });
});

describe("web-standard adapter", () => {
  it("works end to end with Request/Response handlers", async () => {
    const handler = withWifGate(cfg("web"), async (req, payment) =>
      Response.json({ hi: new URL(req.url).searchParams.get("name"), payer: payment.payer }),
    );
    const w = await wallet();
    const wf = createWifFetch({
      walletClient: w.walletClient, publicClient: chain.publicClient, gate: chain.gate, token: chain.wif, maxPricePerCall: 10n * ONE,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch,
    });
    const res = await wf("http://web.test/api/hello?name=wif");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: "wif", payer: getAddress(w.account.address) });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(wf.spent).toBe(PRICE);
  });

  it("refunds on 5xx and on thrown errors", async () => {
    let mode: "ok" | "500" | "throw" = "500";
    const handler = withWifGate(cfg("web-fail"), async () => {
      if (mode === "500") return new Response("nope", { status: 500 });
      if (mode === "throw") throw new Error("boom");
      return Response.json({ ok: true });
    });
    const w = await wallet();
    const wf = createWifFetch({
      walletClient: w.walletClient, publicClient: chain.publicClient, gate: chain.gate, token: chain.wif, maxPricePerCall: 10n * ONE,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch,
    });
    expect((await wf("http://web.test/a")).status).toBe(500);
    mode = "throw";
    await expect(wf("http://web.test/a")).rejects.toThrow("boom"); // credit refunded, proof kept
    mode = "ok";
    expect((await wf("http://web.test/a")).status).toBe(200);
    expect(wf.history).toHaveLength(1);
  });
});

describe("browser-wallet style (JSON-RPC account)", () => {
  it("pays and proves through an EIP-1193 provider, like MetaMask would", async () => {
    // anvil keeps its dev accounts unlocked, so it signs transactions and personal_sign itself.
    // The wallet client only knows an address, exactly like a connected browser wallet.
    let rpcId = 0;
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const res = await fetch(chain.rpcUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params ?? [] }),
        });
        const j = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (j.error) throw new Error(j.error.message);
        return j.result;
      },
    };
    const addr = chain.deployer.address;
    const mint = await createWalletClient({ account: chain.deployer, chain: chain.chain, transport: http(chain.rpcUrl) })
      .writeContract({ address: chain.wif, abi: chain.wifAbi, functionName: "mint", args: [addr, 100n * ONE] });
    await chain.publicClient.waitForTransactionReceipt({ hash: mint });

    const walletClient = createWalletClient({ account: addr, chain: chain.chain, transport: custom(provider) });
    const events: string[] = [];
    const wf = createWifFetch({
      walletClient, publicClient: chain.publicClient, gate: chain.gate, token: chain.wif,
      maxPricePerCall: 10n * ONE, onEvent: (e) => events.push(e.type),
    });
    const res = await wf(base + "/cheap");
    expect(res.status).toBe(200);
    expect(res.headers.get(HEADERS.payer)).toBe(getAddress(addr));
    expect(events).toContain("paid");
    expect(wf.spent).toBe(ONE);
  });
});

describe("configuration", () => {
  it("fails closed on weak configuration", () => {
    const good = cfg("x");
    expect(() => createGate({ ...good, secret: "short" })).toThrow(/16 bytes/);
    expect(() => createGate({ ...good, resource: "" })).toThrow();
    expect(() => createGate({ ...good, calls: 0 })).toThrow();
    expect(() => createGate({ ...good, calls: 3, validFor: 0 })).toThrow(/validFor/);
    expect(() => createGate({ ...good, challengeTtl: 1 })).toThrow();
    expect(() => createGate({ ...good, confirmations: 0 })).toThrow();
  });

  /** Issue a challenge from `g` itself, pay it, and return a proof header `g` will accept as authentic. */
  async function proofFor(g: ReturnType<typeof createGate>) {
    const r = await g.challenge({ method: "GET", url: "/", header: () => null });
    const paid = await manualPay(await wallet(), r);
    return paid.header;
  }

  it("fails loudly when the configured token is not the gate's token", async () => {
    const g = createGate({ ...cfg("misconfigured"), token: "0x00000000000000000000000000000000000000aa" });
    const header = await proofFor(g);
    await expect(
      g.check({ method: "GET", url: "/", header: (n) => (n === HEADERS.proof ? header : null) }),
    ).rejects.toThrow(/uses token/);
  });

  it("fails loudly when the RPC is on a different chain than configured", async () => {
    const g = createGate({ ...cfg("wrongchain"), chain: { ...chain.chain, id: 999 } });
    const header = await proofFor(g);
    await expect(
      g.check({ method: "GET", url: "/", header: (n) => (n === HEADERS.proof ? header : null) }),
    ).rejects.toThrow(/chain/);
  });

  it("rejects non-positive prices at challenge time", async () => {
    const g = createGate({ ...cfg("zero"), price: 0n });
    await expect(g.challenge({ method: "GET", url: "/", header: () => null })).rejects.toThrow(/positive/);
  });
});

describe("accounting", () => {
  it("contract totals match what the tests paid", async () => {
    const [volume, burned, payments] = await Promise.all([
      chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalVolume" }),
      chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalBurned" }),
      chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalPayments" }),
    ]);
    expect(burned).toBe((volume * 200n) / 10_000n);
    expect(payments).toBeGreaterThan(10n);
    expect(await balanceOf(chain.gate)).toBe(0n);
    expect(await balanceOf(BURN_ADDRESS)).toBe(burned);
  });
});
