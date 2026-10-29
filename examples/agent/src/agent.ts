/**
 * A tiny autonomous agent that shops for data with a hard $WIF budget.
 * It asks every route for its price first, buys only what fits, and reports exactly what it
 * spent and how much $WIF it burned along the way.
 *
 *   AGENT_PRIVATE_KEY=0x... WIFGATE_ADDRESS=0x... API_URL=https://... npm start -w wifgate-agent-example
 */
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { createWifFetchFromKey } from "wifgate/client";
import { robinhoodChain } from "wifgate";
import type { Chain } from "viem";

export interface AgentOptions {
  apiUrl: string;
  privateKey: Hex;
  gate: Address;
  budgetWif: string;
  rpcUrl?: string;
  chain?: Chain;
  token?: Address;
  log?: (line: string) => void;
}

export async function runAgent(o: AgentOptions) {
  const log = o.log ?? console.log;
  const budget = parseUnits(o.budgetWif, 18);
  const wf = createWifFetchFromKey({
    privateKey: o.privateKey,
    gate: o.gate,
    maxPricePerCall: budget,
    maxTotalSpend: budget,
    chain: o.chain ?? robinhoodChain,
    ...(o.rpcUrl ? { rpcUrl: o.rpcUrl } : {}),
    ...(o.token ? { token: o.token } : {}),
    onPayment: (p) =>
      log(`  paid ${formatUnits(p.amount, 18)} WIF for ${p.resource} (burned ${formatUnits(p.burned, 18)}) tx ${p.txHash}`),
  });
  log(`agent wallet ${wf.address}, budget ${o.budgetWif} WIF`);

  const get = async (path: string, init?: RequestInit) => {
    const url = o.apiUrl.replace(/\/$/, "") + path;
    const q = await wf.quote(url, init);
    if (!q) return { skipped: "free or unavailable" as const };
    const price = BigInt(q.price);
    const alreadyPaid = wf.history.some((h) => h.url === url); // a session may still hold credits
    if (!alreadyPaid && wf.spent + price > budget) {
      log(`- ${path}: costs ${formatUnits(price, 18)} WIF, over budget, skipping`);
      return { skipped: "over budget" as const };
    }
    log(`- ${path}: ${formatUnits(price, 18)} WIF (${q.calls} call${q.calls > 1 ? "s" : ""} per payment)`);
    const res = await wf(url, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const results: Record<string, unknown> = {};
  results.stats = await get("/api/wif-stats");
  // The pulse route sells 10 calls per payment: poll it three times for one payment.
  for (let i = 0; i < 3; i++) results[`pulse${i}`] = await get("/api/chain-pulse");
  results.text = await get("/api/text-stats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Pay-per-request APIs let agents buy exactly the data they need, and every payment burns WIF." }),
  });

  const burned = wf.history.reduce((a, p) => a + p.burned, 0n);
  log(`\nspent ${formatUnits(wf.spent, 18)} / ${o.budgetWif} WIF in ${wf.history.length} payments, burned ${formatUnits(burned, 18)} WIF`);
  return { results, spent: wf.spent, burned, payments: wf.history };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const need = (n: string) => {
    const v = process.env[n];
    if (!v) throw new Error(`Missing ${n}`);
    return v;
  };
  await runAgent({
    apiUrl: process.env.API_URL ?? "http://localhost:8787",
    privateKey: need("AGENT_PRIVATE_KEY") as Hex,
    gate: need("WIFGATE_ADDRESS") as Address,
    budgetWif: process.env.BUDGET_WIF ?? "10",
    ...(process.env.RH_RPC_URL ? { rpcUrl: process.env.RH_RPC_URL } : {}),
  });
}
