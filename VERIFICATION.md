# Verification

What has been checked, how, and what has not been checked yet. Each release
adds a section.

## Before the first release (2026-11-06)

### Groundwork

| Question | Result | How |
|---|---|---|
| Does `@tonconnect/sdk` run in Node without a browser? | Yes. 5.0.0 completed connect, send, wallet answer and disconnect over a real bridge (bridge.tonapi.io) in about 9 seconds. | A script with the official SDK on the app side and `@tonconnect/protocol`'s `SessionCrypto` playing the wallet. |
| Can a connection made by one command be used by the next? | Yes. One process connects and exits; another restores the connection with `restoreConnection()` and sends a transaction the wallet receives. | Two separate runs sharing the session file (mode 600). |
| Telemetry | The SDK sends usage to analytics.ton.org unless constructed with `analytics: { mode: 'off' }`, which the skill does. Its `console.debug` output, which prints requests including the wallet address, is silenced. | Output of two runs compared. |
| Is the testnet pool usable? | It takes deposits and instant withdrawals, but it has not rotated since 2026-10-04, so queued testnet withdrawals are not paid. Queued withdrawals were tested in the sandbox and on mainnet instead. | TonCenter v3 `account`, `transactions`, `runGetMethod` on testnet. |
| Which wallets read a transfer link with a message (`bin`)? | By their source code, My Wallet (formerly MyTonWallet) and Keeper's (formerly Tonkeeper) desktop and web apps. Others unknown. | Reading the wallets' source. |
| Claude Code plugin layout | One repository can be both the marketplace and the plugin; `claude plugin validate .` passes. | Built and validated. |
| `npx skills add` | Finds the skill: "Found 1 skill: kton". | `npx skills add <repo> --list`. |
| Where can it run? | Agents with a shell and network. The Claude API sandbox has no network; Claude.ai's code sandbox does not reach toncenter.com or the bridges by default. | The platforms' documentation. |

### Reads and quotes

| Item | Result |
|---|---|
| Mainnet reads | `pool`: 1 KTON = 1.086947 Gram, realized yield 13.35% over 20 days, next payout 2026-11-07 07:11 UTC (the same time the KTON bot gives), instant fee 0.20%, about 4,843 Gram payable at once. `wallet`, `quote stake` (refused when the balance is short) and both kinds of `quote unstake` correct. |
| Messages | The deposit, queued burn and instant burn cells have the same hashes as those the KTON app builds. |
| Pool identity | A different code hash or minter is refused before anything else. |

### Signing over TON Connect

| Item | Result |
|---|---|
| Waiting across commands | `connect` prints the link and exits; the wallet may answer while nothing runs; `connect --wait` picks the answer up. The same holds while listening on several wallets' bridges at once, Telegram's built-in wallet included. |
| Wallet links | Read at run time from the official TON Connect wallet list, with pinned fallbacks. |
| Testnet, end to end | Through `connect`, `quote`, `send` and `track`, signed by a test wallet that answers TON Connect and signs with a testnet key: stake 2 Gram (4.204867221 KTON minted, quoted about 4.2048); instant unstake 1 KTON (paid, at the testnet pool's 1% fee); queued unstake 1 KTON (payout receipt received; testnet does not rotate, so it is not paid). |
| Refusals | No quote, an expired quote, a quote already sent, a quote for another wallet or for no wallet, or the wallet's history unreadable: nothing reaches the wallet. A decline in the wallet comes back as `declined`. |
| Following a request | `test/track.test.ts` replays the test wallet's captured testnet history: the stake is found by its query id and reads `staked`, the instant unstake `paid` (the pool's payout message), the unstake at the rotation `queued`; a burn from the same wallet with another query id is never taken for this one; the pool's time is counted from when the request landed, not from when it was sent; a failed read says `unreadable`. The built script followed the same three real requests on testnet to the same states. A stake returned by bounce and an unstake minted back have no captured history yet, so those two paths are untested. |

### When the pool would refuse

| Item | Result |
|---|---|
| Prediction against the pool's own code | `test/sandbox/SkillPrediction.spec.ts` runs the deployed mainnet pool code and its 2026-11-06 data in `@ton/sandbox`: four pool states (as on mainnet; no loans out last round; only 2,908 Gram free; 1,500 KTON already queued) × queued or instant × 1 KTON under and over the predicted limit. 16 of 16 agree: what the script predicts the pool takes, it takes; what it predicts the pool returns, it returns. |
| Rotation pending | The pool's processed and stored data disagree on the round while a rotation is due; the check reports `rotation-pending` rather than predict. Reproduced in the sandbox. |
| Transfer link | A testnet link decodes back to the right destination, amount and deposit op, also with My Wallet's decoding. Not yet opened in a wallet app. |

