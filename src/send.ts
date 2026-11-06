import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Address, Cell, fromNano } from "@ton/core";
import { UserRejectsError } from "@tonconnect/sdk";
import {
  buildStakeMessage,
  buildUnstakeMessage,
  checkWithdrawal,
} from "kton-sdk";
import {
  CliError,
  consumeQuote,
  type context,
  type Options,
  readQuote,
} from "./cli.js";
import { requireWallet } from "./connect.js";
import { CHAIN_ID, STAKE_GAS, STAKE_RESERVE, UNSTAKE_GAS, UNSTAKE_RESERVE, WALLET_WAIT_SECONDS } from "./pins.js";

/**
 * Sending a quoted stake or unstake to the connected wallet, and following it
 * on chain. Only a quote the script made (and the user agreed to) can be
 * sent: same kind, amount, network and wallet. Everything the quote checked
 * is checked again just before sending. How it ended is read from the chain
 * (the wallet's new transaction after the last one before sending, then the
 * balances), never from the wallet's reply alone: a phone that goes to the
 * background loses the reply.
 */

type Context = ReturnType<typeof context>;

export interface Sent {
  id: string;
  network: string;
  kind: "stake" | "unstake";
  mode?: "wait" | "instant";
  amount: string;
  wallet: string;
  /** The wallet's last transaction before sending. */
  afterLt: string;
  before: { kton: string; gram: string; withdrawals: number };
  expected: string;
  sentAt: number;
  queryId: string;
}

const gram = (nano: bigint) => {
  const text = fromNano(nano);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
};

