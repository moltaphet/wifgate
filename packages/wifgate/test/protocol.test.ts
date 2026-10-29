import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import {
  computePaymentId,
  decodeProof,
  encodeProof,
  nonceInput,
  parseRequirements,
  proofMessage,
  resourceIdOf,
} from "../src/protocol.js";
import { base64urlDecode, base64urlEncode, timingSafeEqualHex } from "../src/crypto.js";
import type { PaymentProof } from "../src/types.js";

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;
const H32 = `0x${"ab".repeat(32)}` as const;
const SALT = `0x${"cd".repeat(16)}` as const;

const proof = (): PaymentProof => ({
  v: 1,
  nonce: H32,
  txHash: H32,
  signature: `0x${"11".repeat(65)}`,
  terms: { price: "5000000000000000000", calls: 3, validFor: 300, expiry: 1_900_000_000, salt: SALT },
});

describe("protocol", () => {
  it("resourceIdOf is keccak256(utf8)", () => {
    expect(resourceIdOf("weather")).toBe(keccak256(stringToBytes("weather")));
  });

  it("computePaymentId depends on every field", () => {
    const base = { payer: A, payTo: B, resourceId: H32, nonce: H32 } as const;
    const id = computePaymentId(base);
    expect(computePaymentId({ ...base, payer: B })).not.toBe(id);
    expect(computePaymentId({ ...base, payTo: A })).not.toBe(id);
    expect(computePaymentId({ ...base, resourceId: `0x${"00".repeat(32)}` })).not.toBe(id);
    expect(computePaymentId({ ...base, nonce: `0x${"00".repeat(32)}` })).not.toBe(id);
  });

  it("proofMessage is stable and binds chain, gate, resource and payment", () => {
    const m = proofMessage({ chainId: 4663, gate: A, resource: "weather", paymentId: H32 });
    expect(m).toContain("chain: 4663");
    expect(m).toContain("resource: weather");
    expect(m).toContain(H32);
    expect(proofMessage({ chainId: 1, gate: A, resource: "weather", paymentId: H32 })).not.toBe(m);
  });

  it("nonceInput binds all terms", () => {
    const args = { chainId: 1, gate: A, payTo: B, resourceId: H32, terms: proof().terms };
    const base = nonceInput(args);
    expect(nonceInput({ ...args, terms: { ...args.terms, price: "1" } })).not.toBe(base);
    expect(nonceInput({ ...args, terms: { ...args.terms, calls: 4 } })).not.toBe(base);
    expect(nonceInput({ ...args, terms: { ...args.terms, validFor: 1 } })).not.toBe(base);
    expect(nonceInput({ ...args, terms: { ...args.terms, expiry: 1 } })).not.toBe(base);
    expect(nonceInput({ ...args, payTo: A })).not.toBe(base);
    expect(nonceInput({ ...args, gate: B })).not.toBe(base);
    expect(nonceInput({ ...args, chainId: 2 })).not.toBe(base);
  });

  it("proof round-trips", () => {
    expect(decodeProof(encodeProof(proof()))).toEqual(proof());
  });

  it.each([
    ["not base64", "!!!"],
    ["not json", base64urlEncode("hello")],
    ["array", base64urlEncode("[]")],
    ["wrong version", base64urlEncode(JSON.stringify({ ...proof(), v: 2 }))],
    ["missing nonce", base64urlEncode(JSON.stringify({ ...proof(), nonce: undefined }))],
    ["short txHash", base64urlEncode(JSON.stringify({ ...proof(), txHash: "0x12" }))],
    ["non-hex signature", base64urlEncode(JSON.stringify({ ...proof(), signature: "zz" }))],
    ["zero price", base64urlEncode(JSON.stringify({ ...proof(), terms: { ...proof().terms, price: "0" } }))],
    ["negative price", base64urlEncode(JSON.stringify({ ...proof(), terms: { ...proof().terms, price: "-5" } }))],
    ["float calls", base64urlEncode(JSON.stringify({ ...proof(), terms: { ...proof().terms, calls: 1.5 } }))],
    ["zero calls", base64urlEncode(JSON.stringify({ ...proof(), terms: { ...proof().terms, calls: 0 } }))],
    ["string expiry", base64urlEncode(JSON.stringify({ ...proof(), terms: { ...proof().terms, expiry: "1" } }))],
    ["short salt", base64urlEncode(JSON.stringify({ ...proof(), terms: { ...proof().terms, salt: "0x12" } }))],
    ["huge header", "a".repeat(5000)],
  ])("decodeProof rejects %s", (_n, header) => {
    expect(() => decodeProof(header)).toThrow();
  });

  it("parseRequirements validates and normalises", () => {
    const raw = {
      scheme: "wifgate-v1", chainId: 4663, gate: A.toLowerCase(), token: A, payTo: B,
      resource: "weather", resourceId: H32, price: "5", calls: 1, validFor: 300, burnBps: 200,
      expiry: 1_900_000_000, salt: SALT, nonce: H32,
    };
    const r = parseRequirements(raw);
    expect(r.gate).toBe("0x1111111111111111111111111111111111111111");
    expect(() => parseRequirements({ ...raw, scheme: "x402" })).toThrow();
    expect(() => parseRequirements({ ...raw, gate: "nope" })).toThrow();
    expect(() => parseRequirements({ ...raw, price: "0" })).toThrow();
    expect(() => parseRequirements({ ...raw, nonce: "0x1" })).toThrow();
    expect(() => parseRequirements(null)).toThrow();
  });

  it("base64url and timingSafeEqualHex behave", () => {
    const s = "héllo ✓ wörld";
    expect(base64urlDecode(base64urlEncode(s))).toBe(s);
    expect(() => base64urlDecode("a+b")).toThrow();
    expect(timingSafeEqualHex("0xab", "0xab")).toBe(true);
    expect(timingSafeEqualHex("0xab", "0xac")).toBe(false);
    expect(timingSafeEqualHex("0xab", "0xabc")).toBe(false);
  });
});
