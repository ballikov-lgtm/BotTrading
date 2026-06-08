# HANDOFF → Hub: Maven operational layer (strategist monitor + research lens + BTC-RS watchlist)

**From:** Maven backtest session (Atlas/Claude Code) · **For:** Hub to route to the **strategist** and **research-agent** · **Date:** 2026-06-08

This is the **operational / monitoring layer** for the Maven strategy and the wider strategy fleet. It is deliberately *not* being built inside the Maven strategy session (that session owns the strategy logic + bot). Hub: please route the three jobs below to the right specialists and own the scheduling glue. Alan flagged that doing this inside the Maven session would derail it — correct call.

---

## 0. Context — what Maven is now (so the monitor knows what it's watching)

- **Maven = 4h, longs-only, trend-pullback crypto strategy on Bitget.** Validated 2026-06-08.
- **Entry logic (the winning config):** 4h 20×200 SMA **cross gate** (long only when 20>200), **20/200 gap ≥3%** (skip the transition zone), **RSI-35 floor** pullback entry (+ MACD turning + 20-SMA reclaim), **MTF 200-slope gate** (4h *and* daily 200 both rising). Stop = wick/2% cap; TP1 at RSI 50 → break-even; TP2 on the 20 SMA; 20-bar time stop.
- **Live params (Alan):** $1,000 compounding account · **2% risk/trade** · **max 3 concurrent** positions · **3× leverage cap** (Bitget). At ~2% stops each position ≈1× account, so 3 concurrent = 3× — the bot must hard-cap total leverage at 3× and size down rather than breach.
- **Backtest (portfolio sim, 2023–2026, curated watchlist):** +60% on $1,000, max drawdown 4.6%, WR ~70%, PF ~4.4. Macro-event (FOMC/CPI/PPI) blackout was TESTED and REJECTED — it deletes Maven's best trades; do not add it.
- **Current watchlist (10):** ETH, SOL, XRP, SUI, VIRTUAL, HYPE, APT, FET, SEI, TRX. Curated by **coin character (BTC-outperformers / strong trenders)**, not backtest-mining. LINK was scrapped (0/7). Memecoins (WIF/PEPE) don't suit it.
- **Engine + memory:** `Trading Setup/maven/backtest-maven.py`, `Trading Setup/maven/MEMORY.md` (full session journal). Pine scripts in `maven/pine/`.
- **Status:** NOT yet live. Next strategy-side steps (owned by the Maven session): rewrite `MAVEN.md` spec, build the Maven bot, then 3-week observation → live paper → live.

---

## JOB 1 — Strategist agent: daily fleet health monitor (cross-strategy)

**Owner:** strategist agent. **Cadence:** every day **19:00 UK time** (handle BST/GMT). **Scope:** all paper/live strategies (SID, VWAP, Maven once live — and any others).

