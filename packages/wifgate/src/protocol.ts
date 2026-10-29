import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { PROTOCOL } from "./constants.js";
import { base64urlDecode, base64urlEncode } from "./crypto.js";
import type { PaymentProof, PaymentRequirements, ProofTerms } from "./types.js";

/** `keccak256(utf8(resource))` - the id stored on-chain for a route. */
export function resourceIdOf(resource: string): Hex {
  return keccak256(stringToBytes(resource));
}

/**
 * Same formula as `WifGate.computePaymentId`:
 * `keccak256(abi.encode(payer, payTo, resourceId, nonce))`.
 */
export function computePaymentId(args: {
  payer: Address;
  payTo: Address;
  resourceId: Hex;
  nonce: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [args.payer, args.payTo, args.resourceId, args.nonce],
    ),
  );
}

/** The exact string the payer signs. Binds the proof to this payment and this deployment. */
export function proofMessage(args: {
  chainId: number;
  gate: Address;
  resource: string;
  paymentId: Hex;
}): string {
  return [
    "WifGate access proof",
    `chain: ${args.chainId}`,
    `gate: ${getAddress(args.gate)}`,
    `resource: ${args.resource}`,
    `payment: ${args.paymentId.toLowerCase()}`,
  ].join("\n");
}

/** The string the server MACs to derive the challenge nonce. Every field is bound. */
export function nonceInput(args: {
  chainId: number;
  gate: Address;
  payTo: Address;
  resourceId: Hex;
  terms: ProofTerms;
}): string {
  const { terms } = args;
  return [
    PROTOCOL,
    args.chainId,
    args.gate.toLowerCase(),
    args.payTo.toLowerCase(),
    args.resourceId.toLowerCase(),
    terms.price,
    terms.calls,
    terms.validFor,
    terms.expiry,
    terms.salt.toLowerCase(),
  ].join("|");
}

export const encodeRequirements = (r: PaymentRequirements): string =>
  base64urlEncode(JSON.stringify(r));

export const encodeProof = (p: PaymentProof): string => base64urlEncode(JSON.stringify(p));

const isUintString = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const isSafeUint = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const isHexN = (v: unknown, bytes: number): v is Hex =>
  typeof v === "string" && isHex(v, { strict: true }) && v.length === 2 + bytes * 2;

/** Parses and strictly validates an `x-wif-proof` header. Throws a plain Error on any problem. */
export function decodeProof(header: string): PaymentProof {
  if (header.length > 4096) throw new Error("proof too large");
  let raw: unknown;
  try {
    raw = JSON.parse(base64urlDecode(header));
  } catch {
    throw new Error("proof is not base64url-encoded JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("proof must be an object");
  const p = raw as Record<string, unknown>;
  const t = p.terms as Record<string, unknown> | undefined;

  if (p.v !== 1) throw new Error("unsupported proof version");
  if (!isHexN(p.txHash, 32)) throw new Error("txHash must be 32 bytes of hex");
  if (!isHexN(p.nonce, 32)) throw new Error("nonce must be 32 bytes of hex");
  if (typeof p.signature !== "string" || !isHex(p.signature, { strict: true }) || p.signature.length > 2 + 2 * 1024) {
    throw new Error("signature must be hex");
  }
  if (typeof t !== "object" || t === null) throw new Error("terms missing");
  if (!isUintString(t.price) || BigInt(t.price) === 0n) throw new Error("terms.price invalid");
  if (!isSafeUint(t.calls, 1_000_000) || t.calls < 1) throw new Error("terms.calls invalid");
  if (!isSafeUint(t.validFor, 365 * 24 * 3600)) throw new Error("terms.validFor invalid");
  if (!isSafeUint(t.expiry, 4_102_444_800)) throw new Error("terms.expiry invalid");
  if (!isHexN(t.salt, 16)) throw new Error("terms.salt must be 16 bytes of hex");

  return {
    v: 1,
    nonce: p.nonce,
    txHash: p.txHash,
    signature: p.signature as Hex,
    terms: { price: t.price, calls: t.calls, validFor: t.validFor, expiry: t.expiry, salt: t.salt },
  };
}

/** Parses a challenge received by a client (body or header). Throws on malformed input. */
export function parseRequirements(raw: unknown): PaymentRequirements {
  if (typeof raw !== "object" || raw === null) throw new Error("requirements must be an object");
  const r = raw as Record<string, unknown>;
  if (r.scheme !== PROTOCOL) throw new Error("unsupported scheme");
  if (!isSafeUint(r.chainId, 2 ** 31)) throw new Error("chainId invalid");
  for (const k of ["gate", "token", "payTo"] as const) {
    if (typeof r[k] !== "string" || !isAddress(r[k] as string, { strict: false })) {
      throw new Error(`${k} must be an address`);
    }
  }
  if (typeof r.resource !== "string" || r.resource.length === 0 || r.resource.length > 200) {
    throw new Error("resource invalid");
  }
  if (!isHexN(r.resourceId, 32) || !isHexN(r.nonce, 32) || !isHexN(r.salt, 16)) {
    throw new Error("resourceId/nonce/salt invalid");
  }
  if (!isUintString(r.price) || BigInt(r.price) === 0n) throw new Error("price invalid");
  if (!isSafeUint(r.calls, 1_000_000) || r.calls < 1) throw new Error("calls invalid");
  if (!isSafeUint(r.validFor, 365 * 24 * 3600)) throw new Error("validFor invalid");
  if (!isSafeUint(r.burnBps, 10_000)) throw new Error("burnBps invalid");
  if (!isSafeUint(r.expiry, 4_102_444_800)) throw new Error("expiry invalid");

  const out: PaymentRequirements = {
    scheme: PROTOCOL,
    chainId: r.chainId,
    gate: getAddress(r.gate as string),
    token: getAddress(r.token as string),
    payTo: getAddress(r.payTo as string),
    resource: r.resource,
    resourceId: r.resourceId,
    price: r.price,
    calls: r.calls,
    validFor: r.validFor,
    burnBps: r.burnBps,
    expiry: r.expiry,
    salt: r.salt,
    nonce: r.nonce,
  };
  if (typeof r.description === "string") out.description = r.description.slice(0, 500);
  return out;
}
