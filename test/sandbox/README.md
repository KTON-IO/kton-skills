# Sandbox: the skill's prediction against the deployed pool code

`SkillPrediction.spec.ts` loads the mainnet pool's code and data (`fixtures/pool-public-2026-11-06.json`, read from TonCenter on 2026-11-06) into `@ton/sandbox`, sets up four states (as on mainnet; previous round empty; previous round empty with only 2,908 Gram free; previous round empty with 1,500 KTON already queued), and for each sends a burn just under and just over the limit kton-sdk's `checkWithdrawal` predicts, waiting and at once. It passes when every prediction matches what the contract does (16 of 16 on 2026-11-06), and that a rotation due but not yet run is spotted.

It runs inside a checkout of the pool's source at the deployed commit, which needs the contract wrappers:

```bash
git clone --recurse-submodules https://github.com/KTON-IO/liquid-staking-contract /tmp/lsc
cd /tmp/lsc && git checkout -b rehearsal 49db7f8 && git submodule update --init && npm ci
npm install --no-save --legacy-peer-deps kton-sdk@2.1.0
cp <kton-skills>/test/sandbox/SkillPrediction.spec.ts tests/
FIXTURES=<kton-skills>/test/sandbox/fixtures npx jest --runInBand tests/SkillPrediction.spec.ts
```

The wrappers at 49db7f8 have type errors under ts-jest's checks; run with diagnostics off if jest stops on them.
