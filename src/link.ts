import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Address, fromNano } from "@ton/core";
import {
  buildStakeMessage,
  buildUnstakeMessage,
  checkWithdrawal,
} from "kton-sdk";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { CliError, consumeQuote, type context, type Options, readQuote } from "./cli.js";
import { keepSent, snapshot } from "./send.js";

/**
 * The fallback for a wallet without TON Connect at hand: a transfer link
 * (`ton://transfer/…?amount=…&bin=…&exp=…`) for an agreed quote, which the
 * wallet decodes and shows for approval. Wallets that read `bin` (from their
 * source, 2026-11-06): My Wallet (formerly MyTonWallet), and the desktop and
 * web apps of Keeper (formerly Tonkeeper). Keeper's phone app, Walt and
 * Telegram's built-in wallet are not confirmed. The payload is
 * standard base64, percent-encoded, which both readers decode to the same
 * bytes. Nothing can be tracked from the reply; `track` reads the chain.
 */

type Context = ReturnType<typeof context>;

const LINK_SECONDS = 300;

export async function link(ctx: Context, options: Options, quoteId: string | undefined) {
  if (!quoteId) {
    throw new CliError("no-quote", "A link needs --quote <id> from a quote the user agreed to");
  }
  const quote = readQuote(options, quoteId);
  if (quote.network !== options.network) {
    throw new CliError("wrong-network", `The quote is for ${quote.network}`);
  }
  if (!quote.address) {
    throw new CliError(
      "quote-without-wallet",
      "Quote again with --address <the wallet that will sign>, so the quote checks its balance and track can follow it",
    );
  }
  const testnet = options.network === "testnet";
  const { pool, balance, rotationPending } = await ctx.verifiedPool();
  const amount = BigInt(quote.amount);
  const queryId = BigInt(`0x${randomBytes(6).toString("hex")}`);
  let message;
  let expected = 0n;
  if (quote.kind === "stake") {
    expected =
      pool.projectedTotalBalance > 0n
        ? (amount * pool.projectedSupply) / pool.projectedTotalBalance
        : amount;
    if (pool.halted || pool.state !== 0 || !pool.depositsOpen) {
      throw new CliError("not-taking-deposits", "The pool is not taking deposits right now");
    }
    message = buildStakeMessage({ pool: ctx.pin.pool, amount, queryId, testnet });
  } else {
    if (!quote.address) {
      throw new CliError("bad-quote", "An unstake quote names its wallet");
    }
    const owner = Address.parseRaw(quote.address);
    const mode = quote.mode ?? "wait";
    const check = checkWithdrawal(pool, balance, amount, mode, { rotationPending });
    if (!check.accepted) {
      throw new CliError("refused", "The pool would no longer take this; quote again");
    }
    expected = check.receive;
    message = buildUnstakeMessage({
      jettonWallet: await ctx.kton.getJettonWallet(owner),
      amount,
      owner,
      mode,
      queryId,
      testnet,
    });
  }
  // With the wallet known, `track` can follow it as it follows a send.
  if (quote.address) {
    const owner = Address.parseRaw(quote.address);
    const before = await snapshot(ctx, owner);
    const afterLt = await ctx.lastLt(owner);
    // One link per quote, as one send per quote.
    consumeQuote(options, quoteId);
    keepSent(options, {
      id: randomBytes(6).toString("hex"),
      network: options.network,
      kind: quote.kind,
      mode: quote.mode,
      amount: quote.amount,
      wallet: owner.toRawString(),
      afterLt,
      before: { kton: before.kton.toString(), gram: before.gram.toString(), withdrawals: before.withdrawals },
      expected: expected.toString(),
      sentAt: options.now(),
      queryId: queryId.toString(),
    });
  }
  const exp = Math.floor(options.now() / 1000) + LINK_SECONDS;
  const query = `amount=${message.amount}&bin=${encodeURIComponent(message.payload)}&exp=${exp}`;
  const ton = `ton://transfer/${message.address}?${query}`;
  const tonkeeper = `https://app.tonkeeper.com/transfer/${message.address}?${query}`;
  const qr = join(options.home, "transfer-qr.svg");
  writeFileSync(qr, await QRCode.toString(ton, { type: "svg" }), { mode: 0o600 });
  return {
    ok: true,
    links: { ton, tonkeeper },
    qr,
    expiresAt: new Date(exp * 1000).toISOString(),
    to: message.address,
    amountGram: fromNano(BigInt(message.amount)),
    summary: [
      `A transfer link for this ${quote.kind}, valid for five minutes: ${ton}`,
      `Keeper on a computer or the web: ${tonkeeper}`,
      `QR code: ${qr}`,
      `In the wallet, check it goes to ${message.address} and sends ${Number(message.amount) / 1e9} Gram before approving. By their source code My Wallet and Keeper's desktop and web apps read such links; no wallet app has been tried with them yet, so prefer TON Connect (connect), which every wallet supports. Then run track.`,
    ],
  };
}
