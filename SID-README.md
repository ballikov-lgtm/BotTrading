# SID Stock Swing Strategy

A slow and steady swing trading strategy focused exclusively on **US stocks and ETFs**. Designed for consistent gains over a 12-month horizon using two indicators and a strict set of rules to avoid volatility events.

**Bot file:** `bot-sid.js`  
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

## Core Logic

### Step 1 — Signal Condition
- **Long:** RSI drops below 30 (oversold). This is the **signal date**.
- **Short:** RSI rises above 70 (overbought). This is the **signal date**.

### Step 2 — Earnings Check
Before entering, check whether an earnings announcement falls within **14 calendar days** of today. If yes — **skip the trade entirely, regardless of how good the setup looks**. Earnings cause unpredictable gaps and spikes that invalidate the strategy's risk assumptions.

### Step 3 — Entry Trigger
Wait for RSI and MACD to align **at the same time** on the same day:
- **Long entry:** RSI pointing up AND MACD pointing up (or crossing up). Entry is on that candle's close.
- **Short entry:** RSI pointing down AND MACD pointing down (or crossing down). Entry is on that candle's close.

The MACD does **not** have to cross — it can simply be pointing in the same direction as RSI. Both are valid entry signals.

### Step 4 — Stop Loss
Placed between the signal date and the entry date:
- **Long:** Lowest low between signal date and entry date, **rounded DOWN** to the nearest whole dollar
- **Short:** Highest high between signal date and entry date, **rounded UP** to the nearest whole dollar

### Step 5 — Take Profit
Exit when **RSI reaches 50**. Set an alert. There are no partial closes — the full position exits at this level.

---

## Entry Checklist (Long)

- [ ] RSI(14) default settings
- [ ] MACD(12, 26, 9) default settings — histogram hidden
- [ ] RSI < 30 signal detected → note the signal date
- [ ] No earnings date within 14 calendar days
- [ ] RSI and MACD both pointing up at the same time → entry date
- [ ] Stop loss = lowest low (signal date → entry date) rounded down to whole dollar
- [ ] Take profit alert set at RSI 50

## Entry Checklist (Short)

- [ ] RSI(14) default settings
- [ ] MACD(12, 26, 9) default settings — histogram hidden
- [ ] RSI > 70 signal detected → note the signal date
- [ ] No earnings date within 14 calendar days
- [ ] RSI and MACD both pointing down at the same time → entry date
- [ ] Stop loss = highest high (signal date → entry date) rounded up to whole dollar
- [ ] Take profit alert set at RSI 50

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
