# C.A.T.S. Strategy — Project Context

**Status:** **ALPHA** — Pine Script visualiser built, bot not yet coded. Intended to **replace Ironclad** (currently PAUSED).

This file is the deep-context memory for the C.A.T.S. crypto strategy. New sessions should read this BEFORE acting on any C.A.T.S. work.

---

## Strategy summary (current spec)

- **Asset class:** Crypto (BitGet, replacing Ironclad)
- **Timeframe:** 1H entries
- **Style:** Short-term swing / extended-scalp (hold hours to ~1-2 days)
- **Entry stack (current rough rules):** RSI + MACD on 1H, dynamic short TP based on BTC regime
- **Dynamic TP:**
  - Bullish BTC window: short TP at RSI 55
  - Bearish BTC window: short TP at RSI 50
- **Long TP:** TBD
- **Stop loss:** TBD (likely levels-based per the S&D research below)

This is the **first draft** spec from earlier user discussions. The next stage (this session is the bridge) is to refine the entry/exit triggers using levels-based / supply-demand methodology before coding the bot.

---

## Why C.A.T.S. exists (vs Ironclad)

Ironclad was a multi-timeframe trend bot losing on choppy markets / BTC uncertainty. User wasn't married to it and wanted a better bot-managed crypto day-trading approach. C.A.T.S. is the proposed replacement — same exchange (BitGet), different methodology.

**User intent:** combine the systematic edge of bot trading with the levels-based discretion that top traders use (S&D zones, rejection candles, Wyckoff phases).

---

## Owned files (segregation rules)

