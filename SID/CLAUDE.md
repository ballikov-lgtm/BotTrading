# SID Strategy — Project Context

This folder contains everything for the **SID Swing Strategy** bot.
It is kept entirely separate from the Ironclad strategy (which lives in the parent `Trading Setup/` folder).

---

## Folder Structure

```
SID/
├── bot-sid.js                  — main trading bot (GitHub Actions runs this daily)
├── rules-sid.json              — strategy config (create this before first audit)
├── strategy-audit.js           — pre-flight audit (auto-detects rules-sid.json)
├── trades-sid.csv              — trade log
├── sid-log.json                — safety / run log
├── sid-account.json            — account state (starting balance, equity curve)
├── open-positions-sid.json     — currently open positions
├── closed-positions-sid.json   — historical closed positions
├── SID-README.md               — human-readable strategy overview
├── docs/                       — any additional docs
└── research/
    ├── SID Trading Strategy.pdf  — original source PDF
    └── images/                   — extracted page images (01–27)
```

---

## How the Bot Runs

**GitHub Actions** — `.github/workflows/sid.yml` in the repo root runs `bot-sid.js`
once per weekday at 14:35 UTC (9:35am ET), 5 minutes after US market open.
The workflow uses `working-directory: SID` so all `./` file paths resolve correctly.

**Not on Railway** — SID runs via GitHub Actions (daily cadence), not the Railway
15-minute loop that Ironclad uses.

---

## Strategy Overview (SID)

- **Timeframe**: Daily chart
- **Asset class**: US stocks (and potentially crypto)
- **Style**: Swing trades held days to weeks
- **Source**: `research/SID Trading Strategy.pdf` — 27 pages of rules

Key details to be extracted into `rules-sid.json` before running the audit.

---

## First Steps in This Session

1. Read `SID-README.md` for the current bot status
2. Read `research/SID Trading Strategy.pdf` (or the images in `research/images/`) for the full strategy rules
3. Create `rules-sid.json` from the strategy rules
4. Run `node strategy-audit.js` — it will auto-detect `rules-sid.json`
5. Fix any audit failures before enabling live trading

---

## Risk Note

SID uses **larger position sizes** than Ironclad. The audit script's leverage and
risk-per-trade checks are especially important here. Do not skip them.

---

## Shared Infrastructure (do not modify from this session)

The following live in the parent `Trading Setup/` folder and are shared with Ironclad:

| File | Purpose |
|------|---------|
| `package.json` / `node_modules/` | Shared npm deps — `npm install` from repo root |
| `railway-runner.js` | Ironclad bot runner on Railway — do not touch |
| `.github/workflows/ironclad.yml` | Ironclad workflow — do not touch |
| `closed-positions-ironclad.json` | Ironclad trade history — do not touch |
