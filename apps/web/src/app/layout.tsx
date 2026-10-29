import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { GATE, isConfigured, explorerAddress } from "@/lib/config";
import "./globals.css";

// Self-hosted (OFL-licensed) so the site never depends on a font CDN being reachable.
const display = localFont({
  src: [
    { path: "../fonts/big-shoulders-display-latin-800-normal.woff2", weight: "800", style: "normal" },
    { path: "../fonts/big-shoulders-display-latin-900-normal.woff2", weight: "900", style: "normal" },
  ],
  variable: "--f-display",
  display: "swap",
});
const body = localFont({
  src: [
    { path: "../fonts/instrument-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/instrument-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--f-body",
  display: "swap",
});
const mono = localFont({
  src: [
    { path: "../fonts/jetbrains-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/jetbrains-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../fonts/jetbrains-mono-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--f-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "WifGate: charge for any API in $WIF", template: "%s · WifGate" },
  description:
    "HTTP 402 pay-per-request for APIs and AI agents, settled in $WIF on Robinhood Chain. Every payment burns 2% of the $WIF paid.",
};
export const viewport: Viewport = { themeColor: "#e4edea", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <header className="site-header">
          <div className="wrap site-header__row">
            <Link href="/" className="brand" aria-label="WifGate home">
              <span className="brand__name">WifGate</span>
              <span className="brand__code" aria-hidden>402</span>
            </Link>
            <nav className="nav" aria-label="Main">
              <Link href="/#exchange">How it works</Link>
              <Link href="/#integrate">Integrate</Link>
              <Link href="/#live">Live payments</Link>
              <Link href="/playground" className="nav__cta">Playground</Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="wrap site-footer__grid">
            <div>
              <p>
                WifGate is an independent project built for the world is flat hackathon. It is not affiliated with, endorsed by, or
                connected to Robinhood Markets, Inc. $WIF is a memecoin with no promise of value or return; the contract is unaudited,
                so use small amounts.
              </p>
              <p>Payments burn 2% of the $WIF paid. The contract holds no funds and has no owner.</p>
            </div>
            <dl>
              <dt>WifGate</dt>
              <dd>{isConfigured ? <a href={explorerAddress(GATE)} target="_blank" rel="noreferrer">{GATE}</a> : "not deployed yet"}</dd>
              <dt>Chain</dt>
              <dd>Robinhood Chain · 4663</dd>
            </dl>
          </div>
        </footer>
      </body>
    </html>
  );
}
