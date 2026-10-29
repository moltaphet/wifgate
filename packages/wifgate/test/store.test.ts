import { describe, expect, it } from "vitest";
import { GIVE_SCRIPT, MemoryStore, TAKE_SCRIPT, UpstashStore } from "../src/store.js";

describe("MemoryStore", () => {
  it("grants exactly once and counts credits", async () => {
    let t = 1000;
    const s = new MemoryStore(() => t);
    expect(await s.redeemAndGrant("p", 3, 60)).toBe(true);
    expect(await s.redeemAndGrant("p", 3, 60)).toBe(false);
    expect(await s.take("p")).toBe(2);
    expect(await s.take("p")).toBe(1);
    expect(await s.take("p")).toBe(0);
    expect(await s.take("p")).toBe(-1);
    await s.give("p");
    expect(await s.take("p")).toBe(0);
  });

  it("expires entries and allows re-grant only after expiry", async () => {
    let t = 1000;
    const s = new MemoryStore(() => t);
    await s.redeemAndGrant("p", 1, 10);
    t = 1011;
    expect(await s.take("p")).toBe(-1);
    expect(await s.redeemAndGrant("p", 1, 10)).toBe(true);
  });

  it("take on an unknown id is -1 and creates nothing", async () => {
    const s = new MemoryStore();
    expect(await s.take("nope")).toBe(-1);
    expect(await s.redeemAndGrant("nope", 1, 10)).toBe(true);
  });

  it("is atomic under concurrent redemption", async () => {
    const s = new MemoryStore();
    const results = await Promise.all(Array.from({ length: 50 }, () => s.redeemAndGrant("p", 1, 10)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

/** A tiny in-process Upstash REST fake that implements exactly the commands UpstashStore sends. */
function fakeUpstash() {
  const kv = new Map<string, { v: number; exp: number }>();
  const calls: unknown[][] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const cmd = JSON.parse(init.body as string) as (string | number)[];
    calls.push(cmd);
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth !== "Bearer tok") return new Response("unauthorized", { status: 401 });
    const [name] = cmd as [string];
    let result: unknown = null;
    if (name === "SET") {
      const [, key, val, nx] = cmd as [string, string, number, string];
      if (nx === "NX" && kv.has(key)) result = null;
      else { kv.set(key, { v: Number(val), exp: Number(cmd[5]) }); result = "OK"; }
    } else if (name === "EVAL") {
      const [, script, , key] = cmd as [string, string, number, string];
      const e = kv.get(key);
      if (script === TAKE_SCRIPT) {
        if (!e || e.v <= 0) result = -1; else { e.v -= 1; result = e.v; }
      } else if (script === GIVE_SCRIPT) {
        if (e) { e.v += 1; result = e.v; } else result = -1;
      } else return new Response(JSON.stringify({ error: "unknown script" }), { status: 200 });
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  }) as typeof fetch;
  return { f, kv, calls };
}

describe("UpstashStore", () => {
  it("behaves like MemoryStore over the REST protocol", async () => {
    const { f, kv } = fakeUpstash();
    const s = new UpstashStore({ url: "http://upstash.test", token: "tok", fetch: f });
    expect(await s.redeemAndGrant("0xAB", 2, 30)).toBe(true);
    expect(await s.redeemAndGrant("0xab", 2, 30)).toBe(false); // keys are case-insensitive
    expect(await s.take("0xab")).toBe(1);
    expect(await s.take("0xab")).toBe(0);
    expect(await s.take("0xab")).toBe(-1);
    await s.give("0xab");
    expect(await s.take("0xab")).toBe(0);
    expect([...kv.keys()]).toEqual(["wifgate:c:0xab"]);
  });

  it("never creates keys for unknown ids", async () => {
    const { f, kv } = fakeUpstash();
    const s = new UpstashStore({ url: "http://upstash.test", token: "tok", fetch: f });
    expect(await s.take("0xzz")).toBe(-1);
    await s.give("0xzz");
    expect(kv.size).toBe(0);
    expect(await s.redeemAndGrant("0xzz", 1, 10)).toBe(true);
  });

  it("sends a positive integer EX and surfaces HTTP errors", async () => {
    const { f, calls } = fakeUpstash();
    const s = new UpstashStore({ url: "http://upstash.test", token: "tok", fetch: f });
    await s.redeemAndGrant("0x1", 1, 0.2);
    expect(calls[0]).toEqual(["SET", "wifgate:c:0x1", 1, "NX", "EX", 1]);
    const bad = new UpstashStore({ url: "http://upstash.test", token: "wrong", fetch: f });
    await expect(bad.take("0x1")).rejects.toThrow(/HTTP 401/);
  });
});
