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

## Setup Costs — Full Breakdown

Before you start, here is an honest picture of what this system costs to run. Most of it is free.

---

### GitHub — Free ✅

| Feature | Plan | Cost |
|---|---|---|
| GitHub Actions (bot scheduling) | Free tier | $0 — 2,000 min/month included |
| GitHub Pages (live dashboard) | Free tier | $0 — always free for public repos |
| Private repository | Free tier | $0 |

**Usage:** The bot uses approximately 800–1,000 Actions minutes per month — well within the free limit.

---

### Bitget Exchange — Free to hold, fees on trades ✅

| Fee | Amount |
|---|---|
| Account / KYC | Free |
| Monthly subscription | Free |
| Futures maker fee | ~0.02% per trade |
| Futures taker fee | ~0.06% per trade |

**Minimum capital:** Bitget requires no minimum deposit. In practice, $200–$500 minimum is recommended to make the 1% risk-per-trade position sizing meaningful. The strategy is configured for a $1,000 portfolio by default.

---

### Perplexity AI — Research Layer 💰

The research bot uses the Perplexity API to scan market sentiment and AI analysis for each token twice daily.

| Plan | Cost | Notes |
|---|---|---|
| Free tier | $0 | Web access only — **not usable** for the API |
| Pay-as-you-go API | ~$5–10/month | Based on ~60 research queries/day (low volume) |
| Perplexity Pro | $20/month | Includes API access + higher rate limits |

**Recommendation:** Start with pay-as-you-go. At twice-daily runs across 10 tokens the monthly API cost is typically under $10.

Sign up: [perplexity.ai](https://www.perplexity.ai)

---

### SendGrid — Email Alerts (Fund Monitor) ✅

The fund monitor sends email alerts when account balance changes significantly.

| Plan | Cost | Limit |
|---|---|---|
| Free tier | $0 | 100 emails/day |

100 emails/day is far more than enough for daily fund monitoring alerts. The free tier never needs to be upgraded.

Sign up: [sendgrid.com](https://sendgrid.com)

---

### Railway — Optional Cloud Hosting Alternative 💡

GitHub Actions is the recommended (and free) way to run this system. Railway is an alternative if you want a persistent server with more control — for example if you want to add a live API endpoint or run the bot outside GitHub's scheduler.

| Plan | Cost | Notes |
|---|---|---|
| Hobby | $5/month | 512MB RAM, always-on, custom domains |
| Pro | $20/month | More resources, team features |

**Verdict:** Railway is not required. GitHub Actions handles everything this strategy needs at zero cost. Only consider Railway if you want to extend the system beyond what's built here.

Sign up: [railway.app](https://railway.app)

---

### Total Monthly Cost Summary

| Service | Required | Monthly Cost |
|---|---|---|
| GitHub | ✅ Yes | $0 |
| Bitget | ✅ Yes | $0 + trading fees (~0.02–0.06% per trade) |
| Perplexity API | ✅ Yes (research layer) | ~$5–10 |
| SendGrid | ✅ Yes (email alerts) | $0 |
| Claude Pro | ✅ Yes (builds and manages the system) | $20 |
| Railway | ❌ Optional | $0–5 |
| **Total** | | **~$25–30/month** |

Claude Pro is required to build the system, manage strategy changes, run backtests, debug issues and iterate on the bot. Without it you would need to maintain the codebase manually. Consider it the developer subscription — one good trading day covers the monthly cost.

---

## ⚠️ Disclaimer

**This is not financial advice. Please do your own research.**

Cryptolanz is an experimental algorithmic trading system shared for educational and informational purposes only. Nothing in this repository, the deployment prompt, the landing page or any associated documentation constitutes financial advice, investment advice, trading advice or any other type of advice.

**You run this strategy entirely at your own risk.**

- This is not a guaranteed strategy. No trading system guarantees profits.
- Past performance, backtesting results and paper trading outcomes do not guarantee future returns under live market conditions.
- Cryptocurrency futures trading involves significant risk of loss, including the possible loss of all capital deployed.
- Market conditions change. A strategy that performs well in trending markets may underperform or lose money in choppy or reversing conditions.
- You are solely responsible for any financial decisions you make. The creator of this system accepts no liability for any losses incurred through its use.
- Always consult a qualified financial adviser before deploying any automated trading system with real capital.
- Never trade with money you cannot afford to lose.

**By deploying this system you acknowledge that you have read, understood and accepted this disclaimer in full.**

---

*For deployment instructions, see `DEPLOY-PROMPT.md`*
