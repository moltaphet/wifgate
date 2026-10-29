import type { Address, Hex } from "viem";
import type { PROTOCOL } from "./constants.js";

/** What a 402 response asks the caller to do. All amounts are $WIF base units (18 decimals). */
export interface PaymentRequirements {
  scheme: typeof PROTOCOL;
  chainId: number;
  /** WifGate contract to call `pay` on. */
  gate: Address;
  /** The $WIF token. */
  token: Address;
  /** Seller wallet that is paid. */
  payTo: Address;
  /** Human-readable route name. */
  resource: string;
  /** `keccak256(resource)`. */
  resourceId: Hex;
  /** Gross price as a decimal string; `burnBps` of it is burned. */
  price: string;
  /** Calls granted by one payment. */
  calls: number;
  /** Seconds the credits stay valid after the payment. */
  validFor: number;
  burnBps: number;
  /** Unix seconds until which this challenge can be redeemed. */
  expiry: number;
  /** Random per-challenge value (hex) so two challenges never share a nonce. */
  salt: Hex;
  /** bytes32 the payer must pass to `pay`. Derived server-side with HMAC, unforgeable. */
  nonce: Hex;
  description?: string;
}

/** The server-issued terms a proof refers back to. */
export type ProofTerms = Pick<
  PaymentRequirements,
  "price" | "calls" | "validFor" | "expiry" | "salt"
>;

/** What the payer sends back in `x-wif-proof`: the issued terms plus the nonce that authenticates them. */
export interface PaymentProof {
  v: 1;
  /** The challenge nonce. The server recomputes it from `terms` before doing any chain lookups. */
  nonce: Hex;
  /** Transaction that called `WifGate.pay`. */
  txHash: Hex;
  /** `signMessage(proofMessage(...))` by the paying wallet; stops others reusing the tx hash. */
  signature: Hex;
  terms: ProofTerms;
}

export type GateErrorCode =
  | "payment_required"
  | "invalid_proof"
  | "challenge_expired"
  | "bad_challenge"
  | "receipt_not_found"
  | "not_confirmed"
  | "tx_failed"
  | "wrong_payment"
  | "underpaid"
  | "bad_signature"
  | "credits_exhausted"
  | "session_invalid"
  | "session_expired"
  | "rpc_unavailable";

/** JSON body of every non-2xx answer produced by the gate. */
export interface GateErrorBody {
  error: GateErrorCode;
  message: string;
  /** True when the same proof can simply be retried (e.g. the RPC has not seen the block yet). */
  retryable: boolean;
  /** A fresh challenge, present on every 402. */
  requirements?: PaymentRequirements;
}
