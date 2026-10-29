import type { Address, Hex } from "viem";
import { createGate, type Gate, type GateConfig, type GateOutcome } from "../gate.js";

// Structural types so the package does not depend on @types/express at runtime.
interface ReqLike {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  wifgate?: WifGatePayment;
}
interface ResLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  status(code: number): ResLike;
  json(body: unknown): unknown;
  on(event: "finish" | "close", listener: () => void): unknown;
}
type Next = (err?: unknown) => void;

/** Set on `req.wifgate` for requests that passed the gate. */
export interface WifGatePayment {
  paymentId: Hex;
  /** Undefined when the call was authorised by a session token. */
  payer?: Address;
  /** Credits left after this call. */
  remaining: number;
}

/**
 * Express middleware: `app.get("/weather", wifGate({...}), handler)`.
 * Unpaid requests get HTTP 402 with a payment challenge; a 5xx from your handler refunds the credit.
 */
export function wifGate(configOrGate: GateConfig | Gate) {
  const gate = "check" in configOrGate ? configOrGate : createGate(configOrGate);

  return async (req: ReqLike, res: ResLike, next: Next): Promise<void> => {
    let outcome: GateOutcome;
    try {
      outcome = await gate.check({
        method: req.method,
        url: req.originalUrl ?? req.url,
        header: (name) => {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
      });
    } catch (err) {
      next(err);
      return;
    }

    if (!outcome.ok) {
      for (const [k, v] of Object.entries(outcome.headers)) res.setHeader(k, v);
      res.status(outcome.status).json(outcome.body);
      return;
    }

    for (const [k, v] of Object.entries(outcome.headers)) res.setHeader(k, v);
    req.wifgate = {
      paymentId: outcome.paymentId,
      ...(outcome.payer ? { payer: outcome.payer } : {}),
      remaining: outcome.remaining,
    };

    const refund = outcome.refund;
    let settled = false;
    const onDone = () => {
      if (settled) return;
      settled = true;
      if (res.statusCode >= 500) void refund().catch(() => {});
    };
    res.on("finish", onDone);
    res.on("close", onDone);
    next();
  };
}
