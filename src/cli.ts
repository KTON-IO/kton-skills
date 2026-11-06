import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Address, Cell, fromNano, toNano } from "@ton/core";
import {
  checkWithdrawal,
  KTON,
  type Network,
  type PoolData,
  TonCenter,
  type WithdrawalMode,
} from "kton-sdk";
import {
  APY_DAYS,
  MIN_STAKE,
  PINS,
  QUOTE_SECONDS,
  STALL_SECONDS,
  STAKE_GAS,
  STAKE_RESERVE,
  UNSTAKE_GAS,
  UNSTAKE_RESERVE,
} from "./pins.js";

/**
 * The KTON skill's script (kton/SKILL.md runs it). Every command prints one
 * JSON object: `ok`, the facts, and `summary`, plain English lines the agent
 * turns into the user's language. This file reads the pool and wallets and
 * makes quotes; sending a quote goes through the user's wallet (send.ts), and
 * no key or recovery phrase is ever asked for or read.
 */

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Options {
  network: Network;
  apiKey?: string;
  home: string;
  now: () => number;
  fetch?: typeof globalThis.fetch;
  /** The connected wallet; tests pass their own. */
  wallet?: (options: Options) => Promise<ConnectedWallet>;
}

/** What sending needs of the connected wallet. */
export interface ConnectedWallet {
  tc: {
    sendTransaction(request: {
      validUntil: number;
      network?: "-239" | "-3";
      from?: string;
      messages: { address: string; amount: string; payload?: string }[];
    }): Promise<unknown>;
  };
  about: { address: string; walletApp: string; network: string };
  address: Address;
}

const gram = (nano: bigint) => trim(fromNano(nano));
const trim = (decimal: string) =>
  decimal.includes(".") ? decimal.replace(/\.?0+$/, "") : decimal;
/** A figure rounded to 4 decimals with thousands grouped, for the summary. */
const short = (nano: bigint) => {
  const tenThousandths = (nano + 50_000n) / 100_000n;
  const whole = tenThousandths / 10_000n;
  const part = (tenThousandths % 10_000n).toString().padStart(4, "0");
  return `${whole.toLocaleString("en-US")}.${part}`;
};
const iso = (date: Date) => date.toISOString();
const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;

function parseAmount(text: string | undefined, what: string): bigint {
  if (!text || !/^\d+(\.\d{1,9})?$/.test(text)) {
    throw new CliError(
      "bad-amount",
      `${what} must be a number like 10 or 2.5, got ${text ?? "nothing"}`,
    );
  }
  return toNano(text);
}

function parseAddress(text: string | undefined): Address {
  try {
    if (!text) throw new Error();
    return Address.parse(text);
  } catch {
    throw new CliError(
      "bad-address",
      `Not a TON address: ${text ?? "nothing"}`,
    );
  }
}

