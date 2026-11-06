import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { context, type Options } from "../src/cli.js";
import { keepSent, type Sent, track } from "../src/send.js";

/**
 * TonCenter (testnet) as captured on 2026-11-06 for the test wallet, after it
 * staked 2 Gram, unstaked 1 KTON at once and 1 KTON at the rotation through
 * the skill. Only the KTON balance and the receipts are set per case.
 */
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
const TXS = fixture("testnet-transactions-test-wallet-2026-11-06")
  .transactions as { lt: string; now: number }[];
const WALLET =
  "0:efe568a002b1549a6690421b30b601b69906faa7a390e92dc4e91caba9a37acd";

/** The three requests in that history: their query ids, the wallet's last lt before each, and when each landed. */
const STAKE = { queryId: "3808594797428", afterLt: "107911137000003", landed: 1793949983 };
const INSTANT = { queryId: "175352376147586", afterLt: "107911743000013", landed: 1793950054 };
const WAIT = { queryId: "21575031779584", afterLt: "107911923000009", landed: 1793950090 };

function chain({ kton, receipts, transactionsFail = false }: { kton: string; receipts: boolean; transactionsFail?: boolean }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v3/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === "transactions") {
      if (transactionsFail) return new Response("down", { status: 500 });
      const from = BigInt(url.searchParams.get("start_lt") ?? "0");
      return Response.json({
        transactions: TXS.filter((tx) => BigInt(tx.lt) >= from),
        address_book: {},
      });
    }
    if (path === "runGetMethod" && body?.method === "get_pool_full_data")
      return Response.json(fixture("testnet-pool-full-data-2026-11-06"));
    if (path === "runGetMethod" && body?.method === "get_bill_amount")
      return Response.json(fixture("testnet-get-bill-amount"));
    if (path === "account") return Response.json(fixture("testnet-account-test-wallet"));
    if (path === "jetton/wallets") {
      const answer = fixture("testnet-jetton-wallets-test-wallet");
      answer.jetton_wallets[0].balance = kton;
      return Response.json(answer);
    }
    if (path === "nft/items")
      return Response.json(receipts ? fixture("testnet-nft-items-test-wallet") : { nft_items: [] });
    return new Response(`unexpected ${path}`, { status: 500 });
  }) as typeof globalThis.fetch;
}

function setup(
  request: { queryId: string; afterLt: string },
  sent: Partial<Sent>,
  chainState: Parameters<typeof chain>[0],
  at: number,
) {
  const options: Options = {
    network: "testnet",
    apiKey: "test",
    home: mkdtempSync(join(tmpdir(), "kton-skill-track-")),
    now: () => at * 1000,
    fetch: chain(chainState),
  };
  const record: Sent = {
    id: "0123456789ab",
    network: "testnet",
    kind: "unstake",
    amount: "1000000000",
    wallet: WALLET,
    before: { kton: "0", gram: "5000000000", withdrawals: 0 },
    expected: "0",
    sentAt: at * 1000,
    ...request,
    ...sent,
  };
  keepSent(options, record);
  return { options, ctx: context(options) };
}

describe("following a request on chain", () => {
  it("finds its own deposit by query id and reports the KTON minted", async () => {
    const { options, ctx } = setup(
      STAKE,
      { kind: "stake", amount: "2000000000", expected: "4204800000" },
      { kton: "4204867221", receipts: false },
      STAKE.landed + 20,
    );
    expect(await track(ctx, options, undefined, 0)).toMatchObject({ state: "staked" });
  });

  it("calls an instant unstake paid when the pool's payout arrives", async () => {
    const { options, ctx } = setup(
      INSTANT,
      { mode: "instant", before: { kton: "4204867221", gram: "1000000000", withdrawals: 0 } },
      { kton: "3204867221", receipts: false },
      INSTANT.landed + 20,
    );
    expect(await track(ctx, options, undefined, 0)).toMatchObject({ state: "paid" });
  });

  it("calls an unstake at the rotation queued once its receipt is in the wallet", async () => {
    const { options, ctx } = setup(
      WAIT,
      { mode: "wait", before: { kton: "3204867221", gram: "1000000000", withdrawals: 0 } },
      { kton: "2204867221", receipts: true },
      WAIT.landed + 20,
    );
    expect(await track(ctx, options, undefined, 0)).toMatchObject({ state: "queued" });
  });

  it("gives the pool time from when the request landed, not from when it was sent", async () => {
    // Sent five minutes before the wallet approved it; the KTON is not burned yet.
    const sent = { mode: "wait" as const, before: { kton: "3204867221", gram: "1000000000", withdrawals: 0 }, sentAt: (WAIT.landed - 300) * 1000 };
    const state = { kton: "3204867221", receipts: false };
    const early = setup(WAIT, sent, state, WAIT.landed + 30);
    expect(await track(early.ctx, early.options, undefined, 0)).toMatchObject({ state: "on-chain" });
    const later = setup(WAIT, sent, state, WAIT.landed + 120);
    expect(await track(later.ctx, later.options, undefined, 0)).toMatchObject({ state: "returned" });
  });

  it("never takes another request from the same wallet for this one", async () => {
    // The wallet's burns are all there, but none carries this query id.
    const { options, ctx } = setup(
      { queryId: "1", afterLt: STAKE.afterLt },
      { mode: "wait", before: { kton: "4204867221", gram: "1000000000", withdrawals: 0 } },
      { kton: "2204867221", receipts: true },
      WAIT.landed + 600,
    );
    expect(await track(ctx, options, undefined, 0)).toMatchObject({ state: "not-sent-yet" });
  });

  it("says it could not read the chain rather than that nothing is there", async () => {
    const { options, ctx } = setup(
      WAIT,
      { mode: "wait" },
      { kton: "2204867221", receipts: true, transactionsFail: true },
      WAIT.landed + 20,
    );
    expect(await track(ctx, options, undefined, 0)).toMatchObject({ state: "unreadable" });
  });

  it("follows only what was sent on the network it is asked about", async () => {
    const { options, ctx } = setup(WAIT, { network: "mainnet" }, { kton: "0", receipts: false }, WAIT.landed);
    await expect(track(ctx, options, undefined, 0)).rejects.toMatchObject({ code: "nothing-sent" });
    await expect(track(ctx, options, "0123456789ab", 0)).rejects.toMatchObject({ code: "wrong-network" });
  });
});
