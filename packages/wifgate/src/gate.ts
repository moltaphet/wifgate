import {
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { wifGateAbi } from "./abi.js";
import {
  BURN_BPS,
  HEADERS,
  PROTOCOL,
  ROBINHOOD_RPC_URL,
  WIF_ADDRESS,
  robinhoodChain,
} from "./constants.js";
import { hmacHex, randomHex, timingSafeEqualHex, toKey } from "./crypto.js";
import {
  computePaymentId,
  decodeProof,
  encodeRequirements,
  nonceInput,
  proofMessage,
  resourceIdOf,
} from "./protocol.js";
import { MemoryStore, type GateStore } from "./store.js";
import type { GateErrorBody, GateErrorCode, PaymentRequirements, ProofTerms } from "./types.js";

/** Minimal request view the gate needs; adapters build it from Express / fetch requests. */
export interface GateRequestInfo {
  method: string;
  url: string;
  header(name: string): string | null | undefined;
}

export interface GateConfig {
  /** Wallet that receives the payments (net of the burn). */
  payTo: Address;
  /** Stable route name, e.g. "weather". Changing it invalidates outstanding challenges. */
  resource: string;
  /** Gross price in $WIF base units (18 decimals). `BURN_BPS` of it is burned. May depend on the request. */
  price: bigint | ((req: GateRequestInfo) => bigint | Promise<bigint>);
  /** Deployed WifGate contract. */
  gate: Address;
  /** Secret for stateless challenges. At least 16 bytes; keep it identical across instances. */
  secret: string | Uint8Array;
  /** Calls one payment buys (default 1). */
  calls?: number;
  /** Seconds the credits last after payment (default 300). */
  validFor?: number;
  /** How long a challenge can be paid and redeemed (default 300 s). */
  challengeTtl?: number;
  /** Extra seconds after expiry in which a proof is still accepted (default 60). */
  graceSeconds?: number;
  /** Blocks (including the payment's) required before serving (default 1). */
  confirmations?: number;
  description?: string;
  /** Defaults to MemoryStore. Use UpstashStore or your own for multi-instance deployments. */
  store?: GateStore;
  /** Chain to talk to (default Robinhood Chain). */
  chain?: Chain;
  rpcUrl?: string;
  /** Bring your own client instead of `chain`/`rpcUrl`. */
  publicClient?: PublicClient;
  /** $WIF address (default mainnet WIF). */
  token?: Address;
  /** Unix-seconds clock, injectable for tests. */
  now?: () => number;
}

export type GateOutcome =
  | {
      ok: true;
      paymentId: Hex;
      /** Wallet that paid; undefined when the call was authorised by a session token. */
      payer?: Address;
      /** Credits left after this call. */
      remaining: number;
      /** Headers to add to the successful response. */
      headers: Record<string, string>;
      /** Gives the credit back. Adapters call it when the handler fails with a 5xx. */
      refund: () => Promise<void>;
    }
  | {
      ok: false;
      status: 400 | 402 | 503;
      headers: Record<string, string>;
      body: GateErrorBody;
    };

type SessionResult =
  | { ok: true; outcome: Extract<GateOutcome, { ok: true }> }
  | { ok: false; code: GateErrorCode; message: string };

/** The gate is configured against the wrong chain or token. Fatal: surfaced as a 500, never as a 402. */
export class ConfigError extends Error {}

export class Gate {
  readonly config: Required<
    Pick<GateConfig, "calls" | "validFor" | "challengeTtl" | "graceSeconds" | "confirmations">
  > &
    GateConfig;
  readonly resourceId: Hex;
  readonly chainId: number;
  readonly client: PublicClient;
  private readonly key: Uint8Array;
  private readonly store: GateStore;
  private readonly token: Address;
  private readonly now: () => number;

  constructor(config: GateConfig) {
    const key = toKey(config.secret);
    if (key.length < 16) throw new Error("wifgate: `secret` must be at least 16 bytes");
    if (!config.resource) throw new Error("wifgate: `resource` is required");

    const calls = config.calls ?? 1;
    const validFor = config.validFor ?? 300;
    const challengeTtl = config.challengeTtl ?? 300;
    const graceSeconds = config.graceSeconds ?? 60;
    const confirmations = config.confirmations ?? 1;
    if (!Number.isInteger(calls) || calls < 1) throw new Error("wifgate: `calls` must be >= 1");
    if (!Number.isInteger(validFor) || validFor < 0) throw new Error("wifgate: bad `validFor`");
    if (calls > 1 && validFor < 5) {
      throw new Error("wifgate: multi-call routes need `validFor` >= 5 seconds (30+ recommended)");
    }
    if (!Number.isInteger(challengeTtl) || challengeTtl < 10) {
      throw new Error("wifgate: `challengeTtl` must be >= 10 seconds");
    }
    if (!Number.isInteger(graceSeconds) || graceSeconds < 0) throw new Error("wifgate: bad `graceSeconds`");
    if (!Number.isInteger(confirmations) || confirmations < 1) {
      throw new Error("wifgate: `confirmations` must be >= 1");
    }

    this.config = {
      ...config,
      payTo: getAddress(config.payTo),
      gate: getAddress(config.gate),
      calls,
      validFor,
      challengeTtl,
      graceSeconds,
      confirmations,
    };
    this.key = key;
    this.store = config.store ?? new MemoryStore(config.now);
    this.token = getAddress(config.token ?? WIF_ADDRESS);
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.resourceId = resourceIdOf(config.resource);

    const chain = config.chain ?? robinhoodChain;
    this.chainId = chain.id;
    this.client =
      config.publicClient ??
      (createPublicClient({
        chain,
        transport: http(config.rpcUrl ?? ROBINHOOD_RPC_URL),
      }) as PublicClient);
  }

  /** Decide whether a request may proceed. Never throws for caller mistakes; returns an outcome. */
  async check(req: GateRequestInfo): Promise<GateOutcome> {
    const session = req.header(HEADERS.session);
    const proof = req.header(HEADERS.proof);

    if (session) {
      const r = await this.useSession(session);
      if (r.ok) return r.outcome;
      if (!proof) return this.fail(req, r.code, r.message);
      // A bad session with a proof attached falls through: the proof may still be good.
    }
    if (proof) return this.redeemProof(req, proof);
    return this.fail(req, "payment_required", "Payment required: pay with $WIF to access this resource.");
  }

  private configChecked?: Promise<void>;

  /** One-time sanity check that chain id and token match the deployed gate, so a misconfigured seller fails loudly. */
  private verifyConfig(): Promise<void> {
    if (!this.configChecked) {
      const run = (async () => {
        const [id, wif] = await Promise.all([
          this.client.getChainId(),
          this.client.readContract({ address: this.config.gate, abi: wifGateAbi, functionName: "WIF" }),
        ]);
        if (id !== this.chainId) {
          throw new ConfigError(`wifgate: RPC is on chain ${id} but the gate is configured for chain ${this.chainId}`);
        }
        if (getAddress(wif) !== this.token) {
          throw new ConfigError(`wifgate: gate ${this.config.gate} uses token ${wif}, but \`token\` is ${this.token}`);
        }
      })();
      // Cache successes and ConfigErrors; retry after transient RPC failures.
      this.configChecked = run.catch((e) => {
        if (!(e instanceof ConfigError)) this.configChecked = undefined;
        throw e;
      });
    }
    return this.configChecked;
  }

  /** A fresh, unforgeable challenge for this route. */
  async challenge(req: GateRequestInfo): Promise<PaymentRequirements> {
    const price = typeof this.config.price === "function" ? await this.config.price(req) : this.config.price;
    if (typeof price !== "bigint" || price <= 0n) throw new Error("wifgate: price must be a positive bigint");

    const terms: ProofTerms = {
      price: price.toString(),
      calls: this.config.calls,
      validFor: this.config.validFor,
      expiry: this.now() + this.config.challengeTtl,
      salt: randomHex(16),
    };
    const nonce = await this.deriveNonce(terms);
    const out: PaymentRequirements = {
      scheme: PROTOCOL,
      chainId: this.chainId,
      gate: this.config.gate,
      token: this.token,
      payTo: this.config.payTo,
      resource: this.config.resource,
      resourceId: this.resourceId,
      ...terms,
      burnBps: BURN_BPS,
      nonce,
    };
    if (this.config.description) out.description = this.config.description;
    return out;
  }

  private deriveNonce(terms: ProofTerms): Promise<Hex> {
    return hmacHex(
      this.key,
      nonceInput({
        chainId: this.chainId,
        gate: this.config.gate,
        payTo: this.config.payTo,
        resourceId: this.resourceId,
        terms,
      }),
    );
  }

  private sessionSig(paymentId: Hex, exp: number): Promise<Hex> {
    return hmacHex(this.key, `session|${this.resourceId}|${paymentId.toLowerCase()}|${exp}`);
  }

  /*//////////////////////////////// sessions ////////////////////////////////*/

  private async useSession(token: string): Promise<SessionResult> {
    const m = /^(0x[0-9a-f]{64})\.(\d{1,12})\.(0x[0-9a-f]{64})$/.exec(token);
    if (!m) return { ok: false, code: "session_invalid", message: "Malformed session token." };
    const paymentId = m[1] as Hex;
    const exp = Number(m[2]);
    const sig = m[3] as Hex;

    const expected = await this.sessionSig(paymentId, exp);
    if (!timingSafeEqualHex(expected, sig)) {
      return { ok: false, code: "session_invalid", message: "Session token was not issued by this server." };
    }
    if (this.now() > exp) {
      return { ok: false, code: "session_expired", message: "Session expired; pay again." };
    }

    const remaining = await this.store.take(paymentId);
    if (remaining < 0) {
      return { ok: false, code: "credits_exhausted", message: "No credits left on this payment; pay again." };
    }
    return {
      ok: true,
      outcome: {
        ok: true,
        paymentId,
        remaining,
        headers: this.successHeaders(paymentId, undefined, remaining, token),
        refund: () => this.store.give(paymentId),
      },
    };
  }

  /*///////////////////////////////// proofs /////////////////////////////////*/

  private async redeemProof(req: GateRequestInfo, header: string): Promise<GateOutcome> {
    let proof;
    try {
      proof = decodeProof(header);
    } catch (e) {
      return this.fail(req, "invalid_proof", `Invalid proof: ${(e as Error).message}`, 400, false);
    }
    const { terms } = proof;
    const now = this.now();

    if (now > terms.expiry + this.config.graceSeconds) {
      return this.fail(req, "challenge_expired", "This challenge expired; request a new one and pay again.");
    }

    // The nonce is an HMAC over every term, so these terms can only be ones this server issued.
    // Checking it first means forged proofs cost us one HMAC and no RPC calls.
    const nonce = await this.deriveNonce(terms);
    if (!timingSafeEqualHex(nonce.toLowerCase(), proof.nonce.toLowerCase())) {
      return this.fail(req, "bad_challenge", "These terms were not issued by this server for this route.");
    }

    try {
      await this.verifyConfig();
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      return this.rpcDown(req);
    }

    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: proof.txHash });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) {
        return this.fail(req, "receipt_not_found", "Transaction not found yet; retry shortly.", 402, true);
      }
      return this.rpcDown(req);
    }
    if (receipt.status !== "success") {
      return this.fail(req, "tx_failed", "The payment transaction reverted.");
    }

    let latest: bigint;
    try {
      // cacheTime: 0 - viem otherwise serves a block number cached for the polling interval, which
      // would make fresh payments look unconfirmed.
      latest = await this.client.getBlockNumber({ cacheTime: 0 });
    } catch {
      return this.rpcDown(req);
    }
    if (latest + 1n - receipt.blockNumber < BigInt(this.config.confirmations)) {
      return this.fail(req, "not_confirmed", "Waiting for confirmations; retry shortly.", 402, true);
    }

    const gateLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === this.config.gate.toLowerCase(),
    );
    const paid = parseEventLogs({ abi: wifGateAbi, eventName: "Paid", logs: gateLogs, strict: false });
    const match = paid.find(
      (l) =>
        l.args.nonce?.toLowerCase() === nonce.toLowerCase() &&
        l.args.resourceId?.toLowerCase() === this.resourceId.toLowerCase() &&
        l.args.payTo?.toLowerCase() === this.config.payTo.toLowerCase(),
    );
    if (!match || !match.args.payer || !match.args.paymentId || match.args.amount === undefined) {
      return this.fail(req, "wrong_payment", "That transaction does not pay this challenge.");
    }
    const payer = getAddress(match.args.payer);
    const paymentId = match.args.paymentId;

    // Defence in depth: the event must agree with our own derivation of the id.
    const derived = computePaymentId({ payer, payTo: this.config.payTo, resourceId: this.resourceId, nonce });
    if (derived.toLowerCase() !== paymentId.toLowerCase()) {
      return this.fail(req, "wrong_payment", "Payment id mismatch.");
    }
    if (match.args.amount < BigInt(terms.price)) {
      return this.fail(req, "underpaid", `Paid ${match.args.amount} but ${terms.price} was required.`);
    }

    let sigOk = false;
    try {
      sigOk = await this.client.verifyMessage({
        address: payer,
        message: proofMessage({
          chainId: this.chainId,
          gate: this.config.gate,
          resource: this.config.resource,
          paymentId,
        }),
        signature: proof.signature,
      });
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return this.fail(req, "bad_signature", "Signature does not match the wallet that paid.");
    }

    // Re-read the contract at the head: a reorged-out payment must not be honoured.
    try {
      const stillPaid = await this.client.readContract({
        address: this.config.gate,
        abi: wifGateAbi,
        functionName: "isPaid",
        args: [paymentId],
      });
      if (!stillPaid) {
        return this.fail(req, "not_confirmed", "Payment not final yet; retry shortly.", 402, true);
      }
    } catch {
      return this.rpcDown(req);
    }

    // Credits are anchored to the payment's block time so a re-presented proof cannot extend them.
    let validUntil = 0;
    if (this.config.calls > 1) {
      try {
        const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
        validUntil = Number(block.timestamp) + this.config.validFor;
      } catch {
        return this.rpcDown(req);
      }
    }

    if (this.config.calls > 1 && validUntil < now) {
      return this.fail(req, "session_expired", "The credits bought by this payment have expired; pay again.");
    }

    const retain = Math.max(this.config.validFor, terms.expiry + this.config.graceSeconds - now) + 60;
    await this.store.redeemAndGrant(paymentId, this.config.calls, retain); // false = already redeemed: resume
    const remaining = await this.store.take(paymentId);
    if (remaining < 0) {
      return this.fail(req, "credits_exhausted", "This payment has no credits left; pay again.");
    }

    let sessionToken: string | undefined;
    if (this.config.calls > 1 && validUntil > now) {
      sessionToken = `${paymentId.toLowerCase()}.${validUntil}.${await this.sessionSig(paymentId, validUntil)}`;
    }
    return {
      ok: true,
      paymentId,
      payer,
      remaining,
      headers: this.successHeaders(paymentId, payer, remaining, sessionToken),
      refund: () => this.store.give(paymentId),
    };
  }

  /*///////////////////////////////// helpers ////////////////////////////////*/

  private successHeaders(paymentId: Hex, payer: Address | undefined, remaining: number, session?: string) {
    const h: Record<string, string> = {
      [HEADERS.payment]: paymentId,
      [HEADERS.credits]: String(remaining),
    };
    if (payer) h[HEADERS.payer] = payer;
    if (session && remaining > 0) h[HEADERS.session] = session;
    return h;
  }

  private async fail(
    req: GateRequestInfo,
    code: GateErrorCode,
    message: string,
    status: 400 | 402 = 402,
    retryable = false,
  ): Promise<GateOutcome> {
    const body: GateErrorBody = { error: code, message, retryable };
    const headers: Record<string, string> = {};
    if (status === 402) {
      const requirements = await this.challenge(req);
      body.requirements = requirements;
      headers[HEADERS.requirements] = encodeRequirements(requirements);
    }
    return { ok: false, status, headers, body };
  }

  private rpcDown(_req: GateRequestInfo): GateOutcome {
    return {
      ok: false,
      status: 503,
      headers: { "retry-after": "2" },
      body: {
        error: "rpc_unavailable",
        message: "Could not reach the blockchain RPC to verify the payment; retry shortly.",
        retryable: true,
      },
    };
  }
}

export function createGate(config: GateConfig): Gate {
  return new Gate(config);
}
