import { defineChain, getAddress, http, isAddress, zeroAddress, type Address, type Chain } from "viem";
import { createPublicClient } from "viem";
import { ROBINHOOD_RPC_URL, WIF_ADDRESS, robinhoodChain } from "wifgate";

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL?.trim() || ROBINHOOD_RPC_URL;
const chainIdEnv = Number(process.env.NEXT_PUBLIC_CHAIN_ID || robinhoodChain.id);

/** Robinhood Chain by default; a local dev chain when NEXT_PUBLIC_CHAIN_ID says so. */
export const chain: Chain =
  chainIdEnv === robinhoodChain.id
    ? { ...robinhoodChain, rpcUrls: { default: { http: [rpcUrl] } } }
    : defineChain({
        id: chainIdEnv,
        name: `Chain ${chainIdEnv}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });

const gateEnv = process.env.NEXT_PUBLIC_WIFGATE_ADDRESS?.trim();
export const GATE: Address = gateEnv && isAddress(gateEnv) ? getAddress(gateEnv) : zeroAddress;
export const isConfigured = GATE !== zeroAddress;

const tokenEnv = process.env.NEXT_PUBLIC_WIF_TOKEN?.trim();
export const TOKEN: Address = tokenEnv && isAddress(tokenEnv) ? getAddress(tokenEnv) : WIF_ADDRESS;

export const API_URL = (process.env.NEXT_PUBLIC_DEMO_API_URL?.trim() || "http://localhost:8787").replace(/\/$/, "");
export const EXPLORER = chain.blockExplorers?.default.url ?? "";

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

export const explorerTx = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : "#");
export const explorerAddress = (a: string) => (EXPLORER ? `${EXPLORER}/address/${a}` : "#");