Once the bot is coded, C.A.T.S. will own:
- `bot-cats.js` (not yet created)
- `rules-cats.json` (not yet created)
- `*-cats.json/csv` (state files)
- `cats/` subdirectory if needed
- `docs/cats/` (dashboard, if separate from Ironclad's)
- `.github/workflows/cats.yml` (when bot is deployed)
- `pine/cats-visualiser.pine` (current — the Pine script user has already built)

**Won't own:** SID files, Ironclad files (`bot-ironclad.js` etc.), VWAP files.

---

## Top-trader strategy survey (2026-05-22 research)

Categorised summary of top-trader methodologies discovered during research, with credibility filters applied. **Most published "win rates" are inflated** — verified results clearly marked.

### Stocks / equities

| Strategy | Creator | Core mechanic | Verified track record |
|---|---|---|---|
| CANSLIM | William O'Neil (1988) | Fundamental + technical screen (Current quarterly earnings, Annual EPS growth, New products, Supply/demand, Leader, Institutional sponsorship, Market direction) | Foundational |
| **SEPA / VCP** | Mark Minervini | Stage 2 uptrend + Volatility Contraction + tight stops (7-8%) + let winners run | ✅ **Audited.** 1997 US Investing Championship: +255% on $250K. 2021 ($1M division): +334.8% audited. |
| Stage Analysis | Stan Weinstein | Weekly chart, 4 stages (basing→markup→topping→markdown), trade only stage 2 breakouts | Foundational |

### Forex

| Strategy | Creator | Core mechanic | Win rate reality |
|---|---|---|---|
| **ICT / SMC** (Smart Money Concepts) | Michael Huddleston (ICT) | Order blocks, Fair Value Gaps, Liquidity sweeps, Market Structure Shift (MSS), Silver Bullet sessions | Claimed: 70-92%. Backtest reality: **50-65%**. |
| Supply & Demand zones | Sam Seiden (modernised for retail) | Identify zones of imbalance (sharp move from level), wait for retest, enter on rejection | Solid concept; foundational |
| Al Brooks Price Action | Al Brooks | Pure candlestick reading bar-by-bar, no indicators | Not publicly documented |
| Steve Mauro BTMM | Steve Mauro | Daily/weekly 3-drives cycle, EMA(5/13/50/200/800), stop hunts | Vintage 2010s; overlaps with SMC |

### Crypto (mostly inherits from forex methodology)

| Strategy | Core mechanic | Verdict |
|---|---|---|
| **Wyckoff Method** | Accumulation → Markup → Distribution → Markdown phases; volume confirms phase transitions | **Foundational framework** that everything else borrows from. BTC/ETH cycle in clear Wyckoff phases — highly applicable. |
| Supply & Demand (crypto-adapted) | Same as forex: zone identification + retest + rejection candle. First 2 retests strongest; degrades after 3rd | Standard retail crypto methodology |
| ICT/SMC for crypto | Order blocks, FVG, liquidity sweeps on lower TFs | Works on crypto due to similar liquidity-hunting dynamics |
| CRT (Candle Range Theory) | Higher-TF candle range becomes playing field for lower-TF trades | Newer (2024-2025), gaining traction in crypto Twitter |

### Cross-cutting themes in ALL top strategies

Credibility filter: if a "strategy" doesn't have at least 3-4 of these, it's mostly hype.
1. **Multi-timeframe** — higher TF for context, lower TF for entry
2. **Confirmation gate** — never enter on the level alone; wait for candlestick/indicator confirmation
3. **Risk management ≥ technique** — 1-2% per trade, hard stops, never widen
4. **Asymmetric R:R** — minimum 2:1, ideally 3:1+
5. **Trade frequency LOW** — best traders take FEW high-conviction trades (Minervini ~30-50/year)
6. **Phase-aware** — only trade in conditions the strategy was designed for (trend strategies die in chop, mean-reversion dies in trends)

---

## C.A.T.S. trigger recipe (proposed — to refine in new session)

Based on convergent themes, here's the canonical S&D-based recipe. Treat as starting point for design discussion.

### Trigger logic

**1. Zone identification (higher TF — 4h or 1D for crypto):**
- Find candles with: large body relative to ATR (≥2× ATR), high volume relative to MA, followed by sharp move away from the level
- The base of that move = supply zone (if move was down) or demand zone (if move was up)
- Record zone high + zone low

**2. Retest detection:**
- Price returns to within X% of the zone (e.g., 0.5%)
- Count how many prior retests have occurred — abort if 3+ (zone weakened)
- Track active zones per symbol

**3. Entry confirmation (lower TF — 15m or 1h, matching C.A.T.S.'s 1H spec):**
- Rejection candle: bullish engulfing/hammer at demand zone, bearish engulfing/shooting star at supply zone
- Volume spike on rejection (above N-period MA)
- Optional: RSI divergence on the test, MACD reversal

**4. Risk management:**
- Stop: just beyond the zone (5-10 ATR away on lower TF — depends on volatility regime)
- Position size: 1-2% of account (per Minervini, ICT, every top strategy)
- TP1: previous range high/low or 2R (close 50%)
- TP2: opposite zone or 4R (close remainder)

**5. Filters to add:**
- **BTC trend filter** — don't fight the macro. Currently C.A.T.S. uses BTC bullish/bearish window for TP variation; can extend to entry-gating
- **News blackout** — avoid high-impact crypto news windows (regulatory events, ETF flows, etc.)
- **Liquidity filter** — avoid micro-cap alts (volume threshold)

### How this differs from current C.A.T.S. spec

Current spec: RSI/MACD entries with dynamic TP based on BTC regime.
S&D-based: zone identification → retest → rejection candle → enter.

**Open question for new session:** does C.A.T.S. become a HYBRID (RSI/MACD as primary trigger, S&D zones as filter or vice versa), or pivot fully to S&D-based?

---

## Pending tasks (carried over)

From user MEMORY.md:
1. MA filter — add moving-average filter to entry conditions
2. `bot-cats.js` — code the actual bot (not yet started)
3. Save Pine source — the visualiser Pine script needs to be committed somewhere stable

New from this session's research:
4. Decide methodology: pure RSI/MACD vs S&D zones vs hybrid
5. If S&D: build zone-detection algorithm (candle body × ATR + volume + sharp departure)
6. If S&D: build retest + rejection detection
7. Backtest framework for crypto (BitGet historical data via API)

---

## Pine visualiser status

User has built a Pine Script visualiser for C.A.T.S. Per the user MEMORY.md note: "Pine Script visualiser built. … 3 pending tasks: save Pine source."

The Pine source needs to be saved to `pine/cats-visualiser.pine` or similar so future sessions can read/modify it. **Action for new session:** ask user for the Pine code, save it, then iterate.

---

## Coding conventions (when bot is built)

- **Language:** Likely Node.js (matches SID/Ironclad pattern). Could pivot to Python if backtest framework needs it.
- **Exchange:** BitGet (same as Ironclad/VWAP). Reuse existing BitGet client code if available — check `bot-ironclad.js` / `bot.js` for reusable bits but DO NOT modify them.
- **State files:** `open-positions-cats.json`, `closed-positions-cats.json`, `cats-log.json` (mirror SID pattern)
- **Telegram alerts:** reuse `SID/telegram-alerts.js` helper — already configured
- **Risk per trade:** 1% (mirror SID's `i_riskPct=1.0` and align with all top-strategy convention)

---

## Research sources

- [How to Trade Crypto Using Supply and Demand Zones — BingX](https://bingx.com/en/learn/article/how-to-trade-crypto-using-supply-and-demand-zones)
- [Crypto Trader's Guide to Supply and Demand Trading — CryptoHopper](https://www.cryptohopper.com/blog/crypto-trader-s-guide-to-supply-and-demand-trading-7771)
- [Supply & Demand Zones: Core Trading Strategies — LuxAlgo](https://www.luxalgo.com/blog/supply-and-demand-zones-core-trading-strategies/)
- [Top 30 Smart Money Trading Strategies for 2026 — Medium](https://medium.com/@smcTradingStrategies/top-30-smart-money-trading-strategies-for-2026-29b51e372284)
- [What is SMC (Smart Money Concepts) Forex Strategy — PrimeXBT](https://primexbt.com/for-traders/what-is-smc-smart-money-concepts/)
- [ICT Trading Strategy Ultimate Guide — Trek and Trade](https://trekandtrade.com/mastering-ict-trading-strategy-your-ultimate-guide-to-smart-money-concepts/)
- [Mark Minervini SEPA / VCP — ChartMill](https://www.chartmill.com/documentation/stock-screener/fundamental-analysis-investing-strategies/465-Mark-Minervini-Strategy-Think-and-Trade-Like-a-Champion-Trading-Strategy)
- [Mark Minervini's Stock-Screening Guide — QuantVPS](https://www.quantvps.com/blog/mark-minervinis-guide-to-finding-winning-stocks)
- [Wyckoff Method Accumulation & Distribution — Phemex](https://phemex.com/academy/wyckoff-accumulation)
- [The Wyckoff Method Explained — Binance Academy](https://www.binance.com/en/academy/articles/the-wyckoff-method-explained)
- [Wyckoff Method for Crypto Trading — TradeSanta](https://tradesanta.com/blog/wyckoff-method-for-crypto-trading)

---

## See also

- Root project hub → [`CLAUDE.md`](CLAUDE.md)
- Ironclad context (what C.A.T.S. is replacing) → [`IRONCLAD-MEMORY.md`](IRONCLAD-MEMORY.md)
- VWAP context (sibling crypto strategy) → [`VWAP-MEMORY.md`](VWAP-MEMORY.md)
- SID context (sibling stocks strategy with similar architecture) → [`SID/CLAUDE.md`](SID/CLAUDE.md)
- User-level memory (cross-session) → `~/.claude/projects/.../memory/MEMORY.md`
