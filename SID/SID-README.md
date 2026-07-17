# SID Stock Swing Strategy

A slow and steady swing trading strategy focused exclusively on **US stocks and ETFs**. Designed for consistent gains over a 12-month horizon using two indicators and a strict set of rules to avoid volatility events.

**Current version:** v2.3.0 — **Telegram Yes/No trade-approval flow.** The v2.2.4 short-approval gate stops a mechanical short on a long-term-bullish asset from auto-firing — but "approve" used to mean manually running `sid-manual-trade.yml`, which creates an **untracked** off-strategy trade with no TP1/TP2 management. v2.3.0 closes that gap. The gate's Telegram alert now carries **[✅ Approve] [❌ Skip]** inline buttons; tapping **Approve** triggers a **Cloudflare Worker** which dispatches a new workflow (`sid-approve-trade.yml`) that enters the trade as a **properly tracked bot position** (full TP1/TP2 management by the normal bot). Approved trades are tracked because both the bot's normal entry path and the approval path build the position record through **one shared `buildEntryPositionRecord()` factory** (so the v2.2.x schema can't drift) and get a broker GTC stop at entry, so `checkPositions`/`maintainV2_2BrokerOrders` manage them identically. Because you approve when price reaches your level (which can be **days** after the mechanical signal), `approve-trade.js` enters at the **current market price**, recomputes the stop from the current setup (reusing the original level if still valid), sizes by **1% risk on the live entry→stop distance**, and logs the proposed-vs-actual entry delta. Security is baked in: **only your Telegram chat-id can approve** (allowlist), the webhook requires a **secret-token header**, the GitHub token is **fine-grained least-privilege** (Actions read+write on the one repo), no secrets live in code or the repo, it fires on **PAPER**, and the workflow **aborts safely** on an unknown/stale/already-actioned approval id (no blind trade). New files: `approve-trade.js`, `approval-worker/` (Worker + setup guide), `.github/workflows/sid-approve-trade.yml`, `pending-approvals-sid.json`. **No signal-logic change** — RSI 30/70, MACD alignment, the RSI-50 TP1 trigger, the earnings blackout and the AUTO-tier universe are all untouched, so the headline backtest numbers are unchanged. See the [Telegram approval flow](#telegram-approval-flow-v230) section and [Version History](#version-history). The prior release, v2.2.6, added the **TP2 cancel-first fix + position cap 3→5 + BITF delist removal.** The *TP2 runner-close* was failing on every run 2026-07-13→16 with the SAME bug v2.2.5 fixed for TP1, just on the other branch: after TP1 banks, the break-even broker stop "holds" the runner shares, so the full close (`DELETE /v2/positions/SYM`) returned `insufficient qty available (available: 0)` — PYPL (12-share runner, BE $41.41) and ADBE (2-share runner, BE $200.79) hit a **legitimate SMA50-touch TP2** (both had rallied favourably up through their 50-day SMA) but the close never landed and `tp2Hit` was never booked, so it retried silently every run. Fix: the TP2 close now applies the same **cancel-first** order of operations — cancel the resting BE stop first (release the runner shares), submit the runner close, **poll that it filled**; on a rejected/unconfirmed close it re-protects the runner with a stop and raises a **loud Telegram alarm** (`tg.alertTp2CloseFailed`) so it can't fail silently. Also this release: **concurrent-position cap raised 3→5** (`SID_MAX_POSITIONS`; 5 × 10% cap = ~50% max deployed), **BITF removed from the universe** (delisted — Alpaca returned HTTP 404 every run; AUTO-80 tier unchanged, universe 113→112 / HUMAN 33→32), and the stale UNH one-shot close workflow deleted. Execution-plumbing + config + universe-hygiene only — **no signal-logic change**, headline backtest numbers unchanged. See [Version History](#version-history). The prior release, v2.2.5, added the **TP1 cancel-first fix + exit-target readout.** The long TP1 partial close had been failing on every run since 2026-06-26 (PYPL, silently for 5 days): the full-size resting GTC stop from entry "held" all shares, so the partial close returned `insufficient qty available (available: 0)` and TP1 profit never banked. Fix: when TP1 fires the bot now **cancels the resting broker stop first** (releasing the shares), submits the partial close, **polls that it filled**, then re-places the break-even stop on the runner only — and if the close doesn't confirm it re-protects the full remaining qty and raises a **loud Telegram alarm** so a multi-day silent failure can't recur. The short-side twin is fixed too (while TP1 is pending the resting stop reserves only the runner half so the resting TP1 limit can place; the TP1 half is now an OCO). The dashboard now shows the **dynamic exit targets on every open-position card** — TP1 (RSI-50 status), TP2 (daily SMA50/SMA200 runner exits) and stop/BE. Execution-plumbing + observability only — **no signal-logic change**, headline backtest numbers unchanged. See [Version History](#version-history). The prior release, v2.2.4, added a **short approval gate.** A mechanical SHORT on a long-term-bullish asset (`price > 200-day SMA AND 50-day SMA > 200-day SMA`) no longer auto-fires. Instead the bot logs it and sends a Telegram alert so it can be approved and fired manually into the right level (e.g. a supply zone) via the manual one-shot flow (`sid-manual-trade.yml`). Motivated by UNH auto-shorting at $416.52 on 2026-06-30, far below its 439-440 supply zone — v2.2.2's MANUAL-WATCH flag only flagged that post-entry; v2.2.4 gates it pre-entry. **This is a LIVE execution-discipline overlay, not a signal-logic change** — RSI 30/70, MACD alignment, the RSI-50 exit, the 14-day earnings blackout and the AUTO-tier universe are all untouched. The v2.2.3 backtest (280 trades / 73.9% WR / +$31,426) INCLUDES these bullish-asset shorts firing mechanically, so **live results deliberately diverge from the pure backtest** on that subset; the headline backtest numbers are unchanged for exactly that reason. Longs and non-bullish-asset shorts are unaffected and still auto-fire. Toggle: `SID_SHORT_APPROVAL_GATE=false` reverts to fully-mechanical bullish-asset shorts. See [Version History](#version-history). The prior release, v2.2.3, was an **entry overhaul.** The live bot's entry had drifted loose from the validated backtest (no arm timeout, no RSI(3) confirmation, no weekly-SMA gate — it was taking stale signals like a UNH/ADBE entry fired days after the oversold signal). v2.2.3 restores all three gates and adds a **shorts-only 5-day re-arm cooldown** (longs re-arm freely to catch bullish V-shaped recoveries; shorts wait out the recovery to avoid low-quality counter-trend repeats). 5-year backtest: **280 trades, 73.9% WR, PF 3.19, +$31,426** — Pareto-dominates the prior config (+$2,091 / +0.50 PF / +2.9pp WR), with short win rate cleaned from 62.9% → 72.3%. Exit logic (v2.2.1 hybrid TP1/TP2 + broker GTC stops) and the v2.2.2 MANUAL-WATCH flag are unchanged. See [Version History](#version-history). Longs use v2.1 close-based TP1 (lets the bullish equity drift book a bigger partial); shorts use v2.2 intraday-touch TP1 with a resting GTC limit at the RSI-50 target (locks in the partial before round-trips against the drift can take it back). Both sides get a broker-enforced GTC stop on Alpaca from the moment of entry. 5-year backtest on the 80-ticker AUTO tier ($200 fixed risk): **71.3% win rate, PF 2.72, +$29,528 over 5y.** Pareto-dominates the v2.1 baseline on every metric (+1.7pp WR / +$211 PnL / same trade count). Sizing compounds off an internal ledger so the bot's risk math doesn't follow Alpaca's $100k paper equity. See [Version History](#version-history).

**Bot file:** `bot-sid.js`
**PineScripts:**
- `pine/sid-strategy.pine` — main strategy script (backtest on TradingView, 15-min chart)
- `pine/sid-rsi-signals.pine` — companion indicator: daily RSI on its own pane with 30/70 lines + signal/entry arrows
- `pine/sid-macd-signals.pine` — companion indicator: daily MACD on its own pane with signal/entry arrows

**Trade log:** `trades-sid.csv`
**Position tracker:** `open-positions-sid.json` / `closed-positions-sid.json`

---

## 📊 Backtest deliverable: SID Strategy Back Testing.xlsx

A formatted Excel workbook with **every backtested trade** (355 trades over 5 years on the 71-ticker universe) — built for Trading Academy lesson submissions and any future strategy reviews.

**Where to find it:**
- **`C:\Users\balli\Downloads\SID Strategy Back Testing.xlsx`** (auto-copied here for easy access)
- `SID/SID Strategy Back Testing.xlsx` (repo copy — same file)

**What it contains:**
1. **All Trades** sheet — 355 rows, AutoFilter on every column, SUBTOTAL formulas that respond to filters live, win/loss + long/short colour coding
2. **Per-Ticker Summary** sheet — 70 tickers ranked by P&L, WR coloured by tier (≥60% green, <40% red)
3. **Strategy Rules** sheet — full v1.5 / v1.6 parameter reference

**Top-line numbers** (Sheet 1 subtitle): 60.8% WR / +$15,572 P&L / 355 trades / 5-year window / $200 risk per trade

**Rebuilding when rules change** (e.g. after shipping v1.7 someday):

```bash
cd SID
python scripts/export-all-trades.py    # regenerate trades CSV
python scripts/build-backtest-xlsx.py  # rebuild Excel from CSV
```

Output: `SID/all-trades.csv` (raw) and `SID/SID Strategy Back Testing.xlsx` (formatted). Copy the xlsx to `~/Downloads/` afterwards if you want easy access.

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
| Max open trades | 5 at any one time (default; `SID_MAX_POSITIONS`-overridable) |
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

## Telegram approval flow (v2.3.0)

Bullish-asset shorts (a mechanical SHORT on a name where `price > 200-day SMA AND 50-day SMA > 200-day SMA`) don't auto-fire — the bot asks for your approval so you can enter at the right level (e.g. into a supply zone) instead of mechanically below it. As of **v2.3.0** that approval is a **one-tap Telegram button** that opens a **fully tracked bot position**.

**End-to-end:**

```
Bot detects bullish-asset short
  → queues it to pending-approvals-sid.json  (id = symbol-signalDate-side)
  → sends a Telegram alert with [✅ Approve] [❌ Skip] buttons
        │
        ├─ Skip    → message edits to "Skipped", nothing fires
        └─ Approve → Cloudflare Worker (validates it's YOU + a real webhook)
                       → dispatches sid-approve-trade.yml with the approval id
                         → approve-trade.js enters the trade on Alpaca PAPER as a
                           TRACKED position (full TP1/TP2 management by the bot)
```

**Why the approved trade is *tracked* (not a manual one-shot):** both the bot's normal entry path and the approval path build the position record through **one shared `buildEntryPositionRecord()` factory**, and the approved position gets a broker GTC stop at entry — so `checkPositions` / `maintainV2_2BrokerOrders` manage its TP1 (RSI-50 partial + move-to-BE) and TP2 (SMA50 / SMA200 / BE / 30-day timeout) exactly like an auto-fired position. The old flow (`sid-manual-trade.yml`) created an untracked off-strategy trade with none of that.

**Approve days later, at a different price:** you tap Approve when price reaches your level, which can be days after the signal. `approve-trade.js` enters at the **current market fill price**, recomputes the stop (reusing the original level if still valid, else a buffer beyond current price), sizes by **1% risk on the live entry→stop distance**, and logs the proposed-vs-actual delta.

**Security:** only your Telegram chat-id can approve (allowlist); the webhook requires a secret-token header; the GitHub token is fine-grained least-privilege (Actions read+write on only this repo); no secrets in code or the repo; it fires on **PAPER**; and the workflow aborts safely on an unknown/stale/already-actioned id (no blind trade).

**Setup:** one-time, self-service — see [`approval-worker/README.md`](approval-worker/README.md) (create a free Cloudflare account, deploy the Worker with `wrangler`, set the secrets, register the Telegram webhook). Toggle off by reverting the webhook or the alert buttons — the bot keeps working, alerts just go back to text-only with the manual runbook.

---

## Version History

| Version | Date | Change |
|---------|------|--------|
| v1.0 | Apr 2026 | Initial implementation — RSI(14) + MACD(12,26,9), daily chart, US stocks/ETFs |
| v1.1 | 10 May 2026 | Two-stage entry: daily signal arms the trade; entry now requires a 15-min intraday candle closing in trade direction during the next US session. Added 3-day hard timeout on armed signals. Goal: avoid fake reversals where RSI dips into oversold but the move continues lower the next day. |
| v1.2 | 11 May 2026 | **Instructor-aligned fix.** v1.1 incorrectly required RSI to still be in the extreme zone on the entry day; the instructor's actual rule treats the signal date as STICKY and the entry day is a later day where RSI direction + MACD direction both align with the trade. v1.2 fixes this: arm on RSI hitting extreme alone, then enter when RSI+MACD direction-align (within the 3-day timeout). Discovered via Project D analysis comparing 10 instructor-marked trades vs the bot. Caught the AAPL, AMD, GM trades that v1.1 had missed. The 15-min intraday confirmation from v1.1 is preserved as an optional input (default ON). |
| v1.3 | 11 May 2026 | **RSI overbought 70 → 75** to cut premature shorts on bullish-trend stocks. **RSI(3) rebound-zone confirmation** added: 3-day RSI must also be in extreme zone on the signal day. Backtest showed +$2,143 improvement vs RSI 70 baseline. Both filters are minor confirmation tweaks — strictly additive, can be toggled off in inputs to revert to v1.2 behavior. |
| v1.4 | 11 May 2026 | **Weekly trend filter.** Longs allowed only when weekly 50-SMA > 200-SMA (uptrend); shorts only when 50-SMA < 200-SMA (downtrend). Single biggest quality uplift of any change tested: 12-month backtest jumps from 30% WR / −$249 net to **77% WR / +$3,584 net** ($10k account, 2% risk). Trade count drops 80% (124 → 26) but the kept trades are dramatically higher quality. Combines with v1.3 filters cumulatively. All filters remain toggleable. *(Locked at git tag `sid-v1.4-baseline` for one-command revert.)* |
| v1.5 | 12 May 2026 | **Earnings rule clarified — pre-only blackout.** Old code blocked 14 days *before* AND *after* earnings (used `Math.abs`). User-requested correction: block 14 days BEFORE earnings only — trading is permitted the day after earnings (the post-announcement gap risk is gone). Pine v1.4 was already correct (uses forward-only `earnings.future_time`); only `bot-sid.js` needed the fix. **5-year backtest validation** (statistically sound, 167 trades): WR 62.3% (vs 60.9% baseline), PF 1.98 (vs 1.85), P&L +$11,809 (vs $12,893 baseline). Earnings filter removes 35 marginal trades that averaged half the strategy's normal edge — better risk profile for a small P&L cost. *Important calibration: the v1.4 12-month "77% WR" was statistically noisy on 26 trades. The 5-year picture shows the realistic edge is ~60% WR with PF ~1.9.* |
| v1.6 | 15 May 2026 | **PPI blackout + REFINED 47 watchlist.** Two changes shipping together: (1) added a 14-day pre-PPI release blackout (same pre-only logic as earnings). (2) Replaced the previous watchlist with REFINED 47 — derived from the community 61-ticker FAVOURITES set minus 14 net-loser/marginal tickers (HUM, KO, COIN, ROKU, CSCO, LUV, NEM, LVS, PG, AAL, SLB, SMH, HUT, EXPE). **5-year validation backtest** on REFINED 47: WR **74.8%** (first time the strategy cleared the community 65-85% target band), PF **3.20**, P&L **+$12,574** over 5y, 119 trades (~24/yr). Per-trade quality $105.66 — 2× the v1.5 number. **Important negative findings also documented**: FOMC/CPI 14-day blackouts were tested in v1.7 validation and found to actively HURT (dropped WR from 60% to 48.5%), MACD-cross trigger added no edge (same WR but 85% fewer trades), RSI 35/40 entry cap was too restrictive. None of those shipped. v1.5 locked at git tag `sid-v1.5-baseline`. |
| v1.7 | 15 May 2026 | **VIX ≥ 30 gate + tier1 ticker expansion.** User spotted a loss cluster in Sept 2022 (FOMC + UK pension crisis) where 9 trades stopped out for −$1,774 over two weeks. Investigation showed VIX was ≥ 30 during the entire window — the market was pricing in extreme fear despite a deceptive +2% relief rally on Sept 28 when SID signals fired. **New rule**: when VIX closes ≥ 30, bot blocks new ARMing for the next day (open positions continue with their stops). Per-run check (bot wakes once daily, rechecks fresh each morning). **Universe also expanded** with 32 high-volume mega-caps and sector ETFs (NVDA, ADBE, CRM, AVGO, AMAT, LRCX, JNJ, PFE, MRK, ABT, ABBV, LLY, UNH, BLK, AXP, SCHW, NKE, SBUX, MDLZ, XOM, CVX, HON, RTX, LMT, GE, DE, ORCL, NOW, GLD, IBB, EFA, EEM, IYR — no oil/bonds per user direction). **5-year backtest on expanded universe**: 524 raw trades, 57.8% WR / +$19,493 (no gate) vs 425 trades, 58.6% WR / +$17,616 (VIX gate active). Gate trades off ~$375/yr of P&L for cleaner risk profile (blocked trades had 54.5% WR vs 58.6% — slightly noisier setups). v1.6 locked at git tag `sid-v1.6-baseline`. |
| v2.0 | 17 May 2026 | **Weekly trend + earnings + no-go-zone hardening (the "v2 method").** Tightened the V1.7 entry stack into the form Alan's instructor uses: (1) RSI(14) extreme zone arms the trade (≤30 long, ≥70 short); (2) RSI(3) extreme-zone confirmation required on the signal day; (3) RSI no-go zone at entry rejects late entries (RSI must be < 45 for longs, > 55 for shorts — i.e. with room to run before hitting the TP1 level); (4) weekly RSI direction OR weekly MACD direction must match the trade; (5) 14-day pre-earnings blackout (PPI dropped — the v1.6 PPI gate didn't replicate); (6) exit is single full-position close at RSI 50 daily close. 5y backtest on the AUTO tier 80: 296 trades, **70.3% WR, PF 2.57, +$26,750** ($200 fixed risk). 70% WR was the threshold Alan's instructor lessons cited as the strategy's "real" edge — v2.0 was the first version to clear it cleanly across a 5-year window. |
| v2.1 | 18 May 2026 | **Dynamic TP1 + TP2 partial exits.** Replaced v2.0's single full close at RSI 50 with a two-stage exit per the instructor's S3_P1 / S3_P2 transcripts. TP1: when RSI(14) hits 50 (long ≥50, short ≤50) on daily close, close 50% of the position and move the remaining 50%'s stop to break-even. TP2 fires the runner on whichever happens first: (a) BE stop hit; (b) price touches 50-day SMA; (c) price touches 200-day SMA; (d) 30-trading-day timeout. Schema migrated to track `tp1_hit`, `tp1_date/price/shares/pnl/rsi`, `shares_total`, `shares_remaining`, `orig_stop`; closed records add `tp2_*` + `total_pnl` + `exit_strategy`. Legacy v2.0 positions auto-upgrade on first read. `SID_DYNAMIC_TP=false` reverts to v2.0 behaviour without a code change. 5y backtest on AUTO tier 80: 302 trades, **69.5% WR, PF 2.55, +$28,046** — beats v2.0 baseline by +$1,296 with essentially same trade count. TP2 uplift on winners = +$24,733 (+115%) vs the v2.0 capture. |
| v2.2 | 9 Jun 2026 | **Intraday-touch TP1 (both sides) + broker-enforced GTC stops.** Replaced v2.1's "scan daily candle, close at next open" simulation with real Alpaca GTC orders placed at entry. TP1 trigger semantics also changed: instead of waiting for RSI(14) ≥ 50 on the daily *close*, the bot solves Wilder-RSI inversion for the price at which RSI 50 will be hit and places a resting GTC limit at that exact level (`SID/rsi-target-price.js`). The bar's intraday high/low touching the level fires TP1 immediately — no more round-trips into the original stop where price wicks through 50 and reverses before close. New helpers: `isV2_2Position`, `maintainV2_2BrokerOrders`, `findOpenOrder`. Position schema adds `brokerStopOrderId` + `clientOrderIdPrefix`. Sizing changed to compound off an internal `sid-account.json` ledger rather than Alpaca paper equity. 5y backtest on AUTO tier 80: 304 trades, **74.7% WR (+5.1pp), PF 2.80 (+0.18), +$27,365 (-6.7%)** — WR/PF improve, total PnL marginally worse because intraday-touch fills lock in *exactly* at the RSI-50 level whereas close-based filled past it. Superseded by v2.2.1 the same day. |
| v2.3.0 | 17 Jul 2026 | **Telegram Yes/No trade-approval flow (new capability — no signal-logic change).** Since v2.2.4 a mechanical SHORT on a long-term-bullish asset is gated for approval, but "approve" meant manually running `sid-manual-trade.yml`, which creates an **untracked** off-strategy trade (no TP1/TP2 management). v2.3.0 closes that gap: the gate's Telegram alert now carries **[✅ Approve] [❌ Skip]** inline buttons. Tapping **Approve** triggers a **Cloudflare Worker** (chat-id allowlist + webhook-secret header + least-privilege GitHub token) that dispatches a new workflow (`.github/workflows/sid-approve-trade.yml`), which runs `approve-trade.js` to enter the trade as a **properly tracked bot position** — full TP1 (RSI-50 partial) and TP2 (SMA50/SMA200/BE/timeout) management by the normal bot. **How it stays tracked:** both entry paths (the bot's `run()` and the approval path) now build the open-positions record through **one shared `buildEntryPositionRecord()` factory**, so the v2.2.x schema (`shares_total`/`shares_remaining`/`orig_stop`/`tp1_hit`/`brokerStopOrderId`/`clientOrderIdPrefix`/`strategy`) can't drift, and the approved position gets a broker GTC stop at entry (`isV2_2Position()` → true → managed by `maintainV2_2BrokerOrders`). **Approve-days-later handling:** you approve when price reaches your level (e.g. UNH into 439–440), which can be days after the mechanical signal — so `approve-trade.js` enters at the **current market fill price**, recomputes the stop from the current setup (reusing the original level if still valid for the direction, else a buffer beyond the current price), sizes by **1% risk on the live entry→stop distance**, and logs the proposed-vs-actual entry delta (flagging >5% moves). **Security:** only your Telegram chat-id can approve (allowlist); the webhook requires the `X-Telegram-Bot-Api-Secret-Token` header; the GitHub token is fine-grained least-privilege (Actions read+write on **only** the BotTrading repo); no secrets in code or the repo (`wrangler secret put` + repo secrets); fires on **PAPER** (`SID_TRADING_MODE`); the workflow aborts safely if the `approval_id` is unknown, already actioned, or expired (no blind trade). New pending queue: `pending-approvals-sid.json` (deterministic id `symbol-signalDate-side`, de-duped, pruned after `SID_PENDING_TTL_DAYS`=5). New files: `approve-trade.js`, `approval-worker/` (`worker.js` + `wrangler.toml` + setup `README.md`), `sid-approve-trade.yml`. **NO canon rule change** — RSI 30/70, RSI+MACD alignment, the RSI-50 TP1 trigger, the 14-day earnings blackout and the AUTO-tier 80-ticker universe are all untouched, so the headline backtest numbers are unchanged. |
| v2.2.6 | 17 Jul 2026 | **TP2 cancel-first / runner-held-shares fix + cap 3→5 + BITF delist removal.** Exact twin of the v2.2.5 TP1 bug, on the TP2 branch. After TP1 banks, the v2.2 broker design leaves a full-*runner* break-even GTC stop resting (`pos.brokerStopOrderId`), and Alpaca "holds" the runner shares against it — so when `checkPositions` Branch B fired a **legitimate TP2** and called `executor.closePosition()` (`DELETE /v2/positions/SYM`), it returned `insufficient qty available (requested: N, available: 0)` on **every run**. The old catch just logged `tp2_close_fail` and re-queued the position → the same silent retry loop the TP1 fix cured. PYPL (12-share runner, BE $41.41) failed 4× and ADBE (2-share runner, BE $200.79) 2× over 2026-07-13→16. **The TP2 trigger itself was correct, not a false positive:** both runners had rallied *favourably up* through their 50-day SMA (PYPL close $56.73 vs SMA50 $44.51 & SMA200 $52.90; ADBE close $235.31 vs SMA50 $230.94) — the SMA50-touch exit fired legitimately and they were stuck retrying only because the *close* failed. **Fix (mirrors the v2.2.5 TP1 order of operations):** (1) cancel the resting BE stop first (+ any lingering `-stop`) and wait for zero open orders to release the runner shares; (2) submit the runner close and **poll that it fills**; (3) TP2 fully closes the runner so no re-stop on success — but on a rejected/unconfirmed close the runner is re-protected with a stop, `tp2Hit` is **not** booked (retry next run), and a **loud `tg.alertTp2CloseFailed()` Telegram alarm** fires. `sid-log` `tp2_close_fail` now carries `reason` + `reprotected`. **Also:** concurrent-position cap `CONFIG.maxOpenPositions` default **3→5** (`SID_MAX_POSITIONS`; 5 × 10% cap = ~50% max deployed, and 1%-risk sizing is usually well under the cap so real deployment is lower); **BITF removed** from `watchlist-sid.json` (master + HUMAN tier) and `asset-classification.json` — delisted, returned Alpaca HTTP 404 every run and was silently skipped (AUTO-80 tier unchanged since BITF was HUMAN/LOG-only; universe 113→112, HUMAN 33→32); and the stale `sid-oneshot-close-unh-2026-07-01.yml` workflow deleted (the UNH short it targeted stopped out on its broker stop 2026-07-01). **NO canon rule change** — RSI 30/70, RSI+MACD alignment, the RSI-50 TP1 trigger, the 14-day earnings blackout and the AUTO-tier 80-ticker universe are all untouched, so the headline backtest numbers are unchanged. |
| v2.2.5 | 1 Jul 2026 | **TP1 cancel-first / held-shares fix + exit-target dashboard readout.** LIVE BUG: the long TP1 partial close had been failing on every run since 2026-06-26 — PYPL (long 23sh @ $41.395) had daily RSI(14) ≥ 50 the whole time so TP1 *should* have banked, but the close returned `insufficient qty available for order (requested: 11, available: 0)` for **five straight days, silently**. Root cause: the v2.2 broker design leaves a full-size resting GTC stop from entry, and Alpaca "holds" every share against it, so the `DELETE /v2/positions/SYM?qty=N` partial close can never claim shares (the live analogue of the documented Alpaca held-shares/OCO trap). **Fix (correct order of operations):** when TP1 fires — (1) cancel the resting broker stop first to release the shares and wait for them to free; (2) submit the partial close and **poll that it actually fills**; (3) only then re-place the break-even stop on the *runner* (remaining shares) at the direction-aware BE price. If the partial fill isn't confirmed, the full remaining qty is re-protected with a stop and a **loud `tg.alertTp1CloseFailed()` Telegram alarm** fires so a multi-day silent failure can't recur. The short-side twin was fixed too (in `maintainV2_2BrokerOrders`): while TP1 is pending the resting stop reserves only the runner half so the resting TP1 limit can actually place — it used to fail the same silent way — and the TP1 half is now an OCO (limit + stop) so both legs are protected. For PYPL: the next run at RSI ≥ 50 cleanly books the **11-share TP1** and sets a **$41.41 BE stop on the remaining 12**. New executor helpers: `cancelOrderById` / `waitForNoOpenOrders` / `pollOrderFill` / `placeStop`. **Also (dashboard, Alan-requested):** each open-position card now shows the dynamic **exit targets** — TP1 (current daily RSI(14) vs 50 + tp1_hit; for shorts the RSI-50 target price), TP2 (daily SMA50/SMA200 runner exits), and the current stop/BE (`scan-sid.js` now additively emits `dailySma50`/`dailySma200`/`rsi50Target`). Execution-plumbing + observability only — **no signal-logic change**; RSI 30/70, MACD alignment, the RSI-50 trigger, the earnings blackout and the AUTO-tier universe are all untouched, so the headline backtest numbers are unchanged. |
| v2.2.4 | 1 Jul 2026 | **Short approval gate (live execution-discipline overlay — no signal-logic change).** v2.2.2's MANUAL-WATCH flag only *flagged* bullish-asset shorts for post-TP1 runner review; it did not block entry — so on 2026-06-30 UNH auto-shorted at $416.52, far below its 439-440 supply zone. v2.2.4 turns that post-entry flag into a **pre-entry approval gate**: a mechanical SHORT on a long-term-bullish asset (`price > 200-day SMA AND 50-day SMA > 200-day SMA`, via `longTermBullish()`) is no longer auto-executed. The bot logs a `short_approval_required` entry to `sid-log.json` and sends a `tg.alertShortApprovalNeeded()` Telegram alert (symbol, signal date, current price, proposed entry + stop, would-be size); Alan approves by firing it himself at the right level via the existing manual one-shot flow (`manual-trade.js` / `sid-manual-trade.yml`). No auto-fire, no reply-to-approve infra. **NO canon rule changed** — RSI 30/70, RSI+MACD alignment, the RSI-50 TP1 trigger, the 14-day earnings blackout and the AUTO-tier 80-ticker universe are all untouched. The v2.2.3 backtest (280 trades / 73.9% WR / PF 3.19 / +$31,426) **includes these bullish-asset shorts firing mechanically**, so live results deliberately diverge from the pure backtest on that subset — the headline backtest numbers are unchanged for exactly that reason. Longs and non-bullish-asset shorts are unaffected and still auto-fire. Toggle: `SID_SHORT_APPROVAL_GATE=false` reverts to fully-mechanical bullish-asset shorts. New: `CONFIG.shortApprovalGate` in `bot-sid.js`, `alertShortApprovalNeeded()` in `telegram-alerts.js`. The v2.2.1 Pine visualiser already distinguishes green=mechanical / amber=manual-watch; that amber flag now means "approval-required, not auto-fired." |
| v2.2.3 | 28 Jun 2026 | **Entry overhaul — realign the live bot to the validated backtest + shorts-only re-arm cooldown.** The live `detectEntrySignal` had drifted to a loose "episode" model with no arm timeout, no RSI(3) confirmation, and no weekly-SMA arm gate — so it was firing stale, low-quality signals the validated backtest never measured (caught via a live ADBE long entered ~6 trading days after its oversold signal, after price had slid $233→$202). A bot-parity backtest quantified the drift: the loose live model ran at **66.1% WR / PF 1.91** vs the validated **71.0% / 2.69**. The fix restores all three entry gates and adds an Alan refinement found by a cooldown sweep — a **shorts-only 5-day re-arm cooldown** (longs re-arm freely so bullish V-shaped recoveries aren't missed; shorts wait out the recovery so they don't re-fire low-quality counter-trend repeats). The short cooldown has a clean optimum at 5 days (short WR 62.9%→72.3%; falls off at 3 and 7). **Final config:** 3-day arm timeout + RSI(3) + weekly SMA50/200 gate + free-rearm longs / shorts-only 5-day cooldown → **280 trades, 73.9% WR, PF 3.19, +$31,426** (tier1, 5y, $200 fixed) — Pareto-dominates v2.2.1 (+$2,091 / +0.50 PF / +2.9pp WR). `detectEntrySignal` was rewritten as a faithful bar-by-bar replay of the validated arm machine (`SID/backtest-sid-bot-parity.py`); the scan data fetch was bumped 2y→5y so the weekly-SMA gate (needs ~200 weekly bars) actually applies live. Verified: reproduces the backtest entries exactly (GOOG, AAPL) and the stale ADBE entry no longer fires. Investigation: `SID/strategy-test-vault/bot-parity-experiment/`. |
| v2.2.2 | 13 Jun 2026 | **MANUAL-WATCH flag (monitoring aid — no trade-logic change).** The bot now flags any open SHORT on a long-term-bullish asset (`price > 200-day SMA AND 50-day SMA > 200-day SMA`) for manual support/resistance review. Motivation: on long-term-bullish names the mechanical TP2 has a blind spot — RSI rarely reaches daily oversold before the bounce, and the SMA exit can round-trip to break-even (30% of all runners do). Proven by the GOOG 2026-06 short (runner RSI bottomed at 38.4, never near oversold; manual exit at $347.83 beat the SMA exit ~$355 and "let it run" $358) and the TP2-RSI experiment: replacing the SMA exit with RSI-extreme *doubled* round-trips to BE (65→123) and `rsi_oversold` fired only 6 times across 89 shorts — rejected (`SID/strategy-test-vault/tp2-rsi-experiment/`). The flag surfaces three ways: a pulsing `👁 WATCH · S/R` badge on the dashboard position card, a `⚠ MANUAL-WATCH` line in the bot log, and a consolidated Telegram reminder each run. TP1 still banks mechanically; only the runner half needs the eye. Trade logic + backtest numbers identical to v2.2.1. Helper: `longTermBullish()` in `bot-sid.js`. *(Also fixed: `sid-dashboard.js` was the hardcoded source of the dashboard's version markers — it had been stuck at v2.1, silently reverting hand-edits to `index.html` on every rebuild. Now reads v2.2.2 / 71.3% WR / +$29,528.)* |
| v2.2.1 | 9 Jun 2026 | **HYBRID — close-based longs / intraday-touch shorts.** Per-side decomposition of v2.2 revealed an asymmetry the original brief missed: shorts strictly benefit from intraday-touch (+6.0pp WR AND +$377 PnL because the bullish drift of US equities punishes shorts that round-trip through 50), but longs lose $2.3k of PnL under v2.2 because the bullish drift WORKS FOR longs — letting price *close* past 50 books a bigger TP1 partial than locking exactly at the level. V2.2.1 routes by side: longs revert to v2.1 close-based TP1, shorts keep v2.2 intraday-touch with a resting GTC limit at the RSI-50 target. Both sides keep the broker GTC stop. Pine sister script: `SID/pine/sid-strategy-v2.2.1-hybrid.pine`. Backtest: 303 trades, **71.3% WR, PF 2.72, +$29,528** — Pareto-dominates v2.1 on every metric (+1.7pp WR / +0.10 PF / +$211 PnL / same trade count). Recovers $2,163 of the PnL slip pure v2.2 left on the table. Long PnL identical to v2.1's $26,345 (proves the routing is correct). Vault: `SID/strategy-test-vault/v2.2.1-hybrid-shorts-intraday/`. |

---

## Files

| File | Purpose |
|------|---------|
| `bot-sid.js` | Main bot code |
| `trades-sid.csv` | Trade log (entry, stop, target, exit) |
| `open-positions-sid.json` | Active positions being monitored |
| `closed-positions-sid.json` | Closed positions with realized P&L |
| `pending-approvals-sid.json` | v2.3.0 — queue of gated bullish-asset shorts awaiting your Telegram Approve/Skip |
| `approve-trade.js` | v2.3.0 — enters an Approved short as a **tracked** bot position (full TP1/TP2); reuses the bot's shared entry-record factory + sizing |
| `approval-worker/` | v2.3.0 — Cloudflare Worker (Telegram webhook receiver) + `wrangler.toml` + setup `README.md`. Validates chat-id + webhook secret, then dispatches `sid-approve-trade.yml` |
| `SID-README.md` | This file |
| `SID-DEPLOY-PROMPT.md` | **Deploy your own (fresh)** — paste into a fresh Claude session for a step-by-step, pause-after-each-step first-run setup on your own fork (fork + clean-slate state + disable non-SID workflows + `upstream` remote + Alpaca PAPER + GitHub Actions + dashboard) |
| `SID-UPDATE-PROMPT.md` | **Update to the latest revision** — paste into a fresh Claude session to pull a published SID revision (code + release notes only) from the `upstream` remote into your fork WITHOUT touching your trade state, account ledger, or secrets |
| `research/SID/` | Original strategy source images |
