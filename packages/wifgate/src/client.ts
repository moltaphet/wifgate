import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wifGateAbi } from "./abi.js";
import {
  BURN_ADDRESS,
  HEADERS,
  ROBINHOOD_RPC_URL,
  WIF_ADDRESS,
  robinhoodChain,
} from "./constants.js";
import { base64urlDecode } from "./crypto.js";
import {
  computePaymentId,
  encodeProof,
  parseRequirements,
  proofMessage,
} from "./protocol.js";
import type { GateErrorBody, PaymentRequirements } from "./types.js";

export { robinhoodChain, WIF_ADDRESS } from "./constants.js";
export { parseRequirements } from "./protocol.js";
export type { GateErrorBody, PaymentRequirements } from "./types.js";

/*///////////////////////////////// errors /////////////////////////////////*/

export class WifPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The 402 challenge asked for something this client refuses to do. Nothing was spent. */
export class UntrustedChallengeError extends WifPayError {}

/** Paying would break `maxPricePerCall` or `maxTotalSpend`. Nothing was spent. */
export class PaymentLimitError extends WifPayError {}

/** The wallet does not hold enough $WIF. Nothing was spent. */
export class InsufficientWifError extends WifPayError {}

/** The payment went through but the server did not accept the proof. Money WAS spent. */
export class PaymentRejectedError extends WifPayError {
  constructor(
    message: string,
    readonly txHash: Hex,
    readonly serverError: GateErrorBody | undefined,
    /** Resend this as `x-wif-proof` to retry redemption without paying again. */
    readonly proofHeader: string,
  ) {
    super(message);
  }
}

/*////////////////////////////////// types /////////////////////////////////*/

export interface PaymentRecord {
  url: string;
  resource: string;
  paymentId: Hex;
  txHash: Hex;
  /** Gross $WIF paid (including the burned share). */
  amount: bigint;
  burned: bigint;
  payTo: Address;
  at: number;
}

/** Progress events, for UIs and logs. Handlers must not throw; errors in them are swallowed. */
export type WifEvent =
  | { type: "challenge"; requirements: PaymentRequirements }
  | { type: "approving"; amount: bigint }
  | { type: "approved"; txHash: Hex }
  | { type: "paying"; amount: bigint }
  | { type: "paid"; record: PaymentRecord }
  | { type: "signed" }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "redeemed"; status: number };

export interface WifFetchOptions {
  /** Wallet that pays. Must have an account (private key or connected browser wallet). */
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** WifGate contract(s) you trust. Challenges naming any other contract are refused. */
  gate: Address | Address[];
  /** Hard cap for a single payment in $WIF base units. Required: there is no unlimited default. */
  maxPricePerCall: bigint;
  /** Hard cap for everything this client pays over its lifetime (default: 100 x maxPricePerCall). */
  maxTotalSpend?: bigint;
  /** `exact` (default) approves only the price each time; `unlimited` approves once. */
  approve?: "exact" | "unlimited";
  /** Extra veto over the seller address. Return false to refuse. */
  trustPayTo?: (payTo: Address, requirements: PaymentRequirements) => boolean;
  token?: Address;
  /** Confirmations to wait for before presenting the proof (default 1). */
  confirmations?: number;
  /** Times to retry when the server's RPC has not seen the payment yet (default 8). */
  maxRetries?: number;
  fetch?: typeof fetch;
  onPayment?: (record: PaymentRecord) => void;
  onEvent?: (event: WifEvent) => void;
}

export interface WifFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Ask what a URL costs without paying. Returns null if it does not require payment. */
  quote(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentRequirements | null>;
  /** Total $WIF (base units) paid so far. */
  readonly spent: bigint;
  readonly history: readonly PaymentRecord[];
  readonly address: Address;
}

/*///////////////////////////////// client /////////////////////////////////*/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function routeKey(req: Request): string {
  const u = new URL(req.url);
  return `${req.method} ${u.origin}${u.pathname}`;
}

