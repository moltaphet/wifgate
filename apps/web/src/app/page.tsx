import Link from "next/link";
import { LedgerStrip } from "@/components/LedgerStrip";
import { RecentPayments } from "@/components/RecentPayments";
import { WireTicket } from "@/components/WireTicket";

const SERVER_CODE = `import { wifGate } from "wifgate/server";

app.get("/api/forecast",
  wifGate({
    resource: "forecast",
    price: parseUnits("1", 18),   // 1 WIF
    payTo: SELLER,
    gate: WIFGATE,
    secret: process.env.WIFGATE_SECRET!,
  }),
  (req, res) => res.json(forecast()));`;

const AGENT_CODE = `import { createWifFetchFromKey } from "wifgate/client";

const wifFetch = createWifFetchFromKey({
  privateKey: process.env.AGENT_KEY!,
  gate: WIFGATE,
  maxPricePerCall: parseUnits("2", 18),
  maxTotalSpend: parseUnits("20", 18),
});

// Pays automatically when the API says 402.
const res = await wifFetch("https://api.example.com/api/forecast");`;

const MCP_CODE = `{
  "mcpServers": {
    "wifgate": {
      "command": "node",
      "args": ["packages/mcp/dist/main.js"],
      "env": {
        "WIF_AGENT_PRIVATE_KEY": "0x…",
        "WIFGATE_ADDRESS": "0x…",
        "WIF_MAX_PRICE": "2",
        "WIF_MAX_TOTAL": "20",
        "WIF_ALLOWED_HOSTS": "api.example.com"
      }
    }
  }
}`;

const REFUSALS: { group: string; rows: [string, string][] }[] = [
  {
    group: "Server side",
    rows: [
      ["A paid proof is shown a second time", "credits_exhausted"],
      ["Someone copies another wallet's transaction hash", "bad_signature"],
      ["The payment is below the price, goes to another seller, or is for another route", "underpaid · wrong_payment"],
      ["The price or the number of calls in the proof is edited", "wrong_payment"],
      ["The challenge is too old", "challenge_expired"],
      ["The payment transaction reverted", "tx_failed"],
      ["Two server instances share one payment", "exactly one redeems it"],
    ],
  },
  {
    group: "Agent side",
    rows: [
      ["A 402 names a contract the agent was not configured with", "refused, nothing spent"],
      ["The price is above the per-call cap or the session budget", "refused, nothing spent"],
      ["The wallet holds less $WIF than the price", "refused, nothing spent"],
      ["The seller's handler crashes after payment", "credit refunded, no second charge"],
    ],
  },
];

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero__watermark" aria-hidden>402</div>
        <div className="wrap hero__grid">
          <div>
            <p className="eyebrow">HTTP 402 · paid in $WIF · Robinhood Chain</p>
            <h1>
              Put a price on any API. <em>Let agents pay it</em> in $WIF.
            </h1>
            <p className="hero__sub">
              WifGate turns <strong>402 Payment Required</strong> into a working checkout. A request comes in, the caller pays on-chain,
              the data goes out, and <strong>2% of every payment is burned</strong>.
            </p>
            <div className="hero__cta">
              <Link href="/playground" className="btn btn--stamp">Pay for a call with your wallet</Link>
              <Link href="#integrate" className="btn btn--ghost">See the integration</Link>
            </div>
          </div>
          <WireTicket />
        </div>
      </section>

      <LedgerStrip />

      <section id="exchange" className="section">
        <div className="wrap">
          <div className="section__head">
            <h2>One request, four steps</h2>
            <p>No accounts, no API keys, no invoices. The price, the payment and the proof all travel in plain HTTP headers and one on-chain transaction.</p>
          </div>
          <div className="exchange">
            <div className="stub">
              <p className="stub__n">1</p>
              <h3>Ask</h3>
              <p>The agent calls an endpoint like any other.</p>
              <pre>{`GET /api/wif-stats`}</pre>
            </div>
            <div className="stub">
              <p className="stub__n">2</p>
              <h3>Get a price</h3>
              <p>The server answers 402 with the price, the seller and a nonce only it could have made.</p>
              <pre>{`402 { price: "1 WIF",\n  nonce: "0x51c…" }`}</pre>
            </div>
            <div className="stub">
              <p className="stub__n">3</p>
              <h3>Pay</h3>
              <p>One transaction splits the payment: 98% to the seller, 2% to the burn address.</p>
              <pre>{`WifGate.pay(\n  seller, route,\n  nonce, 1e18)`}</pre>
            </div>
            <div className="stub">
              <p className="stub__n">4</p>
              <h3>Prove</h3>
              <p>The agent resends the request with the transaction and a signature from the paying wallet. The server checks the chain.</p>
              <pre>{`x-wif-proof: <tx + sig>\n→ 200 OK`}</pre>
            </div>
          </div>
        </div>
      </section>

      <section id="integrate" className="section">
        <div className="wrap">
          <div className="section__head">
            <h2>Three snippets, three roles</h2>
            <p>Sell an endpoint with one middleware. Buy from one with one fetch. Or hand an assistant a wallet with a hard budget.</p>
          </div>
          <div className="codes">
            <div className="code">
              <div className="code__bar"><span>Seller · Express</span><span>server</span></div>
              <pre><code>{SERVER_CODE}</code></pre>
              <p className="code__why">Next.js, Hono and Bun use <code>withWifGate(config, handler)</code> with plain Request and Response.</p>
            </div>
            <div className="code">
              <div className="code__bar"><span>Agent · any script</span><span>client</span></div>
              <pre><code>{AGENT_CODE}</code></pre>
              <p className="code__why">The caps are required. There is no unlimited mode, and an untrusted gate address is refused.</p>
            </div>
            <div className="code">
              <div className="code__bar"><span>Assistant · MCP</span><span>claude</span></div>
              <pre><code>{MCP_CODE}</code></pre>
              <p className="code__why">Tools: <code>wif_quote</code>, <code>wif_fetch</code>, <code>wif_wallet</code>. Payments only go to hosts you list.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="burn" className="section">
        <div className="wrap">
          <div className="section__head">
            <h2>Where the burn comes from</h2>
            <p>
              Sellers are paid in $WIF and agents must hold $WIF to buy, so every call is demand for the token and a small permanent
              removal from supply. More API calls mean more burn.
            </p>
          </div>
          <div className="split" role="img" aria-label="Of every 100 WIF paid, 98 go to the seller and 2 are burned">
            <div className="split__net">98 → seller</div>
            <div className="split__burn">2</div>
          </div>
          <div className="split__labels">
            <span>of every 100 $WIF paid</span>
            <span>2 go to 0x…dEaD and leave circulation</span>
          </div>
        </div>
      </section>

      <section id="safety" className="section">
        <div className="wrap">
          <div className="section__head">
            <h2>What it refuses to do</h2>
            <p>Each row is an automated test against a local chain, not a promise. The contract has no owner and never holds tokens.</p>
          </div>
          <div className="refuse">
            {REFUSALS.map((g) => (
              <div key={g.group}>
                <div className="refuse__group">{g.group}</div>
                {g.rows.map(([what, code]) => (
                  <div className="refuse__row" key={what}>
                    <p>{what}</p>
                    <span className="refuse__code">{code}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="live" className="section">
        <div className="wrap">
          <div className="section__head">
            <h2>Payments, as they land</h2>
            <p>The latest <code>Paid</code> events from the contract. Every row links to its transaction.</p>
          </div>
          <RecentPayments />
        </div>
      </section>
    </>
  );
}