export function context(options: Options) {
  const pin = PINS[options.network];
  const kton = new KTON({
    network: options.network,
    apiKey: options.apiKey,
    fetch: options.fetch,
  });
  const api = new TonCenter({
    endpoint: pin.toncenter,
    apiKey: options.apiKey,
    fetch: options.fetch,
  });

  /** The pool, checked to be the one this skill knows. */
  async function verifiedPool(): Promise<{
    pool: PoolData;
    balance: bigint;
    rotationPending: boolean;
  }> {
    const account = await api.get<{ code: string; balance: string }>(
      "account",
      { address: Address.parse(pin.pool).toRawString() },
    );
    const hash = Cell.fromBase64(account.code).hash().toString("hex");
    if (hash !== pin.codeHash) {
      throw new CliError(
        "pool-code-changed",
        `The pool at ${pin.pool} runs code ${hash}, not the code this skill knows (${pin.codeHash}). Stop and check kton.io before doing anything.`,
      );
    }
    const [pool, stored] = await Promise.all([
      kton.getPoolData(),
      kton.getPoolDataRaw(),
    ]);
    if (pin.minter && !pool.jettonMinter.equals(Address.parse(pin.minter))) {
      throw new CliError(
        "pool-minter-changed",
        "The pool's KTON minter is not the one this skill knows.",
      );
    }
    return {
      pool,
      balance: BigInt(account.balance),
      // The validator set has changed and the pool has not rotated yet.
      rotationPending:
        pool.previousRound.roundId !== stored.previousRound.roundId,
    };
  }

  /** When the pool last rotated, and whether it has stalled since. */
  async function rotation(now: number) {
    const last = await kton.getLastRotation().catch(() => null);
    const stalled = !last || now / 1000 - last.time > STALL_SECONDS;
    return { last: last ? new Date(last.time * 1000) : null, stalled };
  }

  /**
   * The wallet's last transaction now, from the same rate-limited client, so a
   * send can be followed from just after it. Throws rather than guess: from
   * the wrong point, track would read old transactions as this one.
   */
  async function lastLt(wallet: Address): Promise<string> {
    const account = await api
      .get<{ last_transaction_lt?: string | null; status?: string }>("account", {
        address: wallet.toRawString(),
      })
      .catch(() => {
        throw new CliError(
          "chain-unreadable",
          "TonCenter did not answer for the wallet; nothing was sent. Try again in a moment (a TONCENTER_API_KEY helps).",
        );
      });
    if (!account.last_transaction_lt) {
      throw new CliError("chain-unreadable", "TonCenter gave no last transaction for the wallet; nothing was sent.");
    }
    return account.last_transaction_lt;
  }

  return { pin, kton, api, verifiedPool, rotation, lastLt };
}

type Context = ReturnType<typeof context>;

export async function pool(ctx: Context, options: Options) {
  const { pool, balance } = await ctx.verifiedPool();
  const [apy, schedule, rotated] = await Promise.all([
    ctx.kton.getRealizedApy({ days: APY_DAYS }),
    ctx.kton.getSchedule(options.now()),
    ctx.rotation(options.now()),
  ]);
  const rate = Number(pool.totalBalance) / Number(pool.supply || 1n);
  const instantFree = balance > 10_000_000_000n ? balance - 10_000_000_000n : 0n;
  const at = new Date(options.now());
  return {
    ok: true,
    network: options.network,
    pool: ctx.pin.pool,
    readAt: iso(at),
    status: pool.halted
      ? "halted"
      : !pool.depositsOpen
        ? "deposits-closed"
        : rotated.stalled
          ? "rotation-stalled"
          : "open",
    lastRotation: rotated.last ? iso(rotated.last) : null,
    ktonValue: rate.toFixed(6),
    totalGram: gram(pool.totalBalance),
    realizedApy: apy
      ? {
          value: pct(apy.apy),
          days: Math.round(apy.days * 10) / 10,
          method:
            "the share price the pool logged at each round end over these days, after the pool's fee, compounded to a year; past, not a promise",
        }
      : null,
    governanceFee: pct(pool.governanceFee),
    instantFee: pct(pool.instantWithdrawalFee),
    instantAvailableGram: gram(instantFree),
    nextPayout: iso(schedule.nextPayout),
    nextRotation: iso(schedule.nextRotation),
    summary: [
      `KTON pool (${options.network}) read at ${iso(at)}: ${pool.halted ? "HALTED, no deposits or withdrawals" : rotated.stalled ? `taking deposits, but it has not rotated since ${rotated.last ? iso(rotated.last) : "long ago"}, so payouts and queued withdrawals wait until it does` : "working normally"}.`,
      `1 KTON = ${rate.toFixed(6)} Gram. Total in the pool: ${short(pool.totalBalance)} Gram.`,
      apy
        ? `Realized yearly yield over about the last ${Math.round(apy.days)} days: ${pct(apy.apy)} (after the pool's ${pct(pool.governanceFee)} fee; past results, not a promise).`
        : "Realized yield: not enough rounds to measure yet.",
      rotated.stalled
        ? "Next payout and rotation: when the pool rotates again; the usual schedule does not hold while it is stalled."
        : `Next payout ${iso(schedule.nextPayout)}; queued withdrawals are paid at the next rotation, ${iso(schedule.nextRotation)}.`,
      `Instant withdrawals: fee ${pct(pool.instantWithdrawalFee)}, up to about ${short(instantFree)} Gram can be paid at once right now.`,
    ],
  };
}

