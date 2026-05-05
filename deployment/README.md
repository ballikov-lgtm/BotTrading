# Cryptolanz Trading Strategy

> Advanced, modified and real-time tested automated crypto trading system.
> Expected win rate: **60–80% over 150+ trades** (paper-tested before live deployment).

---

## What Is Cryptolanz?

Cryptolanz is a fully automated crypto futures swing trading bot built on a multi-timeframe confluence strategy. It runs entirely in the cloud using GitHub Actions — no server, no VPS, no manual intervention required after setup. It trades 24/7 on the Bitget futures exchange and generates a live web dashboard for monitoring performance.

The strategy was developed, backtested, iterated and refined over multiple months of real-time paper trading before being deployed live. It is not a simple indicator bot — it combines daily trend structure, 15-minute entry precision, ATR-buffered risk management, Fibonacci take-profit levels, and multiple layers of safety logic.

---

## Strategy Logic — How It Works

### Core Philosophy

The strategy only takes trades when **two timeframes agree**:
1. The **daily chart** confirms a clear trend (bull or bear) using swing structure
2. The **15-minute chart** presents a precise entry after a pullback to a swing low/high

This multi-timeframe confluence dramatically filters out noise and false signals.

---

### Step 1 — Daily Trend Detection (HTF)

On the daily chart, the bot detects trend direction by analysing **swing highs and swing lows**:

- **Bullish trend**: Series of higher highs AND higher lows
- **Bearish trend**: Series of lower highs AND lower lows
- **Neutral**: No clear structure → symbol is skipped entirely

ATR (Average True Range) filtering prevents minor wiggles from being counted as significant swings.

EMAs (21, 50, 100, 200) are calculated on the daily chart and used as reference levels for take-profit targeting.

---

### Step 2 — 15-Minute Entry Signal (LTF)

Once a bullish daily trend is confirmed, the bot looks for a **long entry** on the 15-minute chart:

- Price pulls back to a recent swing low
- Price then **breaks above the high of that swing low candle** (breakout confirmation)
- Entry is taken at the current 15m close price

For bearish daily trends, the mirror logic applies (short entries after pullbacks to swing highs).

---

### Step 3 — Stop Loss

Stop is placed **below the swing low reference point** with an ATR buffer:

```
Stop Loss (long)  = SwingLow - (ATR × 0.5)
Stop Loss (short) = SwingHigh + (ATR × 0.5)
```

A minimum stop distance of 0.3% is enforced to avoid stops being placed unrealistically close to entry.

---

### Step 4 — Three Take-Profit Levels

The position is split into three tranches with different targets:

| Tranche | Size | Target | SL Move After |
|---|---|---|---|
| TP1 | 40% of position | Nearest EMA / swing / Fibonacci level | SL → Break-even |
| TP2 | 35% of position | Second level | SL → TP1 (lock profit) |
| TP3 | 25% of position | Third level | Full exit |

Take-profit levels are selected from a pool of:
- EMA 21, 50, 100, 200 (daily)
- Recent swing highs/lows (daily)
- Fibonacci extension levels (0.236 → 1.618)
- Fallback: 1.5R, 2.5R, 4.0R if no structural levels available

This trailing SL system means **once TP1 is hit, the trade cannot lose money** — the worst outcome becomes break-even.

---

### Step 5 — Position Sizing

Risk is fixed at **1% of portfolio per trade**:

```
Risk Amount  = Portfolio × 1%
SL Distance  = |Entry - StopLoss| / Entry  (as %)
Position USD = Risk Amount ÷ SL% ÷ Leverage
```

Maximum position size is capped (default $100 on a $1,000 portfolio) to prevent oversizing on very tight stops.

---

### Safety Rules

The bot has multiple layers of protection that can halt trading:

| Rule | Condition | Action |
|---|---|---|
| **HTF Neutral Filter** | Daily chart shows no clear trend | Symbol skipped |
| **Research Conflict** | Morning AI research disagrees with entry direction | Symbol skipped |
| **Economic Blackout** | ±60 min around FOMC / NFP / CPI events | All entries halted |
| **3-Hour Cooldown** | Clean stop-out (no TP hit) on a symbol | That symbol blocked for 3 hours |
| **Daily Trade Limit** | 3 entries per symbol per day maximum | Symbol skipped |
| **Daily Drawdown Limit** | Today's losses exceed 5% of portfolio | All trading halted until tomorrow |

---

### Research Layer

Twice daily (09:00 and 18:00 UK time), a separate research bot:
- Scans AI sentiment and market analysis for each token
- Detects upcoming high-impact economic events (FOMC, NFP, CPI)
- Writes a signal file (`research-signals.json`) the trading bot reads before each entry
- Generates and commits a live HTML dashboard to GitHub Pages

---

## Symbol Watchlist

10 crypto futures pairs traded on Bitget:

```
BTCUSDT  ETHUSDT  SOLUSDT  XRPUSDT  LINKUSDT
HYPEUSDT  VIRTUALUSDT  APTUSDT  ONDOUSDT  JUPUSDT
```

---

## Performance Expectations

- **Win rate**: 60–80% over 150+ trades (real-time tested)
- **Leverage**: 3× (conservative for futures)
- **Risk per trade**: 1% of portfolio
- **Max daily loss**: 5% of portfolio (circuit-breaker)
- **Trade frequency**: Multiple per day during active sessions, fewer during quiet periods
- **Best conditions**: Trending markets (bull or bear). Performance reduces in choppy/ranging markets — the neutral filter handles most of this automatically

---

## What Gets Deployed

| Component | File | Runs |
|---|---|---|
| Trading Bot | `bot-ironclad.js` | Every 15 min (active sessions), hourly (quiet) |
| Research Bot | `research.js` | 9am + 6pm UK daily |
| Fund Monitor | `monitor.js` | With research runs |
| Dashboard | `docs/index.html` | Auto-generated, live on GitHub Pages |
| Workflows | `.github/workflows/ironclad.yml` + `research.yml` | Managed by GitHub Actions (free tier) |

---

## Infrastructure Cost

**Zero.** GitHub Actions free tier provides 2,000 minutes/month. This strategy uses approximately 800–1,000 minutes/month, well within the free allowance. The only cost is the Bitget account (no monthly fee — exchange takes a small trading commission per trade).

---

## Disclaimer

This is an algorithmic trading system. All trading involves risk of loss. Past performance and backtesting results do not guarantee future returns. Always start in paper trading mode and only deploy capital you can afford to lose. This is not financial advice.

---

*For deployment instructions, see `DEPLOY-PROMPT.md`*
