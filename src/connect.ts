import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Address } from "@ton/core";
import {
  encodeTelegramUrlParameters,
  type ITonConnect,
  TonConnect,
  type Wallet,
} from "@tonconnect/sdk";
import QRCode from "qrcode";
import { CliError, type Options } from "./cli.js";
import { CHAIN_ID, MANIFEST_URL, WALLETS } from "./pins.js";

/**
 * TonConnect, run from the command line: the session lives in a file under the
 * skill's home (mode 600), so `connect` can print the link and end, and a later
 * command finds the wallet's answer on the bridge. The session can only ask
 * the wallet; it cannot move anything. No analytics are sent, and the SDK's
 * debug output (which prints requests) is silenced.
 */

const SESSION_FILE = "tonconnect.json";

function fileStorage(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, SESSION_FILE);
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) =>
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  return {
    setItem: async (key: string, value: string) =>
      write({ ...read(), [key]: value }),
    getItem: async (key: string) => read()[key] ?? null,
    removeItem: async (key: string) => {
      const data = read();
      delete data[key];
      write(data);
    },
  };
}

export function connector(options: Options): ITonConnect {
  // The SDK reports every request through console.debug, wallet address and
  // all: nothing of it belongs in the agent's output.
  console.debug = () => {};
  return new TonConnect({
    manifestUrl: MANIFEST_URL,
    storage: fileStorage(options.home),
    analytics: { mode: "off" },
  });
}

/** The connected wallet, if the session has one, after restoring it. */
export async function restored(
  tc: ITonConnect,
  waitMs = 0,
): Promise<Wallet | null> {
  await tc.restoreConnection().catch(() => {});
  const until = Date.now() + waitMs;
  while (!tc.connected && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return tc.connected ? (tc.wallet as Wallet) : null;
}

function describe(wallet: Wallet, options: Options) {
  const address = Address.parseRaw(wallet.account.address);
  return {
    address: address.toString({
      bounceable: false,
      testOnly: options.network === "testnet",
    }),
    walletApp: wallet.device.appName,
    network: wallet.account.chain === CHAIN_ID.testnet ? "testnet" : "mainnet",
  };
}

const sameHost = (url: string | undefined, pinned: string) => {
  try {
    return !!url && new URL(url).protocol === "https:" && new URL(url).host === new URL(pinned).host;
  } catch {
    return false;
  }
};

/** A TON Connect session belongs to one network: another needs a new session. */
const otherNetwork = (about: { network: string }, options: Options) =>
  `The connected wallet is on ${about.network}, not ${options.network}. Run disconnect, switch the wallet to ${options.network}, and connect again${options.network === "mainnet" ? "" : " with --testnet"}; or run the command ${about.network === "testnet" ? "with" : "without"} --testnet.`;

export async function startConnect(options: Options) {
  const tc = connector(options);
  const already = await restored(tc);
  if (already && describe(already, options).network !== options.network) {
    return {
      ok: false,
      code: "wrong-network",
      connected: true,
      ...describe(already, options),
      summary: [otherNetwork(describe(already, options), options)],
    };
  }
  if (already) {
    return {
      ok: true,
      connected: true,
      ...describe(already, options),
      summary: [
        `Already connected: ${describe(already, options).address} (${already.device.appName}). Run disconnect first to use another wallet.`,
      ],
    };
  }
  // The links the user opens and the names they read are the pinned ones,
  // never taken from a list fetched at run time. From the TON Connect list
  // only a wallet's bridge path is taken, and only on the pinned bridge host.
  const listed = await tc.getWallets().catch(() => []);
  const wallets = WALLETS.map((pinned) => {
    const found = listed.find((wallet) => wallet.appName === pinned.appName) as
      | { bridgeUrl?: string }
      | undefined;
    return {
      key: pinned.key,
      name: pinned.name,
      universal: pinned.universal,
      bridge: sameHost(found?.bridgeUrl, pinned.bridge) ? (found?.bridgeUrl as string) : pinned.bridge,
    };
  });
  // One session, listening on every one of their bridges at once.
  const universal = tc.connect(
    [...new Set(wallets.map((wallet) => wallet.bridge))].map((bridgeUrl) => ({
      bridgeUrl,
    })),
  ) as string;
  const query = universal.split("?")[1];
  const linkFor = (wallet: (typeof wallets)[number]) => {
    const url = new URL(wallet.universal);
    if (url.hostname === "t.me") {
      // A Telegram mini app link, the parameters encoded as Telegram keeps
      // them (the SDK's own way): `t.me/<bot>?startapp=tonconnect-…`, or
      // `t.me/<bot>/start?…` for one listed with `attach`.
      if (url.searchParams.has("attach")) {
        url.searchParams.delete("attach");
        url.pathname = `${url.pathname.replace(/\/$/, "")}/start`;
      }
      url.searchParams.set(
        "startapp",
        `tonconnect-${encodeTelegramUrlParameters(query)}`,
      );
      return url.toString();
    }
    return `${wallet.universal}${wallet.universal.includes("?") ? "&" : "?"}${query}`;
  };
  const links: Record<string, string> = { any: universal };
  for (const wallet of wallets) links[wallet.key] = linkFor(wallet);
  const qr = join(options.home, "connect-qr.svg");
  writeFileSync(qr, await QRCode.toString(universal, { type: "svg" }), {
    mode: 0o600,
  });
  // Let the session reach the bridge before this process ends.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return {
    ok: true,
    connected: false,
    links,
    qr,
    summary: [
      "Open the link for your wallet on the phone or computer that has it, or scan the QR code with the wallet's scanner (Telegram's built-in wallet scans it too), and approve the connection to KTON Skill:",
      ...wallets.map((wallet) => `${wallet.name}: ${links[wallet.key]}`),
      `Any other TON Connect wallet: ${universal}`,
      `QR code image: ${qr}`,
      "Then run `connect --wait`. Connecting lets the skill send requests to the wallet; each one still has to be approved there.",
    ],
  };
}

export async function waitConnected(options: Options, seconds: number) {
  const tc = connector(options);
  const wallet = await restored(tc, seconds * 1000);
  if (!wallet) {
    return {
      ok: false,
      code: "not-connected",
      summary: [
        "No wallet has connected yet. Approve in the wallet and run `connect --wait` again, or run `connect` for a fresh link.",
      ],
    };
  }
  const about = describe(wallet, options);
  if (about.network !== options.network) {
    return {
      ok: false,
      code: "wrong-network",
      ...about,
      summary: [otherNetwork(about, options)],
    };
  }
  return {
    ok: true,
    connected: true,
    ...about,
    summary: [`Connected: ${about.address} (${about.walletApp}, ${about.network}).`],
  };
}

export async function disconnect(options: Options) {
  const tc = connector(options);
  const wallet = await restored(tc);
  if (wallet) await tc.disconnect().catch(() => {});
  rmSync(join(options.home, SESSION_FILE), { force: true });
  return {
    ok: true,
    summary: [
      wallet
        ? "Disconnected; the wallet no longer lists KTON Skill and the session file is deleted."
        : "No wallet was connected; the session file is deleted.",
    ],
  };
}

/** The connected wallet, required: for sending. */
export async function requireWallet(options: Options) {
  const tc = connector(options);
  const wallet = await restored(tc, 3000);
  if (!wallet) {
    throw new CliError(
      "not-connected",
      "No wallet is connected. Run `connect` first.",
    );
  }
  const about = describe(wallet, options);
  if (about.network !== options.network) {
    throw new CliError("wrong-network", otherNetwork(about, options));
  }
  return { tc, wallet, about, address: Address.parseRaw(wallet.account.address) };
}