export function keepSent(options: Options, sent: Sent) {
  const dir = join(options.home, "sent");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${sent.id}.json`), JSON.stringify(sent), {
    mode: 0o600,
  });
}

function latestSent(options: Options, id?: string): Sent {
  const dir = join(options.home, "sent");
  let sent: Sent | undefined;
  try {
    if (id) {
      if (!/^[0-9a-f]{12}$/.test(id)) throw new Error();
      sent = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as Sent;
    } else {
      // The latest sent on this network: a testnet send is never followed as
      // a mainnet one.
      sent = readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Sent)
        .filter((one) => one.network === options.network)
        .sort((a, b) => b.sentAt - a.sentAt)[0];
    }
  } catch {
    sent = undefined;
  }
  if (!sent) throw new CliError("nothing-sent", "Nothing sent to follow on this network");
  if (sent.network !== options.network) {
    throw new CliError("wrong-network", `That was sent on ${sent.network}; run track with${sent.network === "testnet" ? "" : "out"} --testnet`);
  }
  return sent;
}

export async function snapshot(ctx: Context, owner: Address) {
  const [kton, gramBalance, withdrawals] = await Promise.all([
    ctx.kton.getStakedBalance(owner),
    ctx.kton.getBalance(owner),
    ctx.kton.getWithdrawals(owner),
  ]);
  return { kton, gram: gramBalance, withdrawals: withdrawals.length };
}

export async function send(ctx: Context, options: Options, quoteId: string | undefined) {
  if (!quoteId) throw new CliError("no-quote", "Send needs --quote <id> from a quote the user agreed to");
  const quote = readQuote(options, quoteId);
  if (quote.network !== options.network) {
    throw new CliError("wrong-network", `The quote is for ${quote.network}`);
  }
  const { tc, about, address } = await (options.wallet ?? requireWallet)(options);
  if (!quote.address) {
    throw new CliError(
      "quote-without-wallet",
      `Quote again with --address ${about.address} (the connected wallet), so the quote checks its balance`,
    );
  }
  if (!Address.parseRaw(quote.address).equals(address)) {
    throw new CliError(
      "wrong-wallet",
      `The quote is for another wallet than the connected one (${about.address}); quote again for this one`,
    );
  }
  // Checked again now: the pool, its code, the balances.
  const { pool, balance: poolBalance, rotationPending } = await ctx.verifiedPool();
  const amount = BigInt(quote.amount);
  const before = await snapshot(ctx, address);
  const queryId = BigInt(`0x${randomBytes(6).toString("hex")}`);
  let message;
  let expected: bigint;
  if (quote.kind === "stake") {
    if (pool.halted || pool.state !== 0 || !pool.depositsOpen) {
      throw new CliError("not-taking-deposits", "The pool is not taking deposits right now");
    }
    if (before.gram < amount + STAKE_RESERVE + STAKE_GAS) {
      throw new CliError("not-enough-gram", "The wallet no longer holds enough Gram for this stake");
    }
    message = buildStakeMessage({
      pool: ctx.pin.pool,
      amount,
      queryId,
      testnet: options.network === "testnet",
    });
    expected =
      pool.projectedTotalBalance > 0n
        ? (amount * pool.projectedSupply) / pool.projectedTotalBalance
        : amount;
  } else {
    const mode = quote.mode ?? "wait";
    if (before.kton < amount) {
      throw new CliError("not-enough-kton", "The wallet no longer holds that much KTON");
    }
    if (before.gram < UNSTAKE_RESERVE + UNSTAKE_GAS) {
      throw new CliError("not-enough-gram", "The wallet no longer holds enough Gram for the fees");
    }
    const check = checkWithdrawal(pool, poolBalance, amount, mode, { rotationPending });
    if (!check.accepted) {
      throw new CliError(
        check.reason ?? "refused",
        "The pool would no longer take this; quote again",
      );
    }
    message = buildUnstakeMessage({
      jettonWallet: await ctx.kton.getJettonWallet(address),
      amount,
      owner: address,
      mode,
      queryId,
      testnet: options.network === "testnet",
    });
    expected = check.receive;
  }
  const afterLt = await ctx.lastLt(address);
  // From here the quote cannot be sent again, even if this process dies.
  consumeQuote(options, quoteId);
  const sent: Sent = {
    id: randomBytes(6).toString("hex"),
    network: options.network,
    kind: quote.kind,
    mode: quote.mode,
    amount: quote.amount,
    wallet: address.toRawString(),
    afterLt,
    before: {
      kton: before.kton.toString(),
      gram: before.gram.toString(),
      withdrawals: before.withdrawals,
    },
    expected: expected.toString(),
    sentAt: options.now(),
    queryId: queryId.toString(),
  };
  keepSent(options, sent);
  const request = tc.sendTransaction({
    validUntil: Math.floor(options.now() / 1000) + WALLET_WAIT_SECONDS + 60,
    network: CHAIN_ID[options.network] as "-239" | "-3",
    from: address.toRawString(),
    messages: [message],
  });
  const answer = await Promise.race([
    request.then(
      () => "signed" as const,
      (error: unknown) =>
        error instanceof UserRejectsError ? ("declined" as const) : ("failed" as const),
    ),
    new Promise<"waiting">((resolve) =>
      setTimeout(() => resolve("waiting"), WALLET_WAIT_SECONDS * 1000),
    ),
  ]);
  const what =
    quote.kind === "stake"
      ? `stake of ${gram(amount)} Gram`
      : `unstake of ${gram(amount)} KTON (${quote.mode === "instant" ? "at once" : "at the rotation"})`;
  if (answer === "declined") {
    return { ok: false, code: "declined", sent: sent.id, summary: [`The ${what} was declined in the wallet. Nothing was sent.`] };
  }
  if (answer === "failed") {
    return { ok: false, code: "wallet-failed", sent: sent.id, summary: [`The wallet did not send the ${what}. Run track to make sure, then try again if nothing went out.`] };
  }
  if (answer === "waiting") {
    return {
      ok: true,
      sent: sent.id,
      state: "waiting-for-wallet",
      summary: [`The ${what} is waiting for approval in the wallet. Approve it there, then run track.`],
    };
  }
  return {
    ok: true,
    sent: sent.id,
    state: "signed",
    summary: [`The wallet signed the ${what}. Run track to follow it until it is done on chain (usually under a minute).`],
  };
}

interface ChainMessage {
  source?: string | null;
  opcode?: string | null;
  bounced?: boolean | null;
  message_content?: { body?: string | null } | null;
}

interface ChainTransaction {
  lt: string;
  now: number;
  in_msg?: ChainMessage | null;
  out_msgs?: ChainMessage[];
}

const OP_DEPOSIT = 0x47d54391;
const OP_BURN = 0x595f07bc;
/** The pool's payout of an instant withdrawal (`withdrawal`, 0x0a77535c). */
const OP_POOL_PAYOUT = "0x0a77535c";
/** How long after this request lands the pool has to answer before a missing answer means it was returned. */
const SETTLE_SECONDS = 90;

/** The query id a deposit or burn body carries, or null for any other message. */
function queryIdOf(message: ChainMessage, op: number): string | null {
  const body = message.message_content?.body;
  if (!body) return null;
  try {
    const slice = Cell.fromBase64(body).beginParse();
    if (slice.loadUint(32) !== op) return null;
    return slice.loadUintBig(64).toString();
  } catch {
    return null;
  }
}

const sameAddress = (raw: string | null | undefined, address: Address) => {
  try {
    return !!raw && Address.parseRaw(raw).equals(address);
  } catch {
    return false;
  }
};

/**
 * Follows a sent request on chain: finds the wallet's transaction that sent
 * it (by its own query id, so another stake or burn from the same wallet is
 * never taken for it), then reads how it ended. Every reading comes from the
 * chain, so a later run picks up where an earlier one stopped.
 */
export async function track(ctx: Context, options: Options, id: string | undefined, waitSeconds: number) {
  const sent = latestSent(options, id);
  const owner = Address.parseRaw(sent.wallet);
  const pool = Address.parse(ctx.pin.pool);
  const until = options.now() + waitSeconds * 1000;
  const amount = BigInt(sent.amount);
  const before = {
    kton: BigInt(sent.before.kton),
    gram: BigInt(sent.before.gram),
    withdrawals: sent.before.withdrawals,
  };
  const op = sent.kind === "stake" ? OP_DEPOSIT : OP_BURN;
  let state = "not-sent-yet";
  // The figures of a finished request, for its summary.
  let done = "";
  for (;;) {
    state = await look();
    if (FINAL.has(state) || options.now() >= until) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { ok: true, sent: sent.id, state, summary: [done || SUMMARY[state]] };

  async function look(): Promise<string> {
    let txs: ChainTransaction[];
    try {
      const answer = await ctx.api.get<{ transactions: ChainTransaction[] }>("transactions", {
        account: owner.toRawString(),
        start_lt: (BigInt(sent.afterLt) + 1n).toString(),
        sort: "asc",
        limit: 50,
      });
      txs = answer.transactions ?? [];
    } catch {
      return "unreadable";
    }
    const at = txs.findIndex((tx) =>
      (tx.out_msgs ?? []).some((out) => queryIdOf(out, op) === sent.queryId),
    );
    if (at < 0) return "not-sent-yet";
    const ours = txs[at];
    const later = txs.slice(at + 1);
    const settled = options.now() / 1000 - ours.now > SETTLE_SECONDS;
    let now: Awaited<ReturnType<typeof snapshot>>;
    try {
      now = await snapshot(ctx, owner);
    } catch {
      return "unreadable";
    }
    const fromPool = later.find(
      (tx) => sameAddress(tx.in_msg?.source, pool) && !tx.in_msg?.bounced,
    );
    const bounced = later.some(
      (tx) => tx.in_msg?.bounced && sameAddress(tx.in_msg?.source, pool),
    );
    if (sent.kind === "stake") {
      if (now.kton - before.kton >= (BigInt(sent.expected) * 99n) / 100n) {
        done = `Done: ${gram(now.kton - before.kton)} KTON arrived; the wallet now holds ${gram(now.kton)} KTON.`;
        return "staked";
      }
      if (bounced) return "returned";
      return settled ? "late" : "on-chain";
    }
    const burned = now.kton <= before.kton - amount;
    if (sent.mode === "instant" && fromPool?.in_msg?.opcode === OP_POOL_PAYOUT) {
      done = `Done: the pool paid at once; the wallet's Gram went from ${gram(before.gram)} to ${gram(now.gram)}.`;
      return "paid";
    }
    if (burned && now.withdrawals > before.withdrawals) return "queued";
    if (!burned && settled) return "returned";
    return settled ? "late" : "on-chain";
  }
}

const FINAL = new Set(["staked", "paid", "queued", "returned"]);
const SUMMARY: Record<string, string> = {
  "not-sent-yet": "Nothing from this request is on chain yet. If it was approved in the wallet, run track again in a minute.",
  unreadable: "TonCenter did not answer, so it is not known yet whether this is on chain. Run track again in a moment.",
  "on-chain": "It is on chain and still settling; run track again in a minute.",
  late: "It is on chain, but the pool has not finished with it yet. Run track again later, or wallet to see the balances.",
  queued: "Done: the withdrawal is queued; the wallet holds its receipt until the next rotation pays it (wallet shows when).",
  returned: "The pool returned this request: what was sent should be back in the wallet, less only network fees. Run wallet to see it is, then quote again; a smaller amount or the other way may work.",
};

/** For tests: a boc's hash, to compare what was sent. */
export const bocHash = (boc: string) => Cell.fromBase64(boc).hash().toString("hex");