export async function wallet(ctx: Context, options: Options, address: string) {
  const owner = parseAddress(address);
  const { pool } = await ctx.verifiedPool();
  const [gramBalance, kton, withdrawals, schedule, rotated] = await Promise.all([
    ctx.kton.getBalance(owner),
    ctx.kton.getStakedBalance(owner),
    ctx.kton.getWithdrawals(owner),
    ctx.kton.getSchedule(options.now()),
    ctx.rotation(options.now()),
  ]);
  const worth =
    pool.supply > 0n ? (kton * pool.totalBalance) / pool.supply : 0n;
  const waiting = withdrawals.reduce((sum, w) => sum + w.amount, 0n);
  return {
    ok: true,
    network: options.network,
    address: owner.toString({ bounceable: false, testOnly: options.network === "testnet" }),
    readAt: iso(new Date(options.now())),
    gram: gram(gramBalance),
    kton: gram(kton),
    ktonWorthGram: gram(worth),
    withdrawals: withdrawals.map((w) => ({
      kton: gram(w.amount),
      receipt: w.nft.toString(),
      expectedBy: iso(schedule.nextRotation),
      latestBy: iso(schedule.unstakeArrival),
    })),
    summary: [
      `Wallet ${owner.toString({ bounceable: false, testOnly: options.network === "testnet" })}: ${short(gramBalance)} Gram, ${short(kton)} KTON (worth about ${short(worth)} Gram now).`,
      withdrawals.length
        ? `${withdrawals.length} withdrawal(s) of ${short(waiting)} KTON in total waiting; ${
            rotated.stalled
              ? `paid when the pool rotates again (it has not since ${rotated.last ? iso(rotated.last) : "long ago"}).`
              : `paid at the next rotation, ${iso(schedule.nextRotation)}${
                  schedule.unstakeArrival.getTime() !== schedule.nextRotation.getTime()
                    ? ` (one asked for less than about an hour before it, at the one after, ${iso(schedule.unstakeArrival)})`
                    : ""
                }.`
          }`
        : "No withdrawals waiting.",
    ],
  };
}

interface Quote {
  id: string;
  network: Network;
  kind: "stake" | "unstake";
  mode?: WithdrawalMode;
  /** nanotons to stake, or nano KTON to burn. */
  amount: string;
  address?: string;
  expiresAt: number;
}