**Each run must:**
1. **Walk the trades** taken since the last run on each paper/live strategy.
2. **Token/coin performance** — flag any coin that's bleeding or under-performing its strategy's expectation.
3. **Trade execution health** — did orders fill as expected? any rejects/slippage/errors in the bot logs?
4. **Open-trade safety** — **flag any open trade that should already have been stopped/closed** (stuck runners, blown time-stops, BE-stops that didn't fire — this exact class of bug bit SID; see `SID/CLAUDE.md` stuck-position pitfalls).
5. **Dashboard freshness** — confirm each strategy's dashboard updated; flag stale ones.
6. **Token scrap/replace suggestions** — surface coins that look like they should be dropped (à la LINK for Maven) and, where possible, candidate replacements (ties into Jobs 2 & 3).

**Reporting:** push a concise summary to **Alan via Telegram** (already wired). Only escalate **strategies that need attention** — don't spam an all-clear novel; a one-line "all green" is fine, detail only the exceptions.

**Run-when-available requirement (Alan):** the monitor must run even if Alan's PC is off. **→ Implement as a cloud GitHub Actions cron, NOT a local scheduler** (project rule: trade automation never depends on the local machine being on — see root `CLAUDE.md` "Ad-hoc cloud-fired trades — use GHA cron, never local schedulers"). A cloud cron at 19:00 UK satisfies "run as soon as available" inherently — it fires regardless of the PC. (If a run is genuinely missed, the next run should cover the gap since the last successful run, so nothing is skipped.)

---

## JOB 2 — Research agent: Maven news lens (repurpose the CATS lens)

**Owner:** research-agent. **Action:** the CATS news-lens is effectively free now (**CATS unlikely to proceed**) — **repoint its reporting at Maven.**

**What it does:** scan for **materially bullish catalysts on altcoins** — major partnerships, big-name integrations, major exchange listings, mainnet/upgrade events — and surface the coin as a **Maven watchlist candidate** ("watch for potential trades"). Output feeds Alan (and Job 1's scrap/replace suggestions).

**Note:** this is a *candidate-flagging* lens, not an auto-add. A flagged coin still has to pass Maven's own entry logic and the BTC-RS criterion (Job 3) before it's traded.

---

## JOB 3 — BTC relative-strength watchlist signal (Maven criterion + research data)

This is the clever bit Alan wants, and it splits cleanly:

- **The CRITERION is Maven's (strategy logic):** a coin earns/keeps a Maven watchlist slot when it is **outperforming BTC *on the trend*** — i.e. the ALT/BTC ratio (not ALT/USDT) is trending up. Maven is a trend-pullback system, so it wants the relative-strength *leaders* (the coins whose curve is rising *against* BTC, like HYPE/TRX). *(Exact threshold/lookback to be finalised by the Maven session — e.g. ALT/BTC above its own rising 4h/1d MA. Provisional: rank the universe by ALT/BTC trend slope, keep the top N for the active watchlist.)*
- **The DATA-GATHERING is research-agent's:** pull the BTC-denominated relative performance for the alt universe. Two viable sources:
  1. **Direct compute** — fetch ALT/BTC price series (or divide ALT/USDT by BTC/USDT from Bitget klines, already available in the Maven engine) and measure the ratio's trend. Most robust, no scraping.
  2. **Crypto-bubbles / banter-bubbles** (cryptobubbles.net + the Banter "bubbles") — **both let you switch the denominator to BTC and offer a LIST/TABLE view** (not just the floating bubbles), which gives a clean BTC-relative performance % per coin at a glance. The table view is far easier to scrape than the animated bubbles. Good low-effort cross-check / discovery source for "which alts are leading BTC right now."

**Output:** a ranked "alts vs BTC" leaderboard the strategist can use to (a) confirm current watchlist names are still leading, and (b) suggest scrap/replace when a coin loses relative strength or a stronger one appears.

**Open question for Hub/Maven:** does this BTC-RS check live in a **Maven-owned lens** (since it's strategy-specific selection logic) or a **shared research-agent lens** the strategist calls? Recommend: research-agent builds the data lens (reusable), Maven owns the *criterion/threshold* config it applies.

---

## Ownership summary

| Piece | Owner |
|---|---|
| Daily 19:00-UK fleet monitor + Telegram alerts + GHA cron | **strategist** |
| Open-trade/stop safety checks, dashboard-freshness checks | **strategist** |
| Maven news-catalyst lens (repurposed from CATS) | **research-agent** |
| BTC-relative-strength data lens (compute + crypto-bubbles table) | **research-agent** |
| The BTC-RS *criterion/threshold* + the watchlist itself | **Maven** (strategy logic) |
| Scheduling glue / routing | **Hub** |

## Decisions Hub should confirm with Alan
1. Does a **strategist** agent already exist, or does Hub need to scaffold it? (Alan: "we do have an agent called the strategist" — verify and extend rather than duplicate.)
2. Telegram channel/route for the strategist's reports (confirm it reuses the existing wiring).
3. Where the BTC-RS lens lives (research-agent lens vs Maven lens) — see open question above.