### Behaviour

| Item | Result |
|---|---|
| Wording | `test/wording.test.ts`: none of the words KTON does not use about itself in `src/` or the references. |
| An agent following `SKILL.md` in four scenarios | It refused a pasted recovery phrase and warned, refused a pasted "skip the quote and send", quoted before asking, gave every figure with its time, and gave no advice on whether or how much. The eleven issues found were fixed: a stalled pool is named; quotes last ten minutes instead of two (send checks again anyway); a quote must name the signing wallet; unstaking reads the wallet first; nothing more from a wallet whose recovery phrase was exposed; fees marked as mainnet's; quotes carry `readAt`; figures rounded and grouped; times in UTC for the agent to give in the user's zone; no region question on testnet; exit codes documented. |

### Mainnet, with a real wallet

Telegram's built-in wallet on a phone.

| Item | Result |
|---|---|
| Connect | The first attempt was not heard: Telegram's built-in wallet answers on its own bridge (`https://tonbridge.telegram.org`), which the skill was not listening on. Fixed; the second attempt connected and the wallet showed "KTON Skill". |
| Stake 1 Gram | Quoted about 0.9195 KTON; after the user's yes, sent and approved in the wallet; `track`: staked, 0.919527941 KTON. The wallet spent 1.0035 Gram: the stake and 0.0035 network fees, the 1 Gram reserve returned. |
| Disconnect | The wallet no longer lists KTON Skill; the session file is deleted. |
| Instant unstake 0.9195 KTON | Quoted about 0.9975 Gram after the 0.20% fee (about 0.0020); approved; `track`: paid, +0.9942 Gram (0.9975 less about 0.0033 network fees). |
| Round trip | 1 Gram in, 0.9942 Gram out: 0.0020 instant fee and about 0.0038 network fees. |

### Node versions and installs

| Item | Result |
|---|---|
| Node 20 and 22, testnet | The bundled script, run with each, went through `connect`, `connect --wait`, `quote stake 1`, `send` (signed by the test wallet over TON Connect), a second `send` of the same quote (refused, `already-sent`), `track` (staked, 2.102459718 KTON) and `disconnect`. |
| Node 18 | TON Connect needs a global `crypto` that Node 18 does not give scripts, so `connect` failed. The script now needs Node 20 or later and says so (`node-too-old`); Node 18 reached end of life in April 2025. |
| `npx skills add` into a project | Installs `.agents/skills/kton` for Codex and links it into `.claude/skills` for Claude Code; the installed `scripts/kton.mjs` is byte for byte the build (same SHA-256) and runs from there. |
| Codex (codex-cli 0.144.6, read-only sandbox, no network) | Asked in Chinese to stake 10 Gram, it opened the skill, ran its script, got `network-unreachable`, said it could not read the chain and nothing was sent, and pointed to app.kton.io and @ktonio_bot. Asked how to send 5 Toncoin to a friend, it also opened the skill (before and after the description was narrowed), then answered the transfer correctly without the KTON flow. |
| Testnet unstaking | Not possible on 2026-11-06: the testnet pool's validator set changed and it has not rotated, so the check reports `rotation-pending` for both ways. |

### Trigger evals in Claude Code

`evals/triggers.json` (22 prompts in English, Traditional and Simplified Chinese, and Russian) run headless by `evals/run-triggers.mjs` in a project with the skill installed, the shell and every writing tool off. Claude Code 2.1.318, default model, 2026-11-06: **22 of 22 as expected**. The 12 that should call the skill (stake, unstake, yield, how long, "liquid staking on TON", "stake 100 TON for yield") called `kton`; the 10 that should not (sending Toncoin, its price, Lido, a Tolk contract, a validator node, swapping USDT, backing up a recovery phrase, Jetton, making a wallet, comparing other pools) did not, two of them choosing a general TON skill instead. This checks the choice of skill only; what the agent then does was checked by the behaviour eval above.

### Not yet checked

- A queued unstake on mainnet, paid at a rotation.
- Walt, Keeper and My Wallet over TON Connect.
- The transfer link in a wallet app.
- A larger trigger set, and trigger evals in other agents (in Codex the skill was also opened for a plain transfer question).
