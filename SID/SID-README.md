# SID Stock Swing Strategy

A slow and steady swing trading strategy focused exclusively on **US stocks and ETFs**. Designed for consistent gains over a 12-month horizon using two indicators and a strict set of rules to avoid volatility events.

**Current version:** v1.2 — instructor-aligned (sticky RSI signal + RSI/MACD direction-align on a later day). See [Version History](#version-history).

**Bot file:** `bot-sid.js`
**PineScripts:**
- `pine/sid-strategy.pine` — main strategy script (backtest on TradingView, 15-min chart)
- `pine/sid-rsi-signals.pine` — companion indicator: daily RSI on its own pane with 30/70 lines + signal/entry arrows
- `pine/sid-macd-signals.pine` — companion indicator: daily MACD on its own pane with signal/entry arrows

**Trade log:** `trades-sid.csv`
**Position tracker:** `open-positions-sid.json` / `closed-positions-sid.json`

---

## What Makes SID Different

| Feature | Detail |
|---------|--------|
| Asset class | **US Stocks and ETFs only** — no crypto, no forex, no commodities |
| Timeframe | **Daily chart only** |
| Leverage | **None** — spot equity positions, no margin |
| Indicators | RSI(14) and MACD(12, 26, 9) — default settings, nothing else |
| Exit signal | **RSI reaches 50** — single clean exit, no partial closes |
| Earnings rule | **Skip any trade within 14 calendar days of an earnings date** |
| Horizon | Medium-term swing: typically days to a few weeks per trade |
| Max open trades | 3–5 at any one time |
| Risk per trade | 0.5%–2% of account (start at 0.5% while paper trading) |

---

## Core Logic (v1.2 — instructor-aligned)

The strategy follows the SID instructor's method directly. v1.2 fixes a v1.1 bug where the bot incorrectly required RSI to remain in the extreme zone at entry — the instructor's actual rule is that the signal date is **STICKY** and entry happens on a **later day** when RSI direction and MACD direction both point in the trade direction.

### Step 1 — Signal Date (daily close)
On a daily candle close:
- **Long signal:** RSI(14) crosses below 30 → trade is **ARMED LONG**
- **Short signal:** RSI(14) crosses above 70 → trade is **ARMED SHORT**

RSI does **not** need to stay in the extreme zone after this — the arm is sticky.

### Step 2 — Earnings Check
Before arming, check whether an earnings announcement falls within **14 calendar days** of the current date. If yes — **skip the trade entirely.** Earnings cause unpredictable gaps that invalidate the strategy's risk assumptions.

### Step 3 — Entry Day (a LATER daily close)
On each subsequent daily close, check if the trade can enter:
- **Long entry:** daily RSI direction is UP **AND** daily MACD line direction is UP — both pointing up on the same daily bar.
- **Short entry:** daily RSI direction is DOWN **AND** daily MACD line direction is DOWN — both pointing down on the same daily bar.

The MACD does **not** have to cross — it just needs to be pointing in the same direction as RSI. Entry is at that daily close.

### Step 4 — Optional 15-min Intraday Confirmation (v1.1 bot tweak, can be disabled)
After the daily Step 3 fires, the bot can wait for a confirming 15-min candle during the US session:
- **Long entry confirm:** a 15-min candle closes **green** (close > open).
- **Short entry confirm:** a 15-min candle closes **red** (close < open).

This is a minor confirmation tweak the bot adds — it filters false alignments. Toggle off in the script inputs to revert to the pure instructor method.

### Step 5 — Signal Expiry
An ARMED signal cancels if:
- **3 trading days** pass without entry alignment (hard timeout), OR
- An earnings date enters the 14-day blackout window

### Step 6 — Stop Loss
Placed using the daily-bar extremes during the signal-to-entry window:
- **Long:** Lowest daily low between signal date and entry date, **rounded DOWN** to the nearest whole dollar
- **Short:** Highest daily high between signal date and entry date, **rounded UP** to the nearest whole dollar

### Step 7 — Take Profit
Exit when **daily RSI reaches 50**. Single full exit — no partials.

---

## Entry Checklist (Long) — v1.1

**Stage 1 — Signal (daily close, ~21:00 UTC)**
- [ ] RSI(14) default settings, MACD(12, 26, 9) default settings — histogram hidden
- [ ] Daily RSI < 30 detected
- [ ] Daily MACD line pointing up
- [ ] No earnings date within 14 calendar days
- [ ] Signal armed → alert sent

**Stage 2 — Entry (next US session, every 15 min)**
- [ ] Daily RSI still < 30 on most recent daily close
- [ ] Daily MACD still pointing up
- [ ] Within 3 trading days of signal
- [ ] Most recent 15-min candle closed green (close > open) → enter at that close

**Stage 3 — Management**
- [ ] Stop loss = lowest daily low (signal date → entry date) rounded DOWN to whole dollar
- [ ] Take profit alert set at daily RSI 50

## Entry Checklist (Short) — v1.1

**Stage 1 — Signal (daily close)**
- [ ] Daily RSI > 70 detected
- [ ] Daily MACD line pointing down
- [ ] No earnings date within 14 calendar days
- [ ] Signal armed → alert sent

**Stage 2 — Entry (next US session, every 15 min)**
- [ ] Daily RSI still > 70 on most recent daily close
- [ ] Daily MACD still pointing down
- [ ] Within 3 trading days of signal
- [ ] Most recent 15-min candle closed red (close < open) → enter at that close

**Stage 3 — Management**
- [ ] Stop loss = highest daily high (signal date → entry date) rounded UP to whole dollar
- [ ] Take profit alert set at daily RSI 50

---

## Position Sizing

Risk is defined as a **percentage of your account**, not a fixed dollar amount.

```
Risk Amount ($)       = Account Size × Risk %
$ Risk per Share      = Entry Price − Stop Loss
% Risk per Position   = $ Risk per Share ÷ Entry Price
Position Size ($)     = Risk Amount ÷ % Risk per Position
Max Shares to Buy     = Position Size ÷ Entry Price  →  always round DOWN
```

**Example (PARA, account $5,000, 2% risk):**
- Risk amount: $5,000 × 2% = **$100**
- Entry: $10.26 · Stop: $9.00 → Risk per share: **$1.26**
- % Risk per position: $1.26 ÷ $10.26 = **12.28%**
- Position size: $100 ÷ 12.28% = **$814**
- Max shares: $814 ÷ $10.26 = 79.3 → **79 shares** (rounded down)

Start at **0.5% risk** while paper trading. Move to 1% once live and consistently profitable.

---

## Advisory Watchlist

The 50-stock starter list below is a **starting point, not a fixed rule**. Stocks that repeatedly show poor performance or unfavourable patterns should be removed. New stocks can be added at any time when:

- Market research or the daily dashboard signals a stock entering a swing position
- Perplexity research identifies strong bullish/bearish analyst sentiment
- Sector rotation or macro events favour a particular industry group

The watchlist is intended to give good representation across market sectors so there is always an opportunity to find. Review and update it regularly.

**Starter Watchlist (50 stocks and ETFs):**

| # | Ticker | # | Ticker | # | Ticker | # | Ticker | # | Ticker |
|---|--------|---|--------|---|--------|---|--------|---|--------|
| 1 | DIA | 11 | COST | 21 | HD | 31 | SLV | 41 | XLC |
| 2 | IWM | 12 | DIS | 22 | IBM | 32 | SQQQ | 42 | XLE |
| 3 | QQQ | 13 | DKS | 23 | INTC | 33 | TGT | 43 | XLF |
| 4 | SPY | 14 | ETSY | 24 | JPM | 34 | TNA | 44 | XLI |
| 5 | AAPL | 15 | FCX | 25 | MA | 35 | TQQQ | 45 | XLK |
| 6 | AMD | 16 | FDX | 26 | META | 36 | TSLA | 46 | XLP |
| 7 | AMZN | 17 | GM | 27 | MCD | 37 | TZA | 47 | XLRE |
| 8 | BA | 18 | GOLD | 28 | MSFT | 38 | VZ | 48 | XLU |
| 9 | BAC | 19 | GOOG | 29 | PYPL | 39 | WMT | 49 | XLV |
| 10 | CAT | 20 | GS | 30 | QYLD | 40 | XLB | 50 | XLY |

**Managing the list:**
- If a stock repeatedly stops out before RSI 50 is reached → consider removing
- If a sector ETF (XLK, XLE etc.) is trending strongly → weight more trades there
- Use the daily dashboard's research tab to identify stocks entering swing territory
- Do not add a stock mid-earnings season without confirming the 14-day rule

---

## Rules for Volatile Markets

The strategy has specific guardrails built in precisely **because** stock markets can move violently:

1. **Earnings blackout** — No trade within 14 days of an earnings date, ever. Earnings gaps routinely blow through stop losses as if they don't exist.
2. **No leverage** — The strategy is designed for spot equity. Adding leverage amplifies drawdown and defeats the slow-and-steady purpose.
3. **Daily chart only** — Intraday noise is ignored. A signal is only valid on the daily close.
4. **RSI 50 exit** — Taking profit at RSI 50 (the midpoint) avoids giving back gains by staying in too long. The move from 30 to 50, or 70 to 50, is the reliable part of the mean reversion.
5. **3–5 trade maximum** — Being in too many positions at once makes it impossible to monitor each one properly and concentrates risk during market-wide selloffs.
6. **Check the news** — Before entering any trade, check for scheduled news events (Fed announcements, major economic data, geopolitical events) that could trigger sharp moves.

---

## Recommended Broker (UK)

This strategy requires a broker that can trade **US stocks and ETFs** (not CFDs where possible). BitGet is not suitable for this strategy — it has a limited stock CFD list and no access to ETFs like QQQ, SPY, DIA, or IWM.

### ✅ Top Recommendation — Interactive Brokers (IBKR)

The gold standard for algorithmic UK traders accessing US markets.

| Feature | Detail |
|---------|--------|
| FCA Regulated | ✅ Yes |
| UK Residents | ✅ Fully supported |
| US Stocks & ETFs | ✅ Full access — all 50 watchlist stocks available |
| Fees | ~$0.005/share (min $1) — among the lowest available |
| API | ✅ TWS API — well documented, Node.js compatible |
| Paper Trading | ✅ Separate paper trading account built in |
| Volume / Liquidity | ✅ Institutional grade |
| Minimum Deposit | ~£2,000 recommended |

IBKR is used by professional algorithmic traders worldwide. The TWS (Trader Workstation) API is mature, reliable, and has community-maintained Node.js libraries (`@stoqey/ib`). The fee structure is transparent and very competitive for US stocks.

**Sign up:** [interactivebrokers.co.uk](https://www.interactivebrokers.co.uk)

---

### Alternative — Alpaca Markets

If simplicity of API is the priority:

| Feature | Detail |
|---------|--------|
| US Stocks & ETFs | ✅ Full access |
| Fees | Commission-free |
| API | ✅ Modern REST API (very similar to BitGet workflow) |
| Paper Trading | ✅ Built-in, free |
| UK Residents | ⚠️ Available via Alpaca Global — slightly more setup required |
| FCA Regulated | ❌ US-regulated (SEC/FINRA) — not FCA |

Alpaca's API is extremely developer-friendly (REST + WebSocket, very similar to the BitGet pattern already in use). Commission-free trading makes it attractive for a strategy with relatively low trade frequency. The UK setup is more involved than IBKR but workable.

**Sign up:** [alpaca.markets](https://alpaca.markets)

---

## Why Not BitGet for SID?

BitGet offers a small number of US stock CFDs (AAPL, TSLA, MSFT, NVDA, GOOGL, META) but:
- No ETF access (QQQ, SPY, DIA, IWM, XL* sector ETFs are not available)
- CFDs are contracts-for-difference, not real share ownership
- The SID position sizing formula is built around share quantities and real equity prices
- BitGet's stock CFD spreads are wider than dedicated equity brokers

---

## Version History

| Version | Date | Change |
|---------|------|--------|
| v1.0 | Apr 2026 | Initial implementation — RSI(14) + MACD(12,26,9), daily chart, US stocks/ETFs |
| v1.1 | 10 May 2026 | Two-stage entry: daily signal arms the trade; entry now requires a 15-min intraday candle closing in trade direction during the next US session. Added 3-day hard timeout on armed signals. Goal: avoid fake reversals where RSI dips into oversold but the move continues lower the next day. |
| v1.2 | 11 May 2026 | **Instructor-aligned fix.** v1.1 incorrectly required RSI to still be in the extreme zone on the entry day; the instructor's actual rule treats the signal date as STICKY and the entry day is a later day where RSI direction + MACD direction both align with the trade. v1.2 fixes this: arm on RSI hitting extreme alone, then enter when RSI+MACD direction-align (within the 3-day timeout). Discovered via Project D analysis comparing 10 instructor-marked trades vs the bot. Caught the AAPL, AMD, GM trades that v1.1 had missed. The 15-min intraday confirmation from v1.1 is preserved as an optional input (default ON). |

---

## Files

| File | Purpose |
|------|---------|
| `bot-sid.js` | Main bot code |
| `trades-sid.csv` | Trade log (entry, stop, target, exit) |
| `open-positions-sid.json` | Active positions being monitored |
| `closed-positions-sid.json` | Closed positions with realized P&L |
| `SID-README.md` | This file |
| `research/SID/` | Original strategy source images |
