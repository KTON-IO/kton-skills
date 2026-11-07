# Risks, in plain words

Use this for "is it safe?". Give facts with their dates and leave the judgement to the user.

- **Staking always carries risk.** KTON's yield comes from lending Gram to validators.
- **Validators.** If a validator is penalized or returns less than it borrowed, all holders share the loss in proportion.
- **Pauses.** The pool can be paused; while it is, deposits and withdrawals are refused, and a burn sent then is returned, not lost. The script reports it (`halted`).
- **Withdrawal timing.** Waiting means up to one rotation (about 9 or 27 hours, sometimes later if a validator is late). Instant capacity is small, a few thousand Gram at a time, and large queued requests can be returned at some points of the cycle (`mechanics.md`).
- **Contract.** KTON runs TON's open-source liquid staking contract (version 2). TonBit audited the version 2 contracts in 2025, and the report is public. The pool's code has never been upgraded since it was deployed on 2025-03-21.
- **Administration.** Every admin role of the pool is a 3-of-4 multisig. It can change the fees and pause the pool.
- **Where it is offered.** KTON's terms (https://kton.io/terms-of-use) exclude some places; app.kton.io is not offered in China, Egypt, Algeria, Bangladesh, Nepal, Afghanistan, Morocco, Iraq, Cuba, Iran, North Korea and Syria. Before the first stake, ask the user to confirm they are not in one of them; if they are, do not help them stake.
- **This skill.** It never holds keys. Each transaction is shown and approved in the user's own wallet; check the amount and the address there (the pool address is in `mechanics.md`).
