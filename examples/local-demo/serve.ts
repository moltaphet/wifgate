/**
 * Long-running local stack for developing the web app:
 *   npx tsx examples/local-demo/serve.ts
 * Prints the env vars to put in apps/web/.env.local. Seeds a few payments so the live table has rows.
 */
import { parseUnits } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { startChain } from "../../packages/wifgate/test/harness.js";
import { createDemoApp } from "../demo-api/src/app.js";
import { runAgent } from "../agent/src/agent.js";

const chain = await startChain();
const seller = (await chain.newWallet(0n)).account.address;
const agent = await chain.newWallet(parseUnits("100", 18));
const app = createDemoApp({
  gate: chain.gate, token: chain.wif, payTo: seller, secret: generatePrivateKey(),
  chain: chain.chain, publicClient: chain.publicClient,
});
const server = app.listen(8787, "127.0.0.1");
await new Promise((r) => server.once("listening", r));

await runAgent({
  apiUrl: "http://127.0.0.1:8787", privateKey: agent.key, gate: chain.gate, budgetWif: "10",
  rpcUrl: chain.rpcUrl, chain: chain.chain, token: chain.wif, log: () => {},
});

// A wallet you can import into a browser wallet to try the playground by hand.
const human = await chain.newWallet(parseUnits("50", 18));
console.log(`
NEXT_PUBLIC_WIFGATE_ADDRESS=${chain.gate}
NEXT_PUBLIC_WIF_TOKEN=${chain.wif}
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=${chain.rpcUrl}
NEXT_PUBLIC_DEMO_API_URL=http://127.0.0.1:8787

demo API  http://127.0.0.1:8787
test wallet private key (50 WIF, local chain only): ${human.key}
`);
process.on("SIGINT", () => { chain.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
