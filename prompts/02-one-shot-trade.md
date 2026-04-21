# One-Shot Onboarding Prompt for Automated Trading Bot

Paste this entire prompt into Claude Code to be walked through the full setup, step by step. Claude will pause at each stage to gather your input before continuing.

---

## Prompt

You are helping me set up an automated cryptocurrency trading bot that connects TradingView, Claude, and a crypto exchange. Work through the following 8 steps in order. After each step, pause and wait for my confirmation or input before moving to the next.

---

### Step 1 — Repository Setup

Clone or confirm the project files are in place:

```
https://github.com/jackson-video-resources/claude-tradingview-mcp-trading
```

Check that the following files exist:
- `bot.js`
- `rules.json`
- `.env.example`
- `trades.csv`
- `package.json`
- `railway.json`

If any are missing, recreate them from the templates in this repository.

Run `npm install` to install dependencies.

Confirm with me that everything looks correct before moving on.

---

### Step 2 — Exchange Selection & API Credentials

Ask me which exchange I want to use. Supported exchanges:

| # | Exchange   |
|---|------------|
| 1 | BitGet     |
| 2 | Binance    |
| 3 | Bybit      |
| 4 | OKX        |
| 5 | Coinbase   |
| 6 | Kraken     |
| 7 | KuCoin     |
| 8 | Gate.io    |
| 9 | MEXC       |
|10 | Bitfinex   |

Once I choose an exchange:
1. Tell me exactly where to go in the exchange to generate API keys
2. Remind me to enable **trade permissions only** — no withdrawals
3. Remind me to add an IP whitelist if the exchange supports it
4. Ask me to paste my API Key, Secret Key, and Passphrase (if required)
5. Copy `.env.example` to `.env` and populate it with my credentials

Do not move on until I confirm credentials are saved in `.env`.

---

### Step 3 — TradingView Connection

Check that the TradingView MCP is connected by running:

```
tv_health_check
```

If `cdp_connected` is `true` — confirm and move on.

If not connected, guide me through the platform-specific setup:
- **Windows:** See `docs/setup-windows.md`
- **Linux/Mac:** See `docs/setup-linux.md`

The key requirement is that TradingView Desktop must be launched with:
```
--remote-debugging-port=9222
```

And the MCP config must include:
```json
{
  "mcpServers": {
    "tradingview": {
      "command": "npx",
      "args": ["-y", "@tradingview/mcp-server"],
      "env": { "CDP_PORT": "9222" }
    }
  }
}
```

Do not continue until `tv_health_check` returns `cdp_connected: true`.

---

### Step 4 — Strategy Configuration

Ask me which strategy source I want to use:

**Option A — Use the demo strategy**
The default `rules.json` contains a VWAP + RSI(3) + EMA(8) scalping strategy for BTCUSDT on 1-minute charts. Explain the strategy to me in plain language so I understand the entry conditions before we use it.

**Option B — I'll describe my own rules**
Ask me to describe my trading rules in plain language (indicators, entry/exit conditions, avoidance rules, risk %). Then convert my description into a properly formatted `rules.json` and show it to me for confirmation.

**Option C — Extract from a YouTube video**
Ask me for the YouTube URL. Use the prompt in `prompts/01-extract-strategy.md` to extract the strategy from the transcript and generate a `rules.json`. Show me the result for confirmation before saving.

Once the strategy is confirmed, read it back to me in plain English — entry conditions, exit conditions, and what would stop a trade — so I can verify it matches what I intend.

---

### Step 5 — Cloud Deployment (Railway)

Explain that Railway allows the bot to run 24/7 without my laptop being on.

Walk me through:
1. Creating a free account at [railway.app](https://railway.app)
2. Creating a new project and connecting it to the GitHub repository (or uploading the files directly)
3. Setting environment variables in Railway (same as my `.env` file — paste each one)
4. Confirming `railway.json` is present (it sets the cron schedule to every 4 hours by default)
5. Asking me if I want to change the schedule — options: every hour, every 4 hours, daily at 9am UTC, custom cron expression
6. Deploying and confirming the first scheduled run appears in the Railway logs

---

### Step 6 — Tax Documentation

Explain how the trade logging works:
- Every execution writes a row to `trades.csv` with: Date, Time, Exchange, Symbol, Side, Quantity, Price, Total USD, Fee, Net Amount, Order ID, Mode, Notes
- Paper trades are marked `Mode: paper`; live trades are marked `Mode: live`
- I can run `node bot.js --tax-summary` at any time to see total trades and fees

Ask me to confirm I know where `trades.csv` is stored (locally and/or on Railway via volume mount).

---

### Step 7 — Safety Check Explanation

Before any live run, read the current `rules.json` and explain to me in plain, non-technical language:

1. **What market conditions must be true for a LONG trade to be placed**
2. **What market conditions must be true for a SHORT trade to be placed**
3. **What would cause the bot to skip a trade entirely** (avoidance rules + daily limits + position sizing caps)
4. **What the maximum possible loss per trade is** based on my portfolio size and `MAX_TRADE_USD`

Ask me: *"Are you happy with these conditions before we run?"*

Do not proceed to Step 8 until I say yes.

---

### Step 8 — Live Test Run (Paper Mode)

Confirm that `PAPER_TRADING=true` is set in `.env`.

Run the bot once locally:
```
node bot.js
```

Show me the full output and explain:
- What price data was fetched
- What the indicator values were (EMA8, RSI3, VWAP)
- Whether the safety check passed or failed, and why
- If it passed: what order would have been placed (size, side, price)
- Where the decision was logged (`safety-check-log.json` and `trades.csv`)

Ask me: *"Would you like to run again, adjust the strategy, or switch to live trading?"*

If I say live trading, remind me to:
1. Set `PAPER_TRADING=false` in `.env` (and in Railway environment variables)
2. Ensure my exchange API keys have trade permissions enabled
3. Start with a small portfolio amount until I have verified several cycles work correctly

---

## Notes

- Paper trading mode is enabled by default — no real money is at risk during setup
- All 8 steps are designed to be completed in a single Claude Code session
- The bot uses free Binance market data (no Binance account needed for data)
- Cloud deployment via Railway is free for low-frequency schedules
