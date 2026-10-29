// Spins up a local anvil chain with a mock $WIF and a real WifGate for end-to-end tests.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../../contracts/out");

function artifact(file: string, name: string): { abi: any[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(join(out, `${file}/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

export const ONE = parseUnits("1", 18);

export interface Chainlet {
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  wif: Address;
  gate: Address;
  deployer: ReturnType<typeof privateKeyToAccount>;
  wifAbi: any[];
  newWallet(wifBalance?: bigint): Promise<{ key: Hex; account: ReturnType<typeof privateKeyToAccount> }>;
  stop(): void;
}

let portCounter = 18545 + Math.floor(Math.random() * 1000);

export async function startChain(): Promise<Chainlet> {
  const port = portCounter++;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "31337"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("anvil did not start")), 15_000);
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("Listening on")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("error", reject);
  });

  const chain = defineChain({
    id: 31337,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const testClient = createTestClient({ chain, transport, mode: "anvil" });

  // anvil's first dev account
  const deployer = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const deployerWallet = createWalletClient({ account: deployer, chain, transport });

  const wifArt = artifact("Tokens.sol", "MockWIF");
  const gateArt = artifact("WifGate.sol", "WifGate");

  const wifHash = await deployerWallet.deployContract({ abi: wifArt.abi, bytecode: wifArt.bytecode });
  const wif = (await publicClient.waitForTransactionReceipt({ hash: wifHash })).contractAddress!;
  const gateHash = await deployerWallet.deployContract({
    abi: gateArt.abi, bytecode: gateArt.bytecode, args: [wif],
  });
  const gate = (await publicClient.waitForTransactionReceipt({ hash: gateHash })).contractAddress!;

  async function newWallet(wifBalance = parseUnits("1000", 18)) {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    await testClient.setBalance({ address: account.address, value: parseUnits("10", 18) });
    if (wifBalance > 0n) {
      const h = await deployerWallet.writeContract({
        address: wif, abi: wifArt.abi, functionName: "mint", args: [account.address, wifBalance],
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    return { key, account };
  }

  return {
    chain, rpcUrl, publicClient, testClient, wif, gate, deployer, wifAbi: wifArt.abi, newWallet,
    stop: () => void proc.kill("SIGKILL"),
  };
}
