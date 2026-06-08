# Maven — 4-Hour Long-Biased Trend-Pullback Rider (crypto)

**Name:** M.A.V.E.N = **M**oving **A**verage re**V**ersion **EN**try (original meaning; the strategy has since evolved from reversal to trend-pullback — name kept). A "maven" is a trusted expert: the strategy that knows exactly when to step in.

**Status:** **VALIDATED IN BACKTEST (2026-06-08) · pre-live.** Not live, not paper, not real money yet. Designed by Alan from his own 4h chart reading; engineered + validated with Atlas/Claude Code over the 2026-06-07→08 sessions. Full session journal in `MEMORY.md`.

---

## One-liner
On the 4-hour chart, once a coin's trend has *demonstrably* turned up (its 20 SMA has crossed and pulled clear of its 200 SMA, with the daily 200 also rising), buy the first shallow RSI pullback that turns back up — bank half at RSI 50, ride the rest on the 20 SMA. **Longs only. Curated watchlist of BTC-outperforming alts.**

## ⚠️ This is NOT the original reversal model
Maven began as a both-directions **mean-reversion** strategy (catch an RSI extreme as price reclaims the 20 SMA). That version **lost money** (full-basket PF 0.75, −49%). Through the 2026-06 sessions it was rebuilt into the **trend-pullback** model documented here, which turned the same basket profitable. The old reversal rules are superseded — see "What was tested and rejected" below so they aren't re-tried.

---

## The strategy (the validated config)

**Timeframe:** 4-hour entries; daily used for the macro trend gate; 1-hour optionally for the TP2 read.

