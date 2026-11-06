# Changelog

## [1.0.0] - 2026-11-06

First public release.

- Reads the KTON pool (what 1 KTON is worth, realized yield, next payout, instant withdrawal fee and capacity) and a wallet (Gram, KTON, withdrawals waiting).
- Quotes a stake, or an unstake at the rotation or at once, with the checks the pool applies; refuses what the pool would return.
- Sends an agreed quote, once, to the user's wallet over TON Connect (any TON Connect wallet; tested with Telegram's built-in wallet), and follows it on chain until the stake is minted, the withdrawal is queued or paid at once, or the pool returns it.
- A transfer link and QR code as a fallback.
- Checks the pool's code and minter before every quote and send.
- Needs Node.js 20 or later.
