# WifGate

**HTTP 402 for APIs and AI agents, paid in $WIF on Robinhood Chain. Every payment burns 2%.**

Built for the [world is flat hackathon](https://worldisflat.fun/build/rules). Categories: agents and ai,
tools and infra, consumer and payments. WifGate is independent and not affiliated with Robinhood Markets, Inc.

An API puts a price on a route. A caller (a person with a wallet, a script, or an AI assistant) gets
`402 Payment Required`, pays in one on-chain transaction, and retries with a proof. 98% goes to the seller,
2% goes to the burn address. No accounts, no API keys, no invoices.

```
agent                         seller's API                    WifGate (Robinhood Chain)
  │  GET /api/forecast            │                                   │
  │ ─────────────────────────────▶│                                   │
  │  402 {price, payTo, nonce}    │  nonce = HMAC(secret, terms)      │
  │ ◀─────────────────────────────│                                   │
  │  pay(payTo, route, nonce, amount) ──────────────────────────────▶ │  98% → seller
  │                                                                   │   2% → 0x…dEaD (burn)
  │  GET /api/forecast + x-wif-proof (tx hash + wallet signature)     │
  │ ─────────────────────────────▶│  receipt + Paid event + isPaid ──▶│
  │  200 OK                       │◀──────────────────────────────────│
  │ ◀─────────────────────────────│                                   │
```

## Why it is a $WIF flywheel

- Sellers are paid in $WIF and callers must hold $WIF to buy, so API traffic is direct demand for the token.
- Each payment permanently removes 2% from supply (`totalBurned` is public on the contract and shown live on the site).
- One payment can buy many calls (`calls`, `validFor`), so agents that poll keep coming back to pay again.
- Anyone can become a seller with one middleware, and every new paid endpoint is a new reason to hold $WIF.

## What is in the repo

| Path | What it is |
|---|---|
| `contracts/` | `WifGate.sol` (Foundry). No owner, no custody, 2% burn. Unit, fuzz, invariant and mainnet-fork tests. |
| `packages/wifgate/` | TypeScript library: `wifgate/server` (Express and Web `Request`/`Response` middleware) and `wifgate/client` (`wifFetch`). |
| `packages/mcp/` | MCP server so an assistant such as Claude can call paid APIs with hard spending limits. |
| `examples/demo-api/` | A paid API with three real endpoints (on-chain stats, chain pulse, text stats). |
| `examples/agent/` | An agent that shops with a fixed $WIF budget and reports what it burned. |
| `examples/local-demo/` | One-command demo on a throwaway local chain. |
| `apps/web/` | Next.js site: live on-chain totals, recent payments, and a wallet playground. |

## Try it locally (about a minute)

Needs Node 20+ and [Foundry](https://book.getfoundry.sh/) (`anvil`, `forge`).

```bash
npm install
(cd contracts && forge install foundry-rs/forge-std --no-git && forge build)
npm run demo:local      # chain + API + an agent with a 10 WIF budget buying data
```

To click through the web app against a local chain: `npx tsx examples/local-demo/serve.ts` prints the env vars for
`apps/web/.env.local` and a funded test key; then `npm run dev -w wifgate-web`.

## Use it

Sell an endpoint (Express):

```ts
import { wifGate } from "wifgate/server";

app.get("/api/forecast",
  wifGate({
    resource: "forecast",
    price: parseUnits("1", 18),          // gross, includes the 2% burn
    payTo: SELLER,
    gate: WIFGATE,
    secret: process.env.WIFGATE_SECRET!, // 16+ bytes, same on every instance
    calls: 10, validFor: 120,            // optional: one payment buys 10 calls for 2 minutes
  }),
  (req, res) => res.json(forecast()));
```

Next.js, Hono, Bun and Cloudflare use `withWifGate(config, async (req, payment) => Response.json(...))`.

Buy from one:

```ts
import { createWifFetchFromKey } from "wifgate/client";

const wifFetch = createWifFetchFromKey({
  privateKey: process.env.AGENT_KEY!,
  gate: WIFGATE,                                  // the only contract it will ever pay through
  maxPricePerCall: parseUnits("2", 18),           // required
  maxTotalSpend: parseUnits("20", 18),            // default: 100 x maxPricePerCall
});
const res = await wifFetch("https://api.example.com/api/forecast"); // pays on 402
```

In a browser, pass a viem `walletClient` backed by `window.ethereum` to `createWifFetch` (see `apps/web/src/components/Playground.tsx`).

Give an assistant a wallet: build `packages/mcp` and register `node packages/mcp/dist/main.js` as an MCP server with
`WIF_AGENT_PRIVATE_KEY`, `WIFGATE_ADDRESS`, `WIF_MAX_PRICE`, `WIF_MAX_TOTAL` and `WIF_ALLOWED_HOSTS`.
It exposes `wif_quote`, `wif_fetch` and `wif_wallet`, never pays a host that is not on the allowlist, and does not follow redirects.

## Deploy

1. **Contract** (needs a wallet with a little ETH on Robinhood Chain):
   ```bash
   cd contracts && cp ../.env.example .env   # set PRIVATE_KEY; never commit it
   source .env
   forge script script/Deploy.s.sol:DeployWifGate --rpc-url $RH_RPC_URL --broadcast --private-key $PRIVATE_KEY
   ```
2. **Demo API**: set the variables in `examples/demo-api/.env.example` and run `npm start -w wifgate-demo-api`
   on a host that stays up (the hackathon needs it live until the final closes). Several instances need `UPSTASH_REDIS_REST_*`.
3. **Web app**: set `NEXT_PUBLIC_WIFGATE_ADDRESS` and `NEXT_PUBLIC_DEMO_API_URL` (see `apps/web/.env.example`) and deploy `apps/web`
   (Vercel works; set the project's root directory to `apps/web`).
4. Make a few real payments from the playground and note the transactions: the hackathon asks for a repo, a demo video and real transactions.

## How it is protected

Each line is covered by an automated test (`npm test -w wifgate`, `forge test`).

- **Replay:** a proof redeems credits exactly once (`credits_exhausted`), also across instances that share a store.
- **Stolen transaction hash:** the proof must carry a signature from the paying wallet (`bad_signature`). ERC-1271 wallets work.
- **Tampering:** price, calls, route, seller, chain and expiry are bound into an HMAC nonce; edits are rejected before any RPC call (`bad_challenge`).
- **Griefing:** the on-chain payment id includes the payer, so nobody can burn another wallet's nonce.
- **Refunds:** a 5xx from the seller's handler returns the credit, and the client resumes with the same proof instead of paying twice.
- **Agents:** only trusted gate contracts, hard per-call and total caps, exact-amount approvals by default, one payment at a time.
- **Misconfiguration:** the server checks once that its chain and token match the deployed gate and fails loudly otherwise.
- **Contract:** no owner, no custody, reentrancy guard, CEI ordering, handles tokens that return `false` or nothing; fuzzed and invariant-tested, and run against the real $WIF on a mainnet fork.

## Known limits (read before relying on it)

- The contract and library are **unaudited**. Use small amounts.
- The payer needs a little ETH for gas on every payment. Multi-call credits (`calls` > 1) amortise this.
- A proof or session token is a bearer credential: whoever holds it can spend the remaining credits. Keep it on TLS.
- `MemoryStore` is correct for one process only. Use `UpstashStore` (or your own `GateStore`) with several instances or to survive restarts.
- The server's clock should be close to the chain's: credits are anchored to the payment's block time.
- Challenges are free to request, so put your usual rate limiting in front of paid routes.
- Prices are in $WIF, so their dollar value floats. Payments assume a plain ERC-20 (verified on a fork of the real $WIF).
- $WIF is a memecoin with no promise of value or return.