**Direction:** **LONGS ONLY.** Shorts were tested thoroughly and rejected (they bled on 4 of 5 coins — crypto's upward drift squeezes counter-trend shorts; BTC shorts were 47% WR but PF 0.13). The cross gate already keeps longs out of downtrends, so shorts aren't needed for protection.

**Indicators (4h unless stated):**
- `sma20 = SMA(close, 20)` — the spine.
- `sma200 = SMA(close, 200)` — the trend line (4h).
- `rsi = RSI(14)`.
- `MACD(12,26,9)` — the **histogram** (momentum turn).
- Daily `sma200` (the asset's own daily 200 SMA) — the macro trend.

**Gates — a trade is only valid when the trend is genuinely established (ALL must hold):**
1. **Cross gate:** 4h `sma20 > sma200` (price is in a confirmed up-leg, i.e. past a golden cross). *This is the single biggest improvement — it kills the falling-knife longs that sank the old model.*
2. **Gap filter:** the 20 sits **≥ ~3%** above the 200 (`|20−200|/200 ≥ 3%`) — skips the choppy cross/transition zone where whipsaws live.
3. **MTF 200-slope agreement:** **both** the 4h 200 SMA **and** the daily 200 SMA are sloping **up** (rising over their lookbacks, ~10 4h-bars / ~5 daily-bars). A flat/falling daily 200 = no trade. *This stops entries when the local 4h looks bullish but the macro daily trend isn't — Alan's catch.*

**Entry (the pullback):**
4. Within the last ~6 bars, 4h RSI dipped to **≤ 35** (the "floor" — in a confirmed uptrend RSI rarely revisits 30; it holds ~35–40).
5. This 4h candle **closes back above the 20 SMA** (reclaim), the previous closed at/below it.
6. 4h **RSI turning up** (`rsi > rsi[1]`) **AND** MACD **histogram turning up** (`hist > hist[1]`).
7. **Enter on the next 4h candle's open.**

**Stop:** the **confirmation-candle wick, or 2% — whichever is tighter** (default; the validated config uses this ~2% cap, so each position ≈ 1× account at 2% risk). Alternative `swing` (lowest-low over the arm window) and `prevclose` modes exist in the engine for testing.

**Take-profit / exits:**
- **TP1:** close **50%** when 4h RSI reaches **50**; move the stop on the runner to **break-even + fees** (risk-free runner).
- **TP2 (runner):** exit when a **1-hour candle closes back below the 4h 20 SMA** (engine default approximates via the 4h close / `request.security_lower_tf` in Pine).
- **Time stop:** force-exit after **20 × 4h candles** (~3.3 days).

**Money / risk (live params, Alan):**
- **$1,000 USDT compounding account.**
- **2% risk per trade** (of current equity). Position size = (2% × equity) ÷ stop-distance — risk-based, not fixed notional.
- **Max 3 concurrent positions.**
- **3× leverage hard cap** (Bitget) — and the bot must size *down* rather than breach it. At ~2% stops, each position ≈ 1× equity, so 3 concurrent ≈ 3× — the cap is sized to exactly fit Alan's 3-position rule. (Backtest showed the cap almost never binds — Maven is low-frequency.)
- Costs modelled at ~0.08%/side.

---

## Watchlist — curated by coin character, NOT by backtest-mining

Maven is a **curated-watchlist** strategy. The selection rule is **relative strength vs Bitcoin**: a coin earns/keeps a slot when it is **outperforming BTC on the trend** (the ALT/BTC ratio — not ALT/USDT — is rising). Maven is a trend-pullback system, so it wants the **leaders** (HYPE, TRX, etc.), not laggards or memecoins.

**Current watchlist (10):** ETH, SOL, XRP, SUI, VIRTUAL, HYPE, APT, FET, SEI, TRX.
- **Binned:** LINK (0/7, −$570 — grindy/rangey), BTC (marginal), and memecoins WIF/PEPE (WIF generated 0 trades).
- **Why this method isn't overfitting:** TRX was added as a *fresh forward pick by character* (a BTC-outperformer, never in any prior backtest) and came back PF 8.21 — evidence the relative-strength criterion is **predictive**, not curve-fit.
- **Maintenance:** review quarterly; drop coins that lose relative strength, add new BTC-outperformers (fed by the research-agent's news lens + BTC-RS data lens — see the operational handoff).

---

## Backtest evidence (2023-01-01 → 2026-06-01, Bitget, fees on)

**Per-coin engine (independent books), full original basket:** the rebuild turned the loser around —
| Config | PF | Net (on $10k) |
|---|---|---|
| Original reversal model | 0.75 | −$4,888 |
| + cross gate + 3% gap (both dirs) | 1.22 | +$1,285 |
| + MTF slope gate (both dirs) | 1.31 | +$895 |
| **+ longs-only (the config)** | **2.19** | **+$1,491** |

**Portfolio sim (the real live model — one shared $1,000 account, 2% risk, max 3 concurrent, 3× cap, compounding), curated watchlist:**
> **+60.3% over 3.5 years · max drawdown 4.6% · WR ~70% · PF ~4.4 · 37/37 signals taken (cap never bound).**

*Honest caveat:* the curated-watchlist portfolio number carries selection bias (optimistic). The durable, non-overfit edge is: (a) the cross-gate/gap/MTF/longs-only logic — proven across the *whole* basket — and (b) the BTC-relative-strength watchlist method. Forward expectation is positive but below the cherry-picked +60%.

---

## What was tested and REJECTED (don't re-try — see MEMORY.md for the numbers)
- **Shorts** — net-negative on 4/5 coins (squeeze risk). Longs-only wins.
- **Daily-RSI arming** (vs 4h) — at 35/5-day it was *less* selective, not more; PF 0.57. The cross gate is the better selectivity mechanism.
- **4h-only 200-slope-direction gate** — too weak (a 200 SMA's direction is almost always defined); use the 20/200 **gap** + the **MTF** (4h+daily) slope agreement instead.
- **Macro-event blackout (FOMC/CPI/PPI, 48h)** — REJECTED. Event-window trades were the strategy's *best* (PF 5.16 vs 1.49); blacking them out deleted the best entries. Crypto often ignores the print, and big macro days kick off the trends Maven rides. (Filter exists in the engine, default OFF.)
- **Expanding to random "shitcoins"** — diluted the edge (INJ/NEAR/ONDO/ENA/PEPE lost). Curate by character, don't throw everything at it.

---

## Build & validation plan (the path to live)
1. **Bot** — Python bot on Bitget that **reuses the validated signal engine** (`backtest-maven.py` `run_core`/detection — so live logic == backtest logic exactly, no re-implementation drift). Paper-mode first. Watchlist + 2% risk + 3 concurrent + 3× cap + the portfolio sizing logic. Cloud-run (GHA/Railway), state files + dashboard like the other strategies.
2. **3-week observation** of the paper bot (heed the Ironclad lesson — confirm live behaviour before trust).
3. **Live paper trading**, then **live** with the $1,000.
4. **Dashboard** mimicking the CATS dashboard (Alan to supply a new logo).
5. **Operational layer** (daily strategist monitor + research lenses + BTC-RS watchlist data) — routed to Hub → strategist + research-agent. See `HANDOFF-strategist-and-research.md`.

## Files
- `backtest-maven.py` — the validated engine (cross gate, gap, MTF slope, blackout[off], portfolio sim, `--symbols`, disk cache). **Source of truth for the logic.**
- `pine/maven-*.pine` — TradingView visualisers/strategies (raw indicator, strategy, daily-armed, cross-armed v1/v2/v3).
- `event-dates.json`, `event-autopsy.py` — macro-event calendar + autopsy tool (blackout rejected, kept for reference).
- `MEMORY.md` — full session journal (every test + result).
- `HANDOFF-strategist-and-research.md` — operational layer handoff to Hub.

## Lineage
Designed by **Alan** (3 years of chart reading; the cross-gate + MTF-slope + BTC-RS-watchlist insights are his). Engineered/validated by **Atlas / Claude Code**, 2026-06-07→08. Hub: **Atlas**. Siblings: `SID` (daily RSI mean-reversion, US stocks), `vwap-specialist` (4h ranging), `Ironclad` (long-only trend, PAUSED — its downtrend failure is what longs-only-with-a-real-trend-gate is designed to avoid), `CATS` (likely shelved; its research lens repurposed for Maven).
