import type { Network } from "kton-sdk";

/**
 * The KTON pool on each network and the hash of the code it runs, checked
 * before any quote: a pool whose code changed is not the pool this skill
 * knows, and nothing is offered for it. Mainnet's hash is the code deployed on
 * 2025-03-21, never upgraded since.
 */
export const PINS: Record<
  Network,
  { pool: string; minter: string | null; codeHash: string; toncenter: string }
> = {
  mainnet: {
    pool: "EQA9HwEZD_tONfVz6lJS0PVKR5viEiEGyj9AuQewGQVnXPg0",
    minter: "EQBuIhXNNkWf9AW9miNGNTSO_uFZ23ejfIWrieXge5f733mw",
    codeHash:
      "7b5a043fdd40eed7a0b855cbdaca4e1a6b00725c643b1103fccc370326b5b3c5",
    toncenter: "https://toncenter.com/api/v3",
  },
  testnet: {
    pool: "kQD2y9eUotYw7VprrD0UJvAigDVXwgCCLWAl-DjaamCHniVr",
    minter: null,
    codeHash:
      "b7f558311c265e7d909b94a262b547beb4e7a06854d6fbff888e33050aab541a",
    toncenter: "https://testnet.toncenter.com/api/v3",
  },
};

/** What the wallet attaches above a stake; about 0.997 of it comes back. */
export const STAKE_RESERVE = 1_000_000_000n;
/** Network fees a stake can cost on top (as the KTON app budgets). */
export const STAKE_GAS = 150_000_000n;
/** The smallest stake (as the KTON app). */
export const MIN_STAKE = 1_000_000_000n;
/** Attached to a burn; most of it comes back. */
export const UNSTAKE_RESERVE = 1_000_000_000n;
/** Network fees a burn can cost on top. */
export const UNSTAKE_GAS = 50_000_000n;
/**
 * How long a quote stands, seconds: long enough for a person to read it and
 * answer. Sending checks the pool and the balances again anyway.
 */
export const QUOTE_SECONDS = 600;
/**
 * A pool that has not rotated for this long (a cycle, two 65,536 s rounds)
 * has stalled: queued withdrawals and payouts wait until it rotates again.
 */
export const STALL_SECONDS = 131_072;
/**
 * The window the realized yield is asked over (21 days, as the KTON app and
 * bot). The SDK reports the span it could measure (comparable rounds only),
 * so the summary may say 20.
 */
export const APY_DAYS = 21;

/** TonConnect chain ids. */
export const CHAIN_ID = { mainnet: "-239", testnet: "-3" } as const;

/**
 * The skill's own TonConnect manifest (its own, not the app's or the bot's: a
 * wallet keeps one connection per manifest, and sharing one makes them push
 * each other out). Served by app.kton.io since 2026-11-06.
 */
export const MANIFEST_URL = "https://app.kton.io/tonconnect-manifest-skill.json";

/**
 * The wallets the connect link names, first Telegram's built-in wallet (on
 * its own bridge), with their link, bridge and name as the TON Connect wallets
 * list had them on 2026-11-06 (Walt was Wallet, Keeper was Tonkeeper, My
 * Wallet was MyTonWallet). These links and names are what the user is given;
 * at each connect the list may only move a bridge to another path on the same
 * host.
 */
export const WALLETS = [
  {
    key: "telegram",
    appName: "telegram",
    name: "Telegram",
    universal: "https://t.me/sendgrams",
    bridge: "https://tonbridge.telegram.org",
  },
  {
    key: "walt",
    appName: "telegram-wallet",
    name: "Walt",
    universal: "https://t.me/walt?attach=wallet",
    bridge: "https://walletbot.me/tonconnect-bridge/bridge",
  },
  {
    key: "keeper",
    appName: "tonkeeper",
    name: "Keeper",
    universal: "https://app.tonkeeper.com/ton-connect",
    bridge: "https://bridge.tonapi.io/bridge",
  },
  {
    key: "mywallet",
    appName: "mytonwallet",
    name: "My Wallet",
    universal: "https://connect.mytonwallet.org",
    bridge: "https://tonconnectbridge.mytonwallet.org/bridge/",
  },
] as const;

/** How long a send waits for the wallet's answer, seconds. */
export const WALLET_WAIT_SECONDS = 240;
