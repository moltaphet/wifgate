"use client";

import { isConfigured } from "@/lib/config";
import { fmtWif } from "@/lib/format";
import { useGateStats } from "@/lib/useGate";

export function LedgerStrip() {
  const s = useGateStats();
  const note = !isConfigured
    ? "Contract address not set. Deploy WifGate and set NEXT_PUBLIC_WIFGATE_ADDRESS."
    : s.error && s.burned === undefined
      ? "Could not reach the RPC. Retrying."
      : "Read from the WifGate contract, refreshed every 15 seconds.";
  return (
    <section className="ledger-strip" aria-label="Live totals from the WifGate contract">
      <div className="wrap">
        <div className="ledger-strip__row">
          <div className="ledger-strip__cell">
            <p className="ledger-strip__label">$WIF burned by API traffic</p>
            <p className="ledger-strip__value ledger-strip__value--burn">{fmtWif(s.burned, 2)}</p>
          </div>
          <div className="ledger-strip__cell">
            <p className="ledger-strip__label">$WIF paid for API calls</p>
            <p className="ledger-strip__value">{fmtWif(s.volume, 2)}</p>
          </div>
          <div className="ledger-strip__cell">
            <p className="ledger-strip__label">Payments settled</p>
            <p className="ledger-strip__value">{s.payments === undefined ? "—" : s.payments.toString()}</p>
            <p className="ledger-strip__note">{note}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
