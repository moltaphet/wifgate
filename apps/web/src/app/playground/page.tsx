import type { Metadata } from "next";
import { Playground } from "@/components/Playground";

export const metadata: Metadata = { title: "Playground" };

export default function PlaygroundPage() {
  return (
    <div className="wrap">
      <div className="pg-head">
        <h1>Pay for an API call</h1>
        <p>
          Connect a wallet, pick an endpoint and call it. You will see the 402 challenge, the on-chain payment and the signed proof as they
          happen. A spending limit protects you from any server that asks for too much.
        </p>
      </div>
      <Playground />
    </div>
  );
}
