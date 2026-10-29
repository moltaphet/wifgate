import { formatUnits } from "viem";

/** 1234567800000000000000 -> "1,234.5678" (max 4 decimals unless the value is tiny). */
export function fmtWif(value: bigint | undefined, maxDecimals = 4): string {
  if (value === undefined) return "—";
  const n = Number(formatUnits(value, 18));
  if (!Number.isFinite(n)) return formatUnits(value, 18);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: n !== 0 && n < 0.01 ? 6 : maxDecimals }).format(n);
}

export const short = (value: string, head = 6, tail = 4) =>
  value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;

export function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
