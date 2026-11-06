import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address, Cell } from "@ton/core";
import { UserRejectsError } from "@tonconnect/sdk";
import { describe, expect, it } from "vitest";
import {
  type ConnectedWallet,
  context,
  type Options,
  quoteStake,
} from "../src/cli.js";
import { send } from "../src/send.js";

/** TonCenter as captured for the pool; the holder is the skill's test wallet, given 1,000 Gram here. */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
const HOLDER =
  "0:efe568a002b1549a6690421b30b601b69906faa7a390e92dc4e91caba9a37acd";
const OTHER =
  "0:9f3e1a6b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7";
const POOL_RAW =
  "0:3d1f01190ffb4e35f573ea5252d0f54a479be2122106ca3f40b907b01905675c";

const chain = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace("/api/v3/", "");
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const answer = (() => {
    if (path === "account") {
      const address = url.searchParams.get("address");
      if (address === POOL_RAW) return fixture("pool-account-with-code");
      return { balance: "1000000000000", status: "active", last_transaction_lt: "42" };
    }
    if (path === "runGetMethod" &&
        (body?.method === "get_pool_full_data" ||
          body?.method === "get_pool_full_data_raw"))
      return fixture("pool-full-data-2026-11-06");
    if (path === "jetton/wallets") return fixture("jetton-wallets-none");
    if (path === "nft/items") return { nft_items: [] };
    if (path === "validators/cycles") return fixture("validator-cycles");
    return undefined;
  })();
  return answer === undefined
    ? new Response(`unexpected ${path}`, { status: 500 })
    : Response.json(answer);
}) as typeof globalThis.fetch;

function setup(
  answer: () => Promise<unknown>,
  connected = HOLDER,
  fetch: typeof globalThis.fetch = chain,
) {
  const asked: Parameters<ConnectedWallet["tc"]["sendTransaction"]>[0][] = [];
  const wallet = async (): Promise<ConnectedWallet> => ({
    tc: {
      sendTransaction: async (request) => {
        asked.push(request);
        return answer();
      },
    },
    about: { address: connected, walletApp: "test", network: "mainnet" },
    address: Address.parseRaw(connected),
  });
  const options: Options = {
    network: "mainnet",
    home: mkdtempSync(join(tmpdir(), "kton-skill-send-")),
    now: () => 1790540000 * 1000,
    fetch,
    wallet,
  };
  return { options, ctx: context(options), asked };
}

describe("sending a quote to the wallet", () => {
  it("asks the wallet for exactly the quoted stake, to the pinned pool", async () => {
    const { options, ctx, asked } = setup(async () => ({ boc: "te6" }));
    const quote = await quoteStake(ctx, options, "10", HOLDER);
    const result = await send(ctx, options, quote.quote);
    expect(result).toMatchObject({ ok: true, state: "signed" });
    expect(asked).toHaveLength(1);
    const [message] = asked[0].messages;
    expect(message.address).toBe(
      "EQA9HwEZD_tONfVz6lJS0PVKR5viEiEGyj9AuQewGQVnXPg0",
    );
    expect(message.amount).toBe("11000000000");
    const body = Cell.fromBase64(message.payload as string).beginParse();
    expect(body.loadUint(32)).toBe(0x47d54391);
    expect(asked[0].network).toBe("-239");
  });

  it("says a decline plainly, and sends nothing else", async () => {
    const { options, ctx, asked } = setup(async () => {
      throw new UserRejectsError();
    });
    const quote = await quoteStake(ctx, options, "10", HOLDER);
    const result = await send(ctx, options, quote.quote);
    expect(result).toMatchObject({ ok: false, code: "declined" });
    expect(asked).toHaveLength(1);
  });

  it("will not send a quote that names no wallet", async () => {
    const { options, ctx, asked } = setup(async () => ({ boc: "te6" }));
    const quote = await quoteStake(ctx, options, "10");
    await expect(send(ctx, options, quote.quote)).rejects.toMatchObject({
      code: "quote-without-wallet",
    });
    expect(asked).toHaveLength(0);
  });

  it("will not send without a quote, an expired one, or one for another wallet", async () => {
    const { options, ctx, asked } = setup(async () => ({ boc: "te6" }), OTHER);
    await expect(send(ctx, options, undefined)).rejects.toMatchObject({
      code: "no-quote",
    });
    const quote = await quoteStake(ctx, options, "10", HOLDER);
    await expect(send(ctx, options, quote.quote)).rejects.toMatchObject({
      code: "wrong-wallet",
    });
    const later = { ...options, now: () => options.now() + 601_000 };
    await expect(send(ctx, later, quote.quote)).rejects.toMatchObject({
      code: "expired-quote",
    });
    expect(asked).toHaveLength(0);
  });

  it("sends a quote once: a second send of it is refused, not asked again", async () => {
    const { options, ctx, asked } = setup(async () => ({ boc: "te6" }));
    const quote = await quoteStake(ctx, options, "10", HOLDER);
    expect(await send(ctx, options, quote.quote)).toMatchObject({ ok: true });
    await expect(send(ctx, options, quote.quote)).rejects.toMatchObject({
      code: "already-sent",
    });
    expect(asked).toHaveLength(1);
  });

  it("asks nothing of the wallet when it cannot read where to follow from", async () => {
    // The wallet's account answers for the balances, then TonCenter fails.
    let holderReads = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/account") && url.searchParams.get("address") === HOLDER) {
        holderReads += 1;
        if (holderReads > 2) return new Response("down", { status: 500 });
      }
      return chain(input, init);
    }) as typeof globalThis.fetch;
    const { options, ctx, asked } = setup(async () => ({ boc: "te6" }), HOLDER, flaky);
    const quote = await quoteStake(ctx, options, "10", HOLDER);
    await expect(send(ctx, options, quote.quote)).rejects.toMatchObject({
      code: "chain-unreadable",
    });
    expect(asked).toHaveLength(0);
  });
});
