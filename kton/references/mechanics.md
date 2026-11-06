# How the KTON pool works

Figures here are as read on 2026-11-06 unless marked; the script reads the live ones.

## Staking

- Gram sent to the pool is lent to validators, who return it with interest after their validation round.
- The pool runs optimistic deposits: KTON is minted at once, at the rate the pool expects at the end of the current round (`get_pool_full_data`, projected balance over projected supply).
- 1 KTON is worth `total_balance / supply` Gram. That number rises at each payout; KTON is not paid out separately and the number of KTON in the wallet does not change.
- A stake made while loans are out sits out the next payout and earns from the one after; the script's `firstPayout` already accounts for this.

## Rounds, payouts and rotations

- TON validation rounds are 65,536 seconds (about 18.2 hours). The pool lends every other round, so its cycle is about 36.4 hours.
- A payout (the rate's step up) happens once a cycle, when the validator's stake is released and the loan repaid.
- The pool rotates twice a cycle, about 9 and 27 hours apart. Queued withdrawals are paid at every rotation.
- These times come from TonCenter's validator cycles with the same reckoning as app.kton.io and @ktonio_bot.

## Unstaking

The wallet burns KTON; the pool pays Gram.

- **At the rotation** (`wait`): the wallet gets a withdrawal receipt (an NFT); at the next rotation the pool pays Gram at the rate settled then, and the receipt is burned. No fee. A request sent within about an hour of a rotation is promised for the one after.
- **At once** (`instant`): the pool pays now at today's rate, less its instant fee, if its free balance (balance less the 10 Gram it keeps) is larger than the amount. The skill asks "pay now or give the KTON back", so a request the pool cannot pay is returned, never turned into a queued one the user did not choose.
- **What the pool refuses, it returns.** The pool only takes a withdrawal if, at the next rotation, it will hold enough (free balance plus the previous round's loans, less 1 Gram) to pay every queued withdrawal. During the part of the cycle when the previous round has no loans out (about 9 hours of 36), a large queued request is returned: the KTON is minted back, nothing is lost but the network fees. The script works this out before quoting.

## Losses

If a validator ever returns less than it borrowed, the loss lowers `total_balance`, so every holder shares it in proportion; nobody can leave first and leave it to others.

## Addresses

- Pool (mainnet): `EQA9HwEZD_tONfVz6lJS0PVKR5viEiEGyj9AuQewGQVnXPg0`
- KTON minter (mainnet): `EQBuIhXNNkWf9AW9miNGNTSO_uFZ23ejfIWrieXge5f733mw`
- Pool (testnet): `kQD2y9eUotYw7VprrD0UJvAigDVXwgCCLWAl-DjaamCHniVr`. It has not rotated since 2026-10-04, so queued withdrawals there are not paid.
