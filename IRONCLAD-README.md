# Ironclad Multi-Timeframe Swing Strategy

**Source:** https://youtu.be/s9HV_jyeUDk?t=535
**Bot file:** bot-ironclad.js
**Config file:** rules-ironclad.json
**Trade log:** trades-ironclad.csv

---

## Backtest Performance

| Metric | Result |
|--------|--------|
| Win Rate | 72.17% |
| Total Return | 957.39% |
| Total Trades | 1,175 |
| Max Drawdown | ~50% (spot, no leverage) |
| Original Market | Forex |
| Adapted For | Crypto, Stocks, Commodities on BitGet Futures |

---

## The Core Idea

The strategy is built on one simple principle — **only trade in the direction of the bigger trend**. You use the daily chart to find which way the market is truly moving, then drop down to the 15 minute chart to find a precise moment to jump in.

---

## Step 1 — Find the Daily Trend

On the **daily chart** you look at swing highs and swing lows — the obvious peaks and valleys in price.

**Bullish trend:**
- Each swing high is **higher** than the last
- Each swing low is **higher** than the last
- Price is making a staircase pattern upwards

**Bearish trend:**
- Each swing high is **lower** than the last
- Each swing low is **lower** than the last
- Price is making a staircase pattern downwards

You need to see **at least 2 consecutive** higher highs + higher lows (or lower highs + lower lows) before calling a trend. One swing isn't enough — it could just be a blip.

---

## Step 2 — Wait for a Pullback on the 15 Minute Chart

Once the daily trend is confirmed, you **don't chase price**. You wait for it to pull back against the trend slightly, which creates a new swing point on the 15 minute chart.

- **In an uptrend:** price dips down and forms a swing low on the 15m
- **In a downtrend:** price bounces up and forms a swing high on the 15m

---

## Step 3 — The Entry Trigger

You enter when price **breaks out of that swing point** and resumes the main trend direction.

- **Long entry:** price breaks back up above the high of the 15m swing low candle
- **Short entry:** price breaks back down below the low of the 15m swing high candle

This is the key — you're not guessing. You wait for price to **prove** it's resuming the trend before entering.

---

## Step 4 — Stop Loss and Take Profit

**Stop loss:**
- Long: placed just below the 15m swing low used for entry
- Short: placed just above the 15m swing high used for entry
- An ATR buffer of 0.5x is added to avoid getting stopped out by noise

**Take profit:**
- Minimum **1.5:1 risk to reward ratio**
- If you risk $100 you target at least $150 profit
- Targets the next significant swing high (long) or swing low (short) on the 15m

---

## Why It Works

- You are trading **with** the dominant trend, not against it
- The pullback entry gives you a **tight stop loss** close to your entry
- The 1.5:1 minimum R:R means you can be **wrong 40% of the time** and still be profitable
- The 2-bar swing confirmation filters out **fake moves and noise**
- No fancy indicators — just pure price action and structure

---

## Strategy Parameters

| Parameter | Value |
|-----------|-------|
| Higher Timeframe (HTF) | 1 Day |
| Lower Timeframe (LTF) | 15 Minutes |
| Swing Lookback | 2 bars |
| LTF Swing Lookback | 2 bars |
| Trend Swing Count | 2 consecutive |
| ATR Threshold | 0.5x (noise filter) |
| Zone Filter | Off |
| Order Block Filter | Off |
| Minimum Risk:Reward | 1.5:1 |
| Max Risk Per Trade | 1% of portfolio |
| Leverage | 3x |

---

## Symbols Monitored

18 crypto pairs selected for liquidity (CoinGecko top 100) and low BTC correlation:

| Symbol | Category |
|--------|----------|
| BTCUSDT | Core L1 |
| ETHUSDT | Core L1 |
| SOLUSDT | Core L1 |
| XRPUSDT | Core L1 |
| LINKUSDT | Oracle |
| VIRTUALUSDT | AI Agent |
| APTUSDT | L1 |
| ONDOUSDT | RWA |
| JUPUSDT | DEX |
| RENDERUSDT | DePIN / AI |
| TAOUSDT | Bittensor AI |
| AVAXUSDT | L1 |
| ZECUSDT | Privacy |
| KASUSDT | BlockDAG |
| TONUSDT | Telegram ecosystem |
| NEARUSDT | L1 AI layer |
| INJUSDT | DeFi L1 |
| SUIUSDT | L1 |

**Watchlist rule:** only trade coins in the CoinGecko top 100. Anything ranked lower has thin liquidity and wide spreads that hurt fill prices.

Note: HYPEUSDT is excluded while a manual position is open — re-add once that position closes.

---

## Risk Warning

The backtest showed up to **50% drawdown** at times — meaning the account halved before recovering. On spot trading that is painful but survivable. With **3x leverage** that drawdown could be significantly larger.

