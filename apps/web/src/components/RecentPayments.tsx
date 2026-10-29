"use client";

import { isConfigured, explorerTx } from "@/lib/config";
import { ago, fmtWif, short } from "@/lib/format";
import { useRecentPayments } from "@/lib/useGate";

export function RecentPayments() {
  const { rows, failed } = useRecentPayments(8);

  if (!isConfigured) {
    return (
      <div className="table-wrap">
        <p className="empty"><strong>No contract yet.</strong> Payments appear here as soon as WifGate is deployed and its address is set.</p>
      </div>
    );
  }
  if (rows === undefined) {
    return (
      <div className="table-wrap">
        <p className="empty">{failed ? "Could not load payments from the RPC. Retrying." : "Loading payments from the chain…"}</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="table-wrap">
        <p className="empty"><strong>No payments yet.</strong> Open the playground and make the first one.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>When</th><th>Payer</th><th>Seller</th><th className="num">Paid ($WIF)</th><th className="num">Burned ($WIF)</th><th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.txHash}>
              <td>{r.timestamp ? ago(r.timestamp) : `block ${r.blockNumber}`}</td>
              <td>{short(r.payer)}</td>
              <td>{short(r.payTo)}</td>
              <td className="num">{fmtWif(r.amount)}</td>
              <td className="num burn">{fmtWif(r.burned, 4)}</td>
              <td><a href={explorerTx(r.txHash)} target="_blank" rel="noreferrer">{short(r.txHash, 8, 6)}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
