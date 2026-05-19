# VWAP Scalper Strategy — Agent Memory

This file is the **deep context** for the VWAP Scalper bot. Loaded by the root [`CLAUDE.md`](CLAUDE.md) routing guide whenever the user mentions VWAP, scalper, intraday crypto, the 4h crypto bot, or any of the VWAP-prefixed files.

**Less battle-tested than the SID and Ironclad memory files** — this strategy hasn't been worked on in the current session series. Treat anything here as "verified from the code as of 2026-05-18" rather than session-tested knowledge.

---

## What VWAP Scalper is

A short-term crypto scalping bot. **Only trades when the market is ranging/choppy** — uses VWAP + RSI(3) + EMA(8) on 4-hour candles. Strongly trending markets are skipped (Ironclad is designed for those).

- **Bot:** `bot.js` (v1.3 as of this writing)
- **Strategy version:** v2.0 in `rules.json`
- **Style:** Short-term scalp on 4h candles
- **Assets:** Crypto only (BTC, ETH, SOL, XRP, LINK, HYPE, VIRTUAL, APT, ONDO, JUP base list — research signals can add more)
- **Exchange:** BitGet futures
- **Default leverage:** 1× (per env `LEVERAGE`, default in code)
- **Paper trading flag:** `PAPER_TRADING` env var (default = paper)

---

## Files VWAP Scalper owns (segregation rules)

When working on VWAP, **only touch these**:

### Code
- `bot.js` — main bot

### Config
- `rules.json` — strategy parameters (asset list, entry conditions, exits)

### State (auto-managed)
- `trades.csv` — trade log
- `safety-check-log.json` — safety log

### Inputs it reads (do not modify when working on VWAP)
- `research-signals.json` — written by `research.js` (Ironclad's research pipeline). Adds crypto tokens from Perplexity / DegenDave research to the base symbol list.

### Workflows
- `.github/workflows/trade.yml` — multi-cadence schedule (Mon-Fri busy hours 15-min, weekends 4h)

---

## Where VWAP runs

**GitHub Actions** (`trade.yml`). Schedule is intricately tuned by market hours:
- **Weekdays:** 15-min cadence during London open / US open / US close volatility windows; 30-min during mid-morning / afternoon; hourly during quiet/wind-down
- **Weekends:** Every 4 hours

Triggers: `workflow_dispatch` for manual + the schedule cron blocks.

---

## Strategy logic in one paragraph

On each run, the bot checks every symbol in its base list (plus any crypto tokens added by `research-signals.json` that are bullish or bearish with non-neutral signal). For each symbol:
1. Skip if the last 10 candles are all above or all below EMA(8) — that's "trending", scalp logic doesn't work there
2. Otherwise check entry conditions:
   - **Long:** price > VWAP, price > EMA8, RSI(3) < 30 (oversold mean-reversion within ranging market)
   - **Short:** price < VWAP, price < EMA8, RSI(3) > 70 (mirror)
3. Exit via ATR-derived stop loss / take profit (added in v1.3)

Caps: `MAX_TRADE_USD` per trade, `MAX_TRADES_PER_DAY` per symbol per day.

---

## Common gotchas

### Asset class is enforced — crypto only
VWAP explicitly defers stocks/commodities/forex to Ironclad. If you see a non-crypto symbol in `rules.json`, that's a misconfiguration.

### Trending-market filter is the kill switch
The 10-candle "all above/below EMA8" check skips entry. If VWAP isn't taking trades during a strong uptrend, that's by design — Ironclad takes over.

### Research signals are additive, not overrides
`research-signals.json` can ADD crypto symbols to scan, but cannot remove base symbols. Neutral signals are ignored.

### Shares BitGet credentials with Ironclad
Both VWAP and Ironclad authenticate against BitGet with `BITGET_API_KEY`, `BITGET_SECRET_KEY`, `BITGET_PASSPHRASE`. The same API key is used for both — be aware of rate limits if both fire in close succession.

---

## Things explicitly NOT to do from a SID or Ironclad session

- ❌ Edit `bot.js` or `rules.json`
- ❌ Modify `.github/workflows/trade.yml`
- ❌ Touch `trades.csv` or `safety-check-log.json`
- ❌ Add non-crypto symbols to VWAP's base list (defer to Ironclad)

---

## Pending tasks / unknowns

- **Not deeply audited in current session series** — most recent VWAP-specific work happened before this session sequence began. Confirm `BOT_VERSION` in `bot.js` matches whatever the user expects before making claims.
- **Backtest performance numbers:** not currently tracked in a vault (unlike SID's `strategy-test-vault/`). If you need to defend a strategy claim, point the user at `rules.json` for the live config and ask for the most recent backtest results.

---

## Cross-references

- Root project hub → [`CLAUDE.md`](CLAUDE.md)
- Shares research pipeline with Ironclad → [`IRONCLAD-MEMORY.md`](IRONCLAD-MEMORY.md) § Research workflow
- Top-level human README → `README.md` (lists all three strategies)
