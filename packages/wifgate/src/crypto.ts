// Small WebCrypto helpers shared by server and tests. Works in Node >= 20, browsers and edge runtimes.
import { bytesToHex, hexToBytes, type Hex } from "viem";

const encoder = new TextEncoder();

export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message) as BufferSource);
  return new Uint8Array(mac);
}

export async function hmacHex(key: Uint8Array, message: string): Promise<Hex> {
  return bytesToHex(await hmacSha256(key, message));
}

/** Constant-time comparison of two equal-intent hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes: number): Hex {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function toKey(secret: string | Uint8Array): Uint8Array {
  return typeof secret === "string" ? encoder.encode(secret) : secret;
}

export function base64urlEncode(text: string): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export { hexToBytes };
