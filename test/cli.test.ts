import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CliError,
  context,
  type Options,
  pool,
  quoteStake,
  quoteUnstake,
  readQuote,
} from "../src/cli.js";

/**
 * TonCenter as captured: the mainnet pool on 2026-11-06, and for the holder
 * the skill's own test wallet (captured on testnet the same day; only its
 * balances matter here).
 */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
const HOLDER =
  "0:efe568a002b1549a6690421b30b601b69906faa7a390e92dc4e91caba9a37acd";
const POOL_RAW =
  "0:3d1f01190ffb4e35f573ea5252d0f54a479be2122106ca3f40b907b01905675c";

function chain(overrides: { poolCode?: string } = {}) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const answer = (() => {
      if (path === "account") {
        const address = url.searchParams.get("address");
        if (address === POOL_RAW) {
          const account = fixture("pool-account-with-code");
          return overrides.poolCode
            ? { ...account, code: overrides.poolCode }
            : account;
        }
        if (address === HOLDER) return fixture("testnet-account-test-wallet");
      }
      if (path === "runGetMethod" &&
        (body?.method === "get_pool_full_data" ||
          body?.method === "get_pool_full_data_raw"))
        return fixture("pool-full-data-2026-11-06");
      if (path === "runGetMethod" && body?.method === "get_bill_amount")
        return fixture("testnet-get-bill-amount");
      if (path === "jetton/wallets")
        return fixture(
          url.searchParams.get("owner_address") === HOLDER
            ? "testnet-jetton-wallets-test-wallet"
            : "jetton-wallets-none",
        );
      if (path === "nft/items") return fixture("testnet-nft-items-test-wallet");
      if (path === "validators/cycles") return fixture("validator-cycles");
      if (path === "messages") return { messages: [] };
      return undefined;
    })();
    return answer === undefined
      ? new Response(`unexpected ${path}`, { status: 500 })
      : Response.json(answer);
  }) as typeof globalThis.fetch;
}

function setup(overrides: { poolCode?: string } = {}) {
  const options: Options = {
    network: "mainnet",
    home: mkdtempSync(join(tmpdir(), "kton-skill-")),
    // Inside the captured validation cycles.
    now: () => 1790540000 * 1000,
    fetch: chain(overrides),
  };
  return { options, ctx: context(options) };
}

describe("the KTON skill's script", () => {
  it("refuses a pool whose code is not the one it knows", async () => {
    const { options, ctx } = setup({
      poolCode: "te6cckEBAQEAAgAAAEysuc0=",
    });
    await expect(pool(ctx, options)).rejects.toMatchObject({
      code: "pool-code-changed",
    });
  });

  it("says so when the pool has not rotated for over a cycle", async () => {
    // The captured messages hold no round log: no rotation seen.
    const { options, ctx } = setup();
    const result = await pool(ctx, options);
    expect(result.status).toBe("rotation-stalled");
    expect(result.summary.join(" ")).toMatch(/has not rotated/);
  });

  it("checks the amount before reading the chain", async () => {
    const { options, ctx } = setup();
    for (const [text, code] of [
      ["0.5", "too-small"],
      ["abc", "bad-amount"],
      ["1.0000000001", "bad-amount"],
      ["-3", "bad-amount"],
    ]) {
      await expect(quoteStake(ctx, options, text)).rejects.toMatchObject({
        code,
      });
    }
  });

  it("quotes a stake and keeps the quote for ten minutes", async () => {
    const { options, ctx } = setup();
    const quote = await quoteStake(ctx, options, "10");
    expect(quote.walletSendsGram).toBe("11");
    expect(Number(quote.receiveKton)).toBeGreaterThan(9);
    expect(Number(quote.receiveKton)).toBeLessThan(10);
    const kept = readQuote(options, quote.quote);
    expect(kept).toMatchObject({ kind: "stake", amount: "10000000000" });
    const later = { ...options, now: () => options.now() + 601_000 };
    expect(() => readQuote(later, quote.quote)).toThrow(CliError);
    expect(() => readQuote(options, "../../etc")).toThrow(/Not a quote id/);
  });

  it("will not quote more KTON than the wallet holds", async () => {
    const { options, ctx } = setup();
    await expect(
      quoteUnstake(ctx, options, "1000000", "wait", HOLDER),
    ).rejects.toMatchObject({ code: "not-enough-kton" });
  });

  it("calls an unstake of nothing a bad amount, not a short balance", async () => {
    const { options, ctx } = setup();
    await expect(
      quoteUnstake(ctx, options, "0", "wait", HOLDER),
    ).rejects.toMatchObject({ code: "bad-amount" });
  });

  it("says a quote stands only until it expires, and writes nothing else", async () => {
    const { options, ctx } = setup();
    const quote = await quoteStake(ctx, options, "2");
    const file = join(options.home, "quotes", `${quote.quote}.json`);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved).sort()).toEqual(
      ["amount", "expiresAt", "id", "kind", "network"].sort(),
    );
    writeFileSync(file, "not json");
    expect(() => readQuote(options, quote.quote)).toThrow(/No such quote/);
  });
});
