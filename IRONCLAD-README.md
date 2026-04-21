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

| Symbol | Market |
|--------|--------|
| BTCUSDT | Crypto |
| ETHUSDT | Crypto |
| SOLUSDT | Crypto |
| XRPUSDT | Crypto |
| LINKUSDT | Crypto |
| HYPEUSDT | Crypto |
| VIRTUALUSDT | Crypto |
| AAPLUSDT | Stock |
| NVDAUSDT | Stock |
| GOOGLUSDT | Stock |
| XAUUSDT | Commodity (Gold) |

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

The bot checks all 11 symbols automatically on the same smart schedule as the main bot:
- Every 15 minutes during London open, US open and US close
- Every 30 minutes mid-session
- Every hour in quiet periods
- Every 4 hours on weekends

Each run checks the daily trend first, then looks for a 15m entry trigger. If both align it logs a paper trade with entry, stop loss and take profit levels.

---

## Files

| File | Purpose |
|------|---------|
| bot-ironclad.js | Main bot code |
| rules-ironclad.json | Strategy configuration |
| trades-ironclad.csv | Trade log (entry, stop, target) |
| ironclad-log.json | Detailed decision log per run |
| IRONCLAD-README.md | This file |
