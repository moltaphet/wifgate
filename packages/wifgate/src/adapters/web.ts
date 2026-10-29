import type { Address, Hex } from "viem";
import { createGate, type Gate, type GateConfig } from "../gate.js";

export interface WifGatePayment {
  paymentId: Hex;
  /** Undefined when the call was authorised by a session token. */
  payer?: Address;
  /** Credits left after this call. */
  remaining: number;
}

/**
 * Wrap a Web-standard route handler (Next.js route handlers, Hono, Bun, Deno, Cloudflare):
 *
 *   export const GET = withWifGate({ ... }, async (req, payment) => Response.json({ ok: true }));
 *
 * Unpaid requests get HTTP 402 with a payment challenge; a 5xx from your handler refunds the credit.
 */
export function withWifGate<A extends unknown[] = []>(
  configOrGate: GateConfig | Gate,
  handler: (req: Request, payment: WifGatePayment, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  const gate = "check" in configOrGate ? configOrGate : createGate(configOrGate);

  return async (req, ...rest) => {
    const outcome = await gate.check({
      method: req.method,
      url: req.url,
      header: (name) => req.headers.get(name),
    });

    if (!outcome.ok) {
      const headers = new Headers(outcome.headers);
      headers.set("content-type", "application/json");
      headers.set("cache-control", "no-store");
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers });
    }

    const payment: WifGatePayment = {
      paymentId: outcome.paymentId,
      ...(outcome.payer ? { payer: outcome.payer } : {}),
      remaining: outcome.remaining,
    };

    let res: Response;
    try {
      res = await handler(req, payment, ...rest);
    } catch (err) {
      await outcome.refund().catch(() => {});
      throw err;
    }
    if (res.status >= 500) await outcome.refund().catch(() => {});

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(outcome.headers)) headers.set(k, v);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
