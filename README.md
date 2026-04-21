# Claude + TradingView MCP — Automated Trading

Automated cryptocurrency trading bot that connects Claude to TradingView and executes trades on a crypto exchange, with built-in safety checks, cloud deployment, and tax logging.

## Core Capabilities

1. **Exchange Integration** — Claude reads TradingView charts and executes trades on BitGet (and 9 other exchanges)
2. **Safety Validation** — All strategy conditions must pass before any trade executes
3. **Cloud Deployment** — Railway runs the bot 24/7 without your laptop being on
4. **Tax Documentation** — Every trade logs to CSV with date, price, fees, and net amounts
5. **Paper Trading** — Enabled by default; no real money at risk during setup

## Quick Start

Paste the one-shot prompt from [`prompts/02-one-shot-trade.md`](prompts/02-one-shot-trade.md) into Claude Code. It will walk you through all 8 setup steps interactively.

## Project Structure

```
├── bot.js              # Main trading bot
├── rules.json          # Your trading strategy (indicators, entry/exit conditions)
├── trades.csv          # Trade log (auto-generated, for tax records)
├── .env.example        # Environment variable template — copy to .env
├── package.json        # Node.js dependencies
├── railway.json        # Cloud deployment config (runs every 4 hours by default)
├── prompts/
│   ├── 01-extract-strategy.md   # Extract a strategy from a YouTube transcript
│   └── 02-one-shot-trade.md     # Full onboarding prompt (start here)
└── docs/
    ├── setup-windows.md          # TradingView + MCP setup for Windows
    └── setup-linux.md            # TradingView + MCP setup for Linux/Mac
```

## How the Bot Works

When executed, the bot follows this sequence:

1. Reads your trading rules from `rules.json`
2. Fetches live candle data from Binance (free, no account needed)
3. Calculates EMA(8), VWAP, and RSI(3) indicators
4. Determines market direction (bullish / bearish / neutral)
5. Validates daily trade limits and position sizing caps
6. Runs a full safety check against all strategy conditions
7. Places an order via BitGet if all conditions pass
8. Logs the decision to `safety-check-log.json` and `trades.csv`

If any condition fails, the bot exits with a clear explanation of which rule prevented the trade.

## Supported Exchanges

BitGet, Binance, Bybit, OKX, Coinbase, Kraken, KuCoin, Gate.io, MEXC, Bitfinex

## Cloud Deployment (Railway)

Railway lets the bot run on a schedule without your PC. The default cron in `railway.json` runs every 4 hours. You can change this to hourly, daily, or any custom cron expression.

Setup: [railway.app](https://railway.app) → New Project → connect repo → set environment variables → deploy.

## Tax Summary

```bash
node bot.js --tax-summary
```

Prints total trades and cumulative fees from `trades.csv`.

## Safety Features

- Paper trading on by default (`PAPER_TRADING=true` in `.env`)
- Daily trade cap (`MAX_TRADES_PER_DAY`)
- Maximum trade size cap (`MAX_TRADE_USD`)
- Strategy-specific avoidance rules (e.g. "do not trade if price is >1.5% from VWAP")
- Full decision log in `safety-check-log.json` for every run

## Getting Started

1. Copy `.env.example` to `.env` and add your exchange API credentials
2. Run `npm install`
3. Run `node bot.js` to test in paper mode
4. Deploy to Railway for 24/7 operation

Or just paste [`prompts/02-one-shot-trade.md`](prompts/02-one-shot-trade.md) into Claude Code and let it guide you through everything.
