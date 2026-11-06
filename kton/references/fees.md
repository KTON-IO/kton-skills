# Fees and reserves

| What | How much | Who keeps it |
|---|---|---|
| Pool fee on staking rewards (mainnet) | 16% of rewards (read live: `governanceFee`) | The pool's treasury. Holders get the other 84%. Already reflected in the KTON rate and the realized yield. |
| Instant withdrawal fee (mainnet) | 0.2% of the amount, since 2026-10-17 (read live: `instantFee`) | The pool's treasury. |
| Withdrawal at the rotation | No fee | — |
| Stake reserve | 1 Gram sent with the stake | About 0.997 comes back in the same transaction; the rest pays for minting. |
| Unstake reserve | 1 Gram sent with the burn | Most comes back with the payout or the receipt. |
| Network fees | Up to about 0.15 Gram for a stake and 0.05 for an unstake, often less | The network. |

So staking N Gram needs about N + 1.15 Gram in the wallet, and unstaking needs about 1.05 Gram in the wallet besides the KTON.

The fees are pool settings, changed by its 3-of-4 multisig; the script reads them each time. The testnet pool has its own settings (on 2026-11-06: 1% instant fee, 100% pool fee).
