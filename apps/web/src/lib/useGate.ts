"use client";

import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { wifGateAbi } from "wifgate";
import { GATE, isConfigured, publicClient } from "./config";

export interface GateStats {
  burned?: bigint;
  volume?: bigint;
  payments?: bigint;
  error?: boolean;
}

export function useGateStats(intervalMs = 15_000): GateStats {
  const [stats, setStats] = useState<GateStats>({});
  useEffect(() => {
    if (!isConfigured) return;
    let alive = true;
    const load = async () => {
      try {
        const [burned, volume, payments] = await Promise.all([
          publicClient.readContract({ address: GATE, abi: wifGateAbi, functionName: "totalBurned" }),
          publicClient.readContract({ address: GATE, abi: wifGateAbi, functionName: "totalVolume" }),
          publicClient.readContract({ address: GATE, abi: wifGateAbi, functionName: "totalPayments" }),
        ]);
        if (alive) setStats({ burned, volume, payments });
      } catch {
        if (alive) setStats((s) => ({ ...s, error: true }));
      }
    };
    void load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return stats;
}

export interface PaymentRow {
  txHash: Hex;
  blockNumber: bigint;
  timestamp?: number;
  payer: Address;
  payTo: Address;
  amount: bigint;
  burned: bigint;
}

export function useRecentPayments(limit = 8, intervalMs = 20_000) {
  const [rows, setRows] = useState<PaymentRow[] | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isConfigured) return;
    let alive = true;
    const load = async () => {
      try {
        const head = await publicClient.getBlockNumber();
        // Public RPCs cap getLogs ranges; try wide first, then narrower.
        let logs: Awaited<ReturnType<typeof publicClient.getContractEvents<typeof wifGateAbi, "Paid">>> | undefined;
        for (const span of [200_000n, 20_000n, 2_000n]) {
          try {
            logs = await publicClient.getContractEvents({
              address: GATE, abi: wifGateAbi, eventName: "Paid",
              fromBlock: head > span ? head - span : 0n, toBlock: head,
            });
            break;
          } catch {
            logs = undefined;
          }
        }
        if (!logs) throw new Error("getLogs unavailable");
        const latest = logs.slice(-limit).reverse();
        const blocks = [...new Set(latest.map((l) => l.blockNumber))];
        const stamps = new Map<bigint, number>();
        await Promise.allSettled(
          blocks.map(async (b) => {
            const blk = await publicClient.getBlock({ blockNumber: b });
            stamps.set(b, Number(blk.timestamp));
          }),
        );
        const mapped: PaymentRow[] = latest.map((l) => {
          const ts = stamps.get(l.blockNumber);
          return {
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            ...(ts !== undefined ? { timestamp: ts } : {}),
            payer: l.args.payer as Address,
            payTo: l.args.payTo as Address,
            amount: l.args.amount as bigint,
            burned: l.args.burned as bigint,
          };
        });
        if (alive) {
          setRows(mapped);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [limit, intervalMs]);

  return { rows, failed };
}