**This is why we:**
- Paper trade first — `IRONCLAD_PAPER=true`
- Risk only 1% of portfolio per trade
- Keep a separate pool of money for this strategy
- Monitor results for at least a week before considering going live

---

## How It Runs

The bot runs on **Railway** (cloud server) via `railway-runner.js`, which loops every 15 minutes:

1. Pulls latest state files from GitHub (`main` branch)
2. Runs `bot-ironclad.js` — scans all 18 symbols for entry signals
3. Runs `bot-hype-manager.js` — manages any manual HYPE position
4. Pushes updated logs to the `logs` branch on GitHub for visibility

Each scan checks the daily trend first, then looks for a 15m entry trigger. If both align and `IRONCLAD_PAPER=false`, a live market order is placed on BitGet.

---

## Going Live — BitGet API Setup

This is where most people get caught. Follow these steps exactly:

### 1. Create the API key

In BitGet → Profile → API Management → Create API:
- **Name:** anything (e.g. "IroncladBot")
- **Passphrase:** alphanumeric only — no special characters (`$`, `@`, `!` etc). These break environment variable parsing.
- **Permissions required:**
  - ✅ Read-Write Futures Orders
  - ✅ Read-Write Spot Trading (needed for some account info calls)
  - ❌ IP whitelist — leave blank unless you have a fixed IP
- **Do NOT enable** copy trading or withdrawal permissions

> Note: "Futures Position" read is not available as a standalone permission on some account tiers. The bot works around this by using environment variables for position size instead of reading it from the API.

### 2. Set BitGet to one-way position mode

BitGet defaults to **hedge mode** (separate long/short positions). The bot uses **one-way mode**.

In BitGet → Futures → Settings → Position Mode → select **One-Way**.

If you skip this step, orders will fail with error `40774`.

### 3. Set leverage

The bot attempts to set leverage automatically via API but this requires an additional account permission (`set-leverage`) that isn't always available. If the API call fails it logs a warning and continues — it will use whatever leverage is already set on your account.

**Manually set 3× isolated leverage** on each symbol you plan to trade before the bot goes live. You only need to do this once per symbol.

### 4. Environment variables on Railway

Add these to your Railway service:

```
BITGET_API_KEY=your_key
BITGET_SECRET_KEY=your_secret
BITGET_PASSPHRASE=your_passphrase   ← alphanumeric only
IRONCLAD_PAPER=false                ← must be the string "false" — not blank, not 0
PORTFOLIO_USD=500
MAX_TRADE_USD=50
LEVERAGE=3
MAX_TRADES_PER_DAY=3
GITHUB_TOKEN=your_github_pat        ← needed for state sync to/from GitHub
```

> **Critical:** `IRONCLAD_PAPER` must be set to the string `false` explicitly. If the variable is missing or blank, the bot defaults to paper mode.

### 5. Create the logs branch on GitHub

Before deploying to Railway, create a `logs` branch on your repo:

```bash
git checkout -b logs
git push origin logs
git checkout main
```

Railway only watches `main` — the bot pushes state to `logs` so you can see what's happening without triggering redeployments.

### 6. GitHub Personal Access Token

Create a PAT at GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained:
- **Repository access:** your trading repo only
- **Permissions:** Contents → Read and Write

Add it as `GITHUB_TOKEN` on Railway.

---

## Files

| File | Purpose |
|------|---------|
| bot-ironclad.js | Main bot code |
| bot-hype-manager.js | Manual HYPE position manager (TP1/TP2/TP3 + trailing stop) |
| railway-runner.js | Cloud runner — loops every 15 min, syncs state to/from GitHub |
| rules-ironclad.json | Strategy configuration |
| trades-ironclad.csv | Trade log (entry, stop, target) |
| ironclad-log.json | Detailed decision log per run |
| open-positions-ironclad.json | Open position tracker |
| closed-positions-ironclad.json | Closed trade P&L records |
| cooldown-ironclad.json | Per-symbol cooldown tracker |
| hype-state.json | HYPE manager state (which TPs have filled) |
| IRONCLAD-README.md | This file |

---

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `40404 endpoint not found` | Wrong API endpoint format | Use kebab-case: `place-order` not `placeOrder` |
| `400172 margin mode cannot be empty` | Missing marginMode field | Add `marginMode: 'isolated'` to order body |
| `400172 side parameter mismatch` | Using hedge-mode side format | Use `side: 'buy'/'sell'` + `tradeSide: 'open'/'close'` |
| `40774 unilateral position type` | Account in wrong position mode | Set BitGet to one-way mode, add `tradeSide: 'open'` |
| `40014 incorrect permissions` | set-leverage requires extra permission | Non-fatal — bot catches this and continues |
| Bot always in paper mode | `IRONCLAD_PAPER` not set to exact string `false` | Set Railway env var to `false` (string, not blank) |
