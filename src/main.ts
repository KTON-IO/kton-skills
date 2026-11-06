import type { Network } from "kton-sdk";
import {
  CliError,
  context,
  defaults,
  pool,
  quoteStake,
  quoteUnstake,
  wallet,
} from "./cli.js";
import { disconnect, startConnect, waitConnected } from "./connect.js";
import { link } from "./link.js";
import { send, track } from "./send.js";

const USAGE = `kton: the KTON skill's script. One JSON object per run.
  pool                                       the pool now
  wallet <address>                           a wallet's Gram, KTON and withdrawals
  quote stake <gram> [--address <a>]         what staking would give
  quote unstake <kton|all> --address <a> [--instant]   what unstaking would give
  connect                                    links to connect a wallet (TON Connect)
  connect --wait [seconds]                   wait for the wallet to approve
  send --quote <id>                          send an agreed quote to the wallet to sign
  link --quote <id>                          or a transfer link and QR code for it (fallback)
  track [--sent <id>] [--wait <seconds>]     follow what was sent until it is done
  disconnect                                 end the wallet connection
Options: --testnet. TONCENTER_API_KEY in the environment speeds reads up.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
}

/** Node 20 is the oldest with what TON Connect needs (a global `crypto`). */
const NODE_MAJOR = 20;

async function run(argv: string[]) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < NODE_MAJOR) {
    throw new CliError(
      "node-too-old",
      `This script needs Node.js ${NODE_MAJOR} or later; this is ${process.versions.node}. Install a newer Node.js, or use https://app.kton.io or @ktonio_bot instead.`,
    );
  }
  const args = [...argv];
  const testnet = args.includes("--testnet");
  const waiting = args.includes("--wait");
  const instant = args.includes("--instant");
  const rest = args.filter((a) => a !== "--testnet" && a !== "--instant");
  const address = flag(rest, "--address");
  const quoteId = flag(rest, "--quote");
  const sentId = flag(rest, "--sent");
  const waitAt = rest.indexOf("--wait");
  const waitSeconds =
    waitAt >= 0
      ? Math.min(600, Number(rest[waitAt + 1]) || 120)
      : 0;
  if (waitAt >= 0) rest.splice(waitAt, /^\d+$/.test(rest[waitAt + 1] ?? "") ? 2 : 1);
  const network: Network = testnet ? "testnet" : "mainnet";
  const options = defaults(process.env, network);
  const ctx = context(options);
  const [command, sub, value] = rest;
  if (command === "pool") return pool(ctx, options);
  if (command === "wallet") return wallet(ctx, options, sub);
  if (command === "quote" && sub === "stake")
    return quoteStake(ctx, options, value, address);
  if (command === "quote" && sub === "unstake")
    return quoteUnstake(ctx, options, value, instant ? "instant" : "wait", address);
  if (command === "connect")
    return waiting ? waitConnected(options, waitSeconds) : startConnect(options);
  if (command === "disconnect") return disconnect(options);
  if (command === "send") return send(ctx, options, quoteId);
  if (command === "link") return link(ctx, options, quoteId);
  if (command === "track") return track(ctx, options, sentId, waitSeconds || 60);
  throw new CliError("usage", USAGE);
}

/** No route to TonCenter at all: no network, or a sandbox that blocks it. */
function offline(error: unknown) {
  const cause = (error as { cause?: { code?: string } })?.cause?.code ?? "";
  const text = error instanceof Error ? error.message : String(error);
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ETIMEDOUT/.test(`${text} ${cause}`);
}

const OFFLINE =
  "toncenter.com cannot be reached from here (no network, or a sandbox that blocks it); nothing was read or sent.";

/**
 * An unexpected error, said without passing on what a server answered: that
 * text is not the script's, and the agent reads this output.
 */
function unexpected(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const status = /TonCenter answered (\d{3})/.exec(text)?.[1];
  return status
    ? `TonCenter answered ${status}. Try again in a moment (a TONCENTER_API_KEY helps).`
    : "Something unexpected failed (the network or TonCenter). Try again in a moment.";
}

run(process.argv.slice(2)).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 2);
  },
  (error: unknown) => {
    const known = error instanceof CliError;
    // For whoever debugs the script, never in the output the agent reads.
    if (process.env.KTON_SKILL_DEBUG && !known) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          code: known ? error.code : offline(error) ? "network-unreachable" : "error",
          summary: [known ? error.message : offline(error) ? OFFLINE : unexpected(error)],
        },
        null,
        2,
      )}\n`,
    );
    process.exit(known ? 2 : 1);
  },
);
