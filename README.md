# KTON Skills

An agent skill for staking Gram in [KTON](https://kton.io), the liquid staking pool on TON: check the pool, quote a stake or an unstake with the checks the pool itself applies, and sign it in your own wallet. It never asks for or holds a recovery phrase or key.

How it works: [docs/DESIGN.md](docs/DESIGN.md). What has been checked, and what not yet: [VERIFICATION.md](VERIFICATION.md).

## Install

Claude Code:

```
/plugin marketplace add KTON-IO/kton-skills
/plugin install kton@kton-skills
```

Other agents (Codex and others that read `SKILL.md`):

```bash
npx skills add https://github.com/KTON-IO/kton-skills
```

Needs Node.js 20 or later and network access to toncenter.com. Optional: `TONCENTER_API_KEY` for faster reads.

Then ask your agent about KTON: "How is KTON doing?", "Stake 10 Gram in KTON", "Unstake my KTON".

## Privacy

The script reads the pool and the wallet you name from TonCenter, and talks to your wallet through the TON Connect bridges; both see the wallet's address. The connection and your quotes are kept in `~/.kton-skill` on your computer and go nowhere else. No analytics are sent.

## Develop

```bash
npm install
npm test
npm run build   # rebuilds kton/scripts/kton.mjs and records its SHA-256 in pins.json
```

`kton/scripts/kton.mjs` is built from `src/`; CI rebuilds it and fails if it differs from the committed file.

## Security

Report a vulnerability to contact@kton.io; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
