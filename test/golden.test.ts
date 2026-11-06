import { Cell } from "@ton/core";
import { buildStakeMessage, buildUnstakeMessage } from "kton-sdk";
import { describe, expect, it } from "vitest";

/**
 * The messages the skill signs, bit for bit as app.kton.io builds them
 * (app-kton-io src/modules/ton/utils/lstMessageBuilders.ts, run on
 * 2026-11-06 with these inputs; the owner is the skill's testnet test wallet).
 */
const APP = {
  deposit: "te6cckEBAQEADgAAGEfVQ5EAAAAAAAAABwKlTIA=",
  wait: "te6cckEBAgEAOAABZFlfB7wAAAAAAAAAAESY1YgIAd/K0UAFYqk0zSCENmFsA20yDfVPRyHSW4nSOVdTRvWbAQABoLT8Luw=",
  instant:
    "te6cckEBAgEAOAABZFlfB7wAAAAAAAAAAESY1YgIAd/K0UAFYqk0zSCENmFsA20yDfVPRyHSW4nSOVdTRvWbAQABYHDaoy8=",
};
const POOL = "EQA9HwEZD_tONfVz6lJS0PVKR5viEiEGyj9AuQewGQVnXPg0";
const OWNER =
  "0:efe568a002b1549a6690421b30b601b69906faa7a390e92dc4e91caba9a37acd";
const JETTON_WALLET = "EQBuIhXNNkWf9AW9miNGNTSO_uFZ23ejfIWrieXge5f733mw";
const same = (a: string, b: string) =>
  expect(Cell.fromBase64(a).hash().toString("hex")).toBe(
    Cell.fromBase64(b).hash().toString("hex"),
  );

describe("the messages match app.kton.io's", () => {
  it("deposits like the app", () => {
    const message = buildStakeMessage({
      pool: POOL,
      amount: 10_000_000_000n,
      queryId: 7n,
    });
    same(message.payload, APP.deposit);
    expect(message.address).toBe(POOL);
    // The stake plus the 1 Gram reserve.
    expect(message.amount).toBe("11000000000");
  });

  it("burns to wait for the rotation like the app", () => {
    const message = buildUnstakeMessage({
      jettonWallet: JETTON_WALLET,
      amount: 1_234_000_000n,
      owner: OWNER,
      mode: "wait",
    });
    same(message.payload, APP.wait);
  });

  it("burns to be paid at once, or minted back, like the app", () => {
    const message = buildUnstakeMessage({
      jettonWallet: JETTON_WALLET,
      amount: 1_234_000_000n,
      owner: OWNER,
      mode: "instant",
    });
    same(message.payload, APP.instant);
  });
});