function keepQuote(options: Options, quote: Omit<Quote, "id" | "expiresAt">) {
  const id = randomBytes(6).toString("hex");
  const expiresAt = Math.floor(options.now() / 1000) + QUOTE_SECONDS;
  const dir = join(options.home, "quotes");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ ...quote, id, expiresAt }),
    { mode: 0o600 },
  );
  return {
    id,
    readAt: new Date(options.now()).toISOString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

const quoteFile = (options: Options, id: string, used = false) =>
  join(options.home, "quotes", `${id}${used ? ".used" : ""}.json`);

export function readQuote(options: Options, id: string): Quote {
  if (!/^[0-9a-f]{12}$/.test(id)) {
    throw new CliError("bad-quote", "Not a quote id");
  }
  if (existsSync(quoteFile(options, id, true))) {
    throw new CliError(
      "already-sent",
      "This quote was already sent to the wallet (or turned into a link); run track to follow it, or quote again for another transaction",
    );
  }
  let quote: Quote;
  try {
    quote = JSON.parse(
      readFileSync(quoteFile(options, id), "utf8"),
    ) as Quote;
  } catch {
    throw new CliError("unknown-quote", "No such quote; ask for a new one");
  }
  if (quote.expiresAt * 1000 < options.now()) {
    throw new CliError("expired-quote", "The quote expired; ask for a new one");
  }
  return quote;
}

/**
 * Marks a quote used, once: a second send of the same quote (an agent retrying
 * while the wallet still shows the first) is refused instead of reaching the
 * wallet twice. Done before the wallet is asked, so even a send that dies
 * halfway cannot be repeated.
 */
export function consumeQuote(options: Options, id: string) {
  try {
    renameSync(quoteFile(options, id), quoteFile(options, id, true));
  } catch {
    throw new CliError("already-sent", "This quote was already sent; run track to follow it");
  }
}

export async function quoteStake(
  ctx: Context,
  options: Options,
  amountText: string | undefined,
  addressText?: string,
) {
  const amount = parseAmount(amountText, "The amount of Gram to stake");
  if (amount < MIN_STAKE) {
    throw new CliError("too-small", `The smallest stake is ${gram(MIN_STAKE)} Gram`);
  }
  const { pool } = await ctx.verifiedPool();
  if (pool.halted || pool.state !== 0 || !pool.depositsOpen) {
    throw new CliError(
      "not-taking-deposits",
      "The pool is not taking deposits right now",
    );
  }
  const owner = addressText ? parseAddress(addressText) : null;
  const [schedule, balance, rotated] = await Promise.all([
    ctx.kton.getSchedule(options.now()),
    owner ? ctx.kton.getBalance(owner) : Promise.resolve(null),
    ctx.rotation(options.now()),
  ]);
  const firstPayout = rotated.stalled
    ? "when the pool rotates again (it has stalled; the usual schedule does not hold)"
    : iso(schedule.firstPayoutForNewStake);
  const needs = amount + STAKE_RESERVE + STAKE_GAS;
  if (balance !== null && balance < needs) {
    throw new CliError(
      "not-enough-gram",
      `The wallet holds ${short(balance)} Gram; staking ${gram(amount)} needs about ${short(needs)} (the amount, a 1 Gram reserve that mostly comes back, and network fees)`,
    );
  }
  const ktonOut =
    pool.projectedTotalBalance > 0n
      ? (amount * pool.projectedSupply) / pool.projectedTotalBalance
      : amount;
  const kept = keepQuote(options, {
    network: options.network,
    kind: "stake",
    amount: amount.toString(),
    address: owner?.toRawString(),
  });
  return {
    ok: true,
    quote: kept.id,
    readAt: kept.readAt,
    expiresAt: kept.expiresAt,
    network: options.network,
    stakeGram: gram(amount),
    receiveKton: gram(ktonOut),
    walletSendsGram: gram(amount + STAKE_RESERVE),
    reserveBackGram: "about 0.997",
    firstPayout,
    rotationStalled: rotated.stalled,
    summary: [
      `Stake ${gram(amount)} Gram: you receive about ${short(ktonOut)} KTON at once.`,
      `Your wallet sends ${gram(amount + STAKE_RESERVE)} Gram: the stake plus a 1 Gram reserve, of which about 0.997 comes back in the same transaction.`,
      `Its first payout: ${firstPayout}. Payouts raise what each KTON is worth; nothing is paid out separately.`,
      `Read at ${kept.readAt}. Quote ${kept.id}, valid until ${kept.expiresAt}.`,
    ],
  };
}

export async function quoteUnstake(
  ctx: Context,
  options: Options,
  amountText: string | undefined,
  mode: WithdrawalMode,
  addressText: string | undefined,
) {
  const owner = parseAddress(addressText);
  const { pool, balance: poolBalance, rotationPending } = await ctx.verifiedPool();
  const [held, walletGram, schedule, rotated] = await Promise.all([
    ctx.kton.getStakedBalance(owner),
    ctx.kton.getBalance(owner),
    ctx.kton.getSchedule(options.now()),
    ctx.rotation(options.now()),
  ]);
  const waitArrives = rotated.stalled
    ? `when the pool rotates again (it has not since ${rotated.last ? iso(rotated.last) : "long ago"}; the usual schedule does not hold)`
    : `on ${iso(schedule.unstakeArrival)}`;
  const amount =
    amountText === "all" ? held : parseAmount(amountText, "The amount of KTON");
  if (amount <= 0n && amountText !== "all") {
    throw new CliError("bad-amount", `The amount of KTON to unstake must be more than 0, got ${amountText}`);
  }
  if (amount <= 0n || amount > held) {
    throw new CliError(
      "not-enough-kton",
      `The wallet holds ${short(held)} KTON; asked to unstake ${gram(amount)}`,
    );
  }
  if (walletGram < UNSTAKE_RESERVE + UNSTAKE_GAS) {
    throw new CliError(
      "not-enough-gram",
      `Unstaking needs about ${short(UNSTAKE_RESERVE + UNSTAKE_GAS)} Gram in the wallet for fees (most comes back); it holds ${short(walletGram)}`,
    );
  }
  const check = checkWithdrawal(pool, poolBalance, amount, mode, { rotationPending });
  const other = checkWithdrawal(
    pool,
    poolBalance,
    amount,
    mode === "wait" ? "instant" : "wait",
    { rotationPending },
  );
  if (!check.accepted) {
    const why =
      check.reason === "halted"
        ? "The pool is halted: no withdrawals can complete now."
        : check.reason === "rotation-pending"
          ? "The pool is about to rotate; quote again in a few minutes."
        : mode === "instant"
          ? `The pool cannot pay ${gram(amount)} KTON at once right now (at most about ${short(check.limit)} KTON).`
          : `The pool would return this request: it can queue at most about ${short(check.limit)} KTON before the next rotation.`;
    return {
      ok: false,
      code: check.reason,
      mode,
      limitKton: gram(check.limit),
      otherWay: other.accepted ? (mode === "wait" ? "instant" : "wait") : null,
      summary: [
        why,
        other.accepted
          ? mode === "instant"
            ? `Waiting for the rotation works: about ${short(other.receive)} Gram ${waitArrives}, no fee.`
            : `Paying at once works: about ${short(other.receive)} Gram now, fee ${pct(pool.instantWithdrawalFee)}.`
          : "Neither way works for this amount right now; a smaller amount, or later, may.",
      ],
    };
  }
  const kept = keepQuote(options, {
    network: options.network,
    kind: "unstake",
    mode,
    amount: amount.toString(),
    address: owner.toRawString(),
  });
  return {
    ok: true,
    quote: kept.id,
    readAt: kept.readAt,
    expiresAt: kept.expiresAt,
    network: options.network,
    mode,
    unstakeKton: gram(amount),
    receiveGram: gram(check.receive),
    feeGram: gram(check.fee),
    arrives:
      mode === "instant"
        ? "at once"
        : rotated.stalled
          ? "when the pool rotates again"
          : iso(schedule.unstakeArrival),
    rotationStalled: rotated.stalled,
    walletSendsGram: gram(UNSTAKE_RESERVE),
    summary: [
      mode === "instant"
        ? `Unstake ${short(amount)} KTON at once: about ${short(check.receive)} Gram now, after the pool's ${pct(pool.instantWithdrawalFee)} instant fee (${short(check.fee)} Gram). If the pool cannot pay when it arrives, the KTON comes back.`
        : `Unstake ${short(amount)} KTON at the next rotation: about ${short(check.receive)} Gram ${waitArrives}, no fee. Meanwhile the wallet holds a withdrawal receipt (an NFT).`,
      other.accepted
        ? mode === "instant"
          ? `Or wait for the rotation: about ${short(other.receive)} Gram ${waitArrives}, no fee.`
          : `Or at once: about ${short(other.receive)} Gram now, fee ${pct(pool.instantWithdrawalFee)}.`
        : "",
      `Your wallet attaches ${gram(UNSTAKE_RESERVE)} Gram for the fees; most of it comes back.`,
      `Read at ${kept.readAt}. Quote ${kept.id}, valid until ${kept.expiresAt}.`,
    ].filter(Boolean),
  };
}

export function defaults(env: NodeJS.ProcessEnv, network: Network): Options {
  return {
    network,
    apiKey: env.TONCENTER_API_KEY || undefined,
    home: env.KTON_SKILL_HOME || join(homedir(), ".kton-skill"),
    now: () => Date.now(),
  };
}