async function readChallenge(res: Response): Promise<{ body?: GateErrorBody; requirements?: PaymentRequirements } | null> {
  let body: GateErrorBody | undefined;
  try {
    body = (await res.clone().json()) as GateErrorBody;
  } catch {
    body = undefined;
  }
  let raw: unknown = body?.requirements;
  if (!raw) {
    const h = res.headers.get(HEADERS.requirements);
    if (h) {
      try {
        raw = JSON.parse(base64urlDecode(h));
      } catch {
        raw = undefined;
      }
    }
  }
  if (!raw) return null;
  try {
    const requirements = parseRequirements(raw);
    return body ? { body, requirements } : { requirements };
  } catch {
    return null;
  }
}

export function createWifFetch(opts: WifFetchOptions): WifFetch {
  const account = opts.walletClient.account;
  if (!account) throw new WifPayError("wifgate: walletClient needs an account");
  const payer = getAddress(account.address);
  const chainId = opts.publicClient.chain?.id;
  if (chainId === undefined) throw new WifPayError("wifgate: publicClient needs a chain");

  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const gates = new Set((Array.isArray(opts.gate) ? opts.gate : [opts.gate]).map((a) => getAddress(a)));
  const token = getAddress(opts.token ?? WIF_ADDRESS);
  const maxPrice = opts.maxPricePerCall;
  const maxTotal = opts.maxTotalSpend ?? maxPrice * 100n;
  const approveMode = opts.approve ?? "exact";
  const confirmations = opts.confirmations ?? 1;
  const maxRetries = opts.maxRetries ?? 8;
  if (maxPrice <= 0n) throw new WifPayError("wifgate: maxPricePerCall must be positive");

  const emit = (e: WifEvent) => {
    try { opts.onEvent?.(e); } catch { /* observers must not break payments */ }
  };

  let spent = 0n;
  const history: PaymentRecord[] = [];
  const sessions = new Map<string, string>();
  const pending = new Map<string, string>(); // paid but not yet accepted: proof header per route

  // One payment at a time per client: keeps allowance/nonce handling simple and prevents paying
  // twice for the same resource when several calls race.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  function withHeader(base: Request, name: string, value: string): Request {
    const r = base.clone();
    r.headers.set(name, value);
    return r;
  }

  function assertAcceptable(r: PaymentRequirements): bigint {
    if (r.chainId !== chainId) {
      throw new UntrustedChallengeError(`Challenge is for chain ${r.chainId}, this client is on ${chainId}.`);
    }
    if (!gates.has(getAddress(r.gate))) {
      throw new UntrustedChallengeError(`Refusing to pay through untrusted gate contract ${r.gate}.`);
    }
    if (getAddress(r.token) !== token) {
      throw new UntrustedChallengeError(`Challenge uses token ${r.token}, expected ${token}.`);
    }
    const payTo = getAddress(r.payTo);
    if (payTo === getAddress(BURN_ADDRESS) || payTo === "0x0000000000000000000000000000000000000000") {
      throw new UntrustedChallengeError("Challenge pays an invalid address.");
    }
    if (opts.trustPayTo && !opts.trustPayTo(payTo, r)) {
      throw new UntrustedChallengeError(`Seller ${payTo} was vetoed by trustPayTo.`);
    }
    if (r.expiry * 1000 < Date.now()) {
      throw new UntrustedChallengeError("Challenge already expired.");
    }
    const price = BigInt(r.price);
    if (price > maxPrice) {
      throw new PaymentLimitError(`Price ${price} exceeds maxPricePerCall ${maxPrice}.`);
    }
    if (spent + price > maxTotal) {
      throw new PaymentLimitError(`Paying ${price} would exceed maxTotalSpend ${maxTotal} (spent ${spent}).`);
    }
    return price;
  }

  async function ensureFunds(price: bigint, gate: Address): Promise<void> {
    const balance = await opts.publicClient.readContract({
      address: token, abi: erc20Abi, functionName: "balanceOf", args: [payer],
    });
    if (balance < price) {
      throw new InsufficientWifError(`Wallet ${payer} holds ${balance} $WIF base units, needs ${price}.`);
    }
    const allowance = await opts.publicClient.readContract({
      address: token, abi: erc20Abi, functionName: "allowance", args: [payer, gate],
    });
    if (allowance >= price) return;

    emit({ type: "approving", amount: approveMode === "unlimited" ? maxUint256 : price });
    const hash = await opts.walletClient.writeContract({
      account: account as Account,
      chain: opts.walletClient.chain ?? opts.publicClient.chain ?? null,
      address: token, abi: erc20Abi, functionName: "approve",
      args: [gate, approveMode === "unlimited" ? maxUint256 : price],
    });
    const rc = await opts.publicClient.waitForTransactionReceipt({ hash, confirmations });
    if (rc.status !== "success") throw new WifPayError(`approve transaction reverted (${hash}).`);
    emit({ type: "approved", txHash: hash });
  }

  async function pay(r: PaymentRequirements, url: string): Promise<{ txHash: Hex; proofHeader: string }> {
    const price = assertAcceptable(r);
    const gate = getAddress(r.gate);
    const payTo = getAddress(r.payTo);
    await ensureFunds(price, gate);

    emit({ type: "paying", amount: price });
    const { request } = await opts.publicClient.simulateContract({
      account: account as Account,
      address: gate, abi: wifGateAbi, functionName: "pay",
      args: [payTo, r.resourceId, r.nonce, price],
    });
    const txHash = await opts.walletClient.writeContract(request as never);
    const rc = await opts.publicClient.waitForTransactionReceipt({ hash: txHash, confirmations });
    if (rc.status !== "success") throw new WifPayError(`pay transaction reverted (${txHash}).`);

    const expectedId = computePaymentId({ payer, payTo, resourceId: r.resourceId, nonce: r.nonce });
    const logs = parseEventLogs({
      abi: wifGateAbi, eventName: "Paid", strict: false,
      logs: rc.logs.filter((l) => l.address.toLowerCase() === gate.toLowerCase()),
    });
    const ev = logs.find((l) => l.args.paymentId?.toLowerCase() === expectedId.toLowerCase());
    if (!ev) throw new WifPayError(`pay transaction ${txHash} did not emit the expected Paid event.`);

    const burned = ev.args.burned ?? 0n;
    spent += price;
    const record: PaymentRecord = {
      url, resource: r.resource, paymentId: expectedId, txHash,
      amount: price, burned, payTo, at: Date.now(),
    };
    history.push(record);
    opts.onPayment?.(record);
    emit({ type: "paid", record });

    const signature = await opts.walletClient.signMessage({
      account: account as Account,
      message: proofMessage({ chainId: r.chainId, gate, resource: r.resource, paymentId: expectedId }),
    });
    emit({ type: "signed" });
    const proofHeader = encodeProof({
      v: 1, nonce: r.nonce, txHash, signature,
      terms: { price: r.price, calls: r.calls, validFor: r.validFor, expiry: r.expiry, salt: r.salt },
    });
    return { txHash, proofHeader };
  }

  /** Presents a proof, retrying while the server's RPC catches up. */
  async function redeem(base: Request, key: string, txHash: Hex, proofHeader: string): Promise<Response> {
    pending.set(key, proofHeader);
    let last: GateErrorBody | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await doFetch(withHeader(base, HEADERS.proof, proofHeader));
      if (res.status !== 402 && res.status !== 503) {
        // A 5xx from the seller's handler refunds the credit server-side, so keep the proof and
        // resume with it on the next call instead of paying again.
        if (res.status >= 500) pending.set(key, proofHeader);
        else pending.delete(key);
        const token = res.headers.get(HEADERS.session);
        if (token) sessions.set(key, token);
        emit({ type: "redeemed", status: res.status });
        return res;
      }
      last = (await res.clone().json().catch(() => undefined)) as GateErrorBody | undefined;
      if (!last?.retryable) {
        pending.delete(key);
        throw new PaymentRejectedError(
          `Payment ${txHash} was made but the server rejected the proof: ${last?.error ?? res.status} ${last?.message ?? ""}`.trim(),
          txHash, last, proofHeader,
        );
      }
      emit({ type: "retry", attempt: attempt + 1, reason: last.error });
      await sleep(300 * (attempt + 1));
    }
    // Still pending: keep the proof so the next call resumes instead of paying twice.
    throw new PaymentRejectedError(
      `Payment ${txHash} was made but the server could not confirm it yet (${last?.error}). Retry the call to resume.`,
      txHash, last, proofHeader,
    );
  }

  async function quote(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentRequirements | null> {
    const res = await doFetch(new Request(input, init));
    if (res.status !== 402) return null;
    return (await readChallenge(res))?.requirements ?? null;
  }

  const wifFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const base = new Request(input, init);
    const key = routeKey(base);

    // 1. Spend an existing session or resume an unfinished payment.
    const session = sessions.get(key);
    let res = await doFetch(session ? withHeader(base, HEADERS.session, session) : base.clone());
    if (res.status !== 402) {
      const t = res.headers.get(HEADERS.session);
      if (t) sessions.set(key, t);
      return res;
    }
    if (session) sessions.delete(key);

    const challenge = await readChallenge(res);
    if (!challenge) return res; // a 402 that is not ours: hand it back untouched
    emit({ type: "challenge", requirements: challenge.requirements! });

    // 2. Pay, one at a time.
    return serialized(async () => {
      const again = sessions.get(key); // someone else may have paid for this route meanwhile
      if (again && again !== session) {
        const r2 = await doFetch(withHeader(base, HEADERS.session, again));
        if (r2.status !== 402) return r2;
        sessions.delete(key);
      }
      const stuck = pending.get(key);
      if (stuck) {
        // Network errors propagate on purpose: a failed attempt says nothing about the proof, and
        // paying again would double-charge. The proof stays pending for the next call.
        const rr = await doFetch(withHeader(base, HEADERS.proof, stuck));
        if (rr.status !== 402 && rr.status !== 503) {
          if (rr.status < 500) pending.delete(key);
          const t = rr.headers.get(HEADERS.session);
          if (t) sessions.set(key, t);
          return rr;
        }
        const b = (await rr.clone().json().catch(() => undefined)) as GateErrorBody | undefined;
        if (b?.retryable) {
          throw new PaymentRejectedError(
            `An earlier payment is still being confirmed (${b.error}); retry the call to resume.`,
            "0x" as Hex, b, stuck,
          );
        }
        pending.delete(key); // rejected for good (spent, expired, ...): pay anew below
      }

      // The challenge we hold may be stale if we waited in the queue; fetch a fresh one.
      let reqs = challenge.requirements!;
      if (reqs.expiry * 1000 - Date.now() < 15_000) {
        res = await doFetch(base.clone());
        if (res.status !== 402) return res;
        const fresh = await readChallenge(res);
        if (!fresh) return res;
        reqs = fresh.requirements!;
      }

      const { txHash, proofHeader } = await pay(reqs, base.url);
      return redeem(base, key, txHash, proofHeader);
    });
  }) as WifFetch;

  Object.defineProperties(wifFetch, {
    quote: { value: quote },
    spent: { get: () => spent },
    history: { get: () => history as readonly PaymentRecord[] },
    address: { value: payer },
  });
  return wifFetch;
}

/** Convenience for agents and scripts: build everything from a private key. */
export function createWifFetchFromKey(args: {
  privateKey: Hex;
  gate: Address | Address[];
  maxPricePerCall: bigint;
  maxTotalSpend?: bigint;
  rpcUrl?: string;
  chain?: Chain;
  approve?: "exact" | "unlimited";
  trustPayTo?: WifFetchOptions["trustPayTo"];
  token?: Address;
  confirmations?: number;
  fetch?: typeof fetch;
  onPayment?: WifFetchOptions["onPayment"];
  onEvent?: WifFetchOptions["onEvent"];
}): WifFetch {
  const chain = args.chain ?? robinhoodChain;
  const transport = http(args.rpcUrl ?? ROBINHOOD_RPC_URL);
  const account = privateKeyToAccount(args.privateKey);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport });
  const { privateKey: _pk, rpcUrl: _rpc, chain: _chain, ...rest } = args;
  return createWifFetch({ ...rest, walletClient, publicClient });
}
