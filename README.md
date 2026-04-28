# Automated Trading System

Three independent algorithmic trading strategies running on a shared infrastructure. Each strategy has its own bot, trade log, and position monitor. A central research agent runs twice daily and publishes a live dashboard to GitHub Pages.

---

## Strategies at a Glance

| Strategy | Bot | Style | Assets | Timeframe | Leverage | Exchange |
|----------|-----|-------|--------|-----------|----------|----------|
| [VWAP Scalper](docs/setup-windows.md) | `bot.js` | Intraday scalp | Crypto | 15 min | 3× futures | BitGet |
| [Ironclad](IRONCLAD-README.md) | `bot-ironclad.js` | Swing trade | Crypto + Stocks + Commodities | Daily + 15 min | 3× futures | BitGet |
| [SID](SID-README.md) | `bot-sid.js` | Slow swing | **US Stocks & ETFs only** | Daily | None (spot equity) | Separate broker |

---

## Project Structure

```
├── bot.js                        # VWAP Scalper — intraday crypto scalp bot
├── bot-ironclad.js               # Ironclad — multi-timeframe swing bot
├── bot-sid.js                    # SID — daily RSI/MACD stock swing bot
│
├── rules.json                    # VWAP Scalper strategy config
├── rules-ironclad.json           # Ironclad strategy config
│
├── trades.csv                    # VWAP Scalper trade log
├── trades-ironclad.csv           # Ironclad trade log
├── trades-sid.csv                # SID trade log
│
├── open-positions-ironclad.json  # Ironclad open position tracker
├── closed-positions-ironclad.json# Ironclad realized P&L records
├── open-positions-sid.json       # SID open position tracker
├── closed-positions-sid.json     # SID realized P&L records
│
├── research.js                   # Daily market research agent + dashboard builder
├── research-signals.json         # Machine-readable signal file (read by bots)
│
├── docs/
│   ├── index.html                # Live dashboard (published to GitHub Pages)
│   ├── setup-windows.md          # Windows setup guide
│   └── setup-linux.md            # Linux/Mac setup guide
│
├── research/
│   └── SID/                      # SID strategy source images
│
├── .github/workflows/
│   └── research.yml              # GitHub Actions: runs research agent 9am & 6pm UK
│
├── .env.example                  # Environment variable template
├── package.json
└── railway.json                  # Cloud deployment config
```

---

## Strategy 1 — VWAP Scalper

**Bot:** `bot.js` · **Config:** `rules.json` · **Log:** `trades.csv`

Fast intraday scalping on crypto futures. Looks for price near the VWAP with RSI and EMA momentum confirmation. Trades are typically open for minutes to hours. Runs every 15–30 minutes.

- **Assets:** Crypto (BTC, ETH, SOL, XRP, LINK, HYPE, APT, ONDO, JUP)
- **Exchange:** BitGet futures (3× leverage)
- **Paper flag:** `PAPER_TRADING=true` in `.env`
- **Version:** v1.3

---

## Strategy 2 — Ironclad Multi-Timeframe Swing

**Bot:** `bot-ironclad.js` · **Log:** `trades-ironclad.csv` · [Full details →](IRONCLAD-README.md)

Swing trading strategy using daily trend + 15-minute entry trigger. Confirms higher-timeframe trend via swing highs/lows, then enters on a 15m breakout in trend direction. Uses EMA levels and Fibonacci extensions for three-level take profit targets.

- **Assets:** Crypto, US stocks (AAPL, NVDA, GOOGL), commodities (Gold, Oil)
- **Exchange:** BitGet futures (3× leverage)
- **Paper flag:** `IRONCLAD_PAPER=true` in `.env`
- **Version:** v1.3

---

## Strategy 3 — SID Stock Swing

**Bot:** `bot-sid.js` · **Log:** `trades-sid.csv` · [Full details →](SID-README.md)

A slow, rules-based swing strategy focused exclusively on **US stocks and ETFs**. Uses RSI(14) and MACD(12,26,9) on daily charts only. Designed for steady gains over a 12-month horizon with strict rules to avoid volatility traps.

- **Assets:** US stocks and ETFs **only** — see [SID-README.md](SID-README.md) for the advisory watchlist
- **Exchange:** Separate broker (see SID-README for recommendations)
- **Leverage:** None — spot equity positions only
- **Paper flag:** `SID_PAPER=true` in `.env`
- **Version:** v1.0

---

## Research Agent & Dashboard

**Script:** `research.js` · **Dashboard:** [GitHub Pages](https://your-username.github.io/your-repo)

Runs automatically at **9am and 6pm UK time** via GitHub Actions. Each run:

1. Queries Perplexity for today's market signals across all asset classes
2. Fetches the latest ChartHackers / DegenDave YouTube transcript for crypto swing picks
3. Reads all three trade logs and merges them chronologically
4. Checks the position monitor files for realized P&L on closed trades
5. Fetches live BitGet prices for unrealized P&L on open trades
6. Publishes an updated dashboard to GitHub Pages with:
   - Market sentiment signals by token
   - Today's bot activity summary
   - Full trade history with filters (Bot, Strategy, Pair, Month, Category, Version, Mode)
   - Realized P&L (🔒 locked) vs unrealized P&L (📊 live) clearly labelled

---

## P&L Tracking

Each swing strategy (Ironclad and SID) has a **paper position monitor** built into the bot. On every run before scanning for new entries, the monitor:

1. Loads open positions
2. Fetches 500 × 15m candles (≈5 days) per position
3. Walks through OHLC to detect the first SL or TP breach
4. Simulates the 3-TP split plan: 40% → TP1 (SL moves to B/E), 35% → TP2 (SL trails to TP1), 25% → TP3
5. Writes closed results with realized P&L to `closed-positions-*.json`

The dashboard uses realized P&L where available. Unrealized P&L (still-open positions) is calculated from the live BitGet price and will fluctuate until the trade closes.

---

## Safety Features

- Paper trading on by default for all three strategies
- Daily trade cap per symbol (`MAX_TRADES_PER_DAY`)
- Maximum trade size cap (`MAX_TRADE_USD`)
- 1% portfolio risk per trade (Ironclad, VWAP)
- 0.5%–2% portfolio risk per trade (SID, no leverage)
- Earnings date avoidance — 14-day blackout window per stock (SID)
- No trade within 14 days of earnings on any stock (all strategies)
- Research signal filter — bots check daily sentiment before entering
- Full decision log per run in `*-log.json` files

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```
# BitGet (VWAP Scalper + Ironclad)
BITGET_API_KEY=
BITGET_SECRET_KEY=
BITGET_PASSPHRASE=

# Paper trading flags (set to 'false' to go live)
PAPER_TRADING=true
IRONCLAD_PAPER=true
SID_PAPER=true

# Position sizing
PORTFOLIO_USD=500
MAX_TRADE_USD=50
LEVERAGE=3

# Research agent
PERPLEXITY_API_KEY=

# SID broker (when configured)
SID_BROKER_KEY=
SID_BROKER_SECRET=
```

---

## Quick Start

```bash
npm install
node bot.js              # VWAP Scalper (paper mode)
node bot-ironclad.js     # Ironclad (paper mode)
node bot-sid.js          # SID (paper mode)
node research.js         # Generate dashboard manually
```

---

## Cloud Deployment

GitHub Actions runs the research agent on schedule — no server needed for the dashboard. For the trading bots, Railway or any cron-compatible host works. See `railway.json` and `.github/workflows/research.yml`.
