import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { ROBINHOOD_RPC_URL, WIF_ADDRESS, robinhoodChain } from "wifgate/server";
import { createDemoApp, storeFromEnv } from "./app.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. See README.`);
    process.exit(1);
  }
  return v;
}

const secret = need("WIFGATE_SECRET");
if (secret.length < 32) {
  console.error("WIFGATE_SECRET must be at least 32 characters (try: openssl rand -hex 32)");
  process.exit(1);
}

const chain = robinhoodChain;
const publicClient = createPublicClient({
  chain,
  transport: http(process.env.RH_RPC_URL ?? ROBINHOOD_RPC_URL),
}) as PublicClient;

const app = createDemoApp({
  gate: getAddress(need("WIFGATE_ADDRESS")),
  payTo: getAddress(need("PAY_TO")),
  token: getAddress(process.env.WIF_TOKEN ?? WIF_ADDRESS),
  secret,
  chain,
  publicClient,
  store: storeFromEnv(),
  ...(process.env.CORS_ORIGIN ? { corsOrigin: process.env.CORS_ORIGIN } : {}),
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`WifGate demo API listening on :${port}`));
