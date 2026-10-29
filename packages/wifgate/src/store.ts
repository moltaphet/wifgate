/**
 * Storage for payment redemption and call credits.
 *
 * A store must make `redeemAndGrant` atomic: for one `paymentId`, exactly one caller ever gets
 * `true`, even across processes. `take`/`give` must be atomic counters. MemoryStore is correct for
 * a single process; use UpstashStore (or your own implementation) when you run several instances
 * (serverless, multiple replicas) or want credits to survive a restart.
 */
export interface GateStore {
  /**
   * Create `calls` credits for `paymentId` if none exist yet. Returns true for the one caller that
   * created them. Credits are retained for at least `retainSeconds`.
   */
  redeemAndGrant(paymentId: string, calls: number, retainSeconds: number): Promise<boolean>;
  /** Spend one credit. Returns the credits left afterwards, or -1 if there were none. */
  take(paymentId: string): Promise<number>;
  /** Give one credit back (used when the protected handler fails with a 5xx). */
  give(paymentId: string): Promise<void>;
}

export class MemoryStore implements GateStore {
  private readonly entries = new Map<string, { credits: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now() / 1000) {}

  private sweep(): void {
    if (this.entries.size < 1024) return;
    const t = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k);
  }

  private live(paymentId: string) {
    const e = this.entries.get(paymentId);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(paymentId);
      return undefined;
    }
    return e;
  }

  async redeemAndGrant(paymentId: string, calls: number, retainSeconds: number): Promise<boolean> {
    this.sweep();
    if (this.live(paymentId)) return false;
    this.entries.set(paymentId, { credits: calls, expiresAt: this.now() + retainSeconds });
    return true;
  }

  async take(paymentId: string): Promise<number> {
    const e = this.live(paymentId);
    if (!e || e.credits <= 0) return -1;
    e.credits -= 1;
    return e.credits;
  }

  async give(paymentId: string): Promise<void> {
    const e = this.live(paymentId);
    if (e) e.credits += 1;
  }
}

export interface UpstashOptions {
  /** e.g. https://eu1-xxxx.upstash.io */
  url: string;
  token: string;
  /** Key prefix, default "wifgate:". */
  prefix?: string;
  fetch?: typeof fetch;
}

/** Spend one credit if any are left, never creating a key. Returns credits left, or -1. */
export const TAKE_SCRIPT =
  "local v = redis.call('GET', KEYS[1]) if (not v) or tonumber(v) <= 0 then return -1 end return redis.call('DECR', KEYS[1])";

/** Give one credit back only to an existing key. */
export const GIVE_SCRIPT =
  "if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCR', KEYS[1]) end return -1";

/**
 * Redis store over Upstash's REST API. Every operation is a single atomic command
 * (`SET NX EX`, or a one-key Lua script), so it is correct across any number of instances.
 */
export class UpstashStore implements GateStore {
  private readonly prefix: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: UpstashOptions) {
    this.prefix = opts.prefix ?? "wifgate:";
    this.doFetch = opts.fetch ?? fetch;
  }

  private async cmd<T>(...args: (string | number)[]): Promise<T> {
    const res = await this.doFetch(this.opts.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Upstash ${args[0]} failed: HTTP ${res.status}`);
    const json = (await res.json()) as { result?: T; error?: string };
    if (json.error) throw new Error(`Upstash ${args[0]} failed: ${json.error}`);
    return json.result as T;
  }

  private key(paymentId: string): string {
    return `${this.prefix}c:${paymentId.toLowerCase()}`;
  }

  async redeemAndGrant(paymentId: string, calls: number, retainSeconds: number): Promise<boolean> {
    const r = await this.cmd<string | null>(
      "SET", this.key(paymentId), calls, "NX", "EX", Math.max(1, Math.ceil(retainSeconds)),
    );
    return r === "OK";
  }

  async take(paymentId: string): Promise<number> {
    return this.cmd<number>("EVAL", TAKE_SCRIPT, 1, this.key(paymentId));
  }

  async give(paymentId: string): Promise<void> {
    await this.cmd<number>("EVAL", GIVE_SCRIPT, 1, this.key(paymentId));
  }
}
