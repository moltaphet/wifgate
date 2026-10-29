/**
 * One-command demo on a throwaway local chain (needs Foundry installed):
 *   npm run demo:local
 *
 * Starts anvil, deploys a mock $WIF and the real WifGate contract, serves the demo API, and lets an
 * agent with a 10 WIF budget buy data from it. Everything you see is real on-chain payments.
 */
import type { AddressInfo } from "node:net";
import { formatUnits, getAddress, parseUnits } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { wifGateAbi } from "../../packages/wifgate/src/abi.js";
import { startChain } from "../../packages/wifgate/test/harness.js";
import { createDemoApp } from "../demo-api/src/app.js";
import { runAgent } from "../agent/src/agent.js";

const chain = await startChain();
try {
  const seller = (await chain.newWallet(0n)).account.address;
  const agent = await chain.newWallet(parseUnits("100", 18));
  console.log(`local chain ${chain.rpcUrl}\nWifGate ${chain.gate}\nmock WIF ${chain.wif}\nseller ${seller}\n`);

  const app = createDemoApp({
    gate: chain.gate, token: chain.wif, payTo: seller, secret: generatePrivateKey(),
    chain: chain.chain, publicClient: chain.publicClient,
  });
  const server = await new Promise<import("node:http").Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const out = await runAgent({
    apiUrl, privateKey: agent.key, gate: chain.gate, budgetWif: "10",
    rpcUrl: chain.rpcUrl, chain: chain.chain, token: chain.wif,
  });
  console.log("\nstats result:", JSON.stringify((out.results.stats as any).body));
  console.log("pulse result:", JSON.stringify((out.results.pulse2 as any).body));
  console.log("text result:", JSON.stringify((out.results.text as any).body));

  const [burned, volume, n] = await Promise.all([
    chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalBurned" }),
    chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalVolume" }),
    chain.publicClient.readContract({ address: chain.gate, abi: wifGateAbi, functionName: "totalPayments" }),
  ]);
  console.log(`\non-chain: ${n} payments, ${formatUnits(volume, 18)} WIF volume, ${formatUnits(burned, 18)} WIF burned`);
  void getAddress;
  server.close();
} finally {
  chain.stop();
}
