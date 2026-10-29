import { defineChain, type Address, type Chain } from "viem";

export const PROTOCOL = "wifgate-v1" as const;

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

/** $WIF on Robinhood Chain (18 decimals). */
export const WIF_ADDRESS: Address = "0x5173b8eA6923c2d40267890D45C46a3480954773";

/** Where the burned share goes. Must match `WifGate.BURN_ADDRESS`. */
export const BURN_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";

/** Burned share of every payment in basis points. Must match `WifGate.BURN_BPS`. */
export const BURN_BPS = 200;

export const WIF_DECIMALS = 18;

export const robinhoodChain: Chain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: ROBINHOOD_EXPLORER_URL } },
});

/** HTTP header names (lower-case, as Node and fetch normalise them). */
export const HEADERS = {
  /** Request: proof of payment `base64url(JSON)` to redeem. */
  proof: "x-wif-proof",
  /** Request/response: bearer token that spends remaining credits of an earlier payment. */
  session: "x-wif-session",
  /** 402 response: `base64url(JSON)` copy of the payment requirements. */
  requirements: "x-wif-requirements",
  /** Response: credits left after this call. */
  credits: "x-wif-credits",
  /** Response: paymentId that paid for this call. */
  payment: "x-wif-payment",
  /** Response: wallet that paid. */
  payer: "x-wif-payer",
} as const;

/** Value for `Access-Control-Expose-Headers` so browser clients can read our headers. */
export const EXPOSE_HEADERS = Object.values(HEADERS).join(", ");
/** Value for `Access-Control-Allow-Headers` on preflight. */
export const ALLOW_HEADERS = [HEADERS.proof, HEADERS.session, "content-type"].join(", ");
