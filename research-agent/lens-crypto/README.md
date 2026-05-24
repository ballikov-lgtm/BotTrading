# Lens: Crypto

Turns shared research data into crypto research signals — independent of any one strategy. **The lens belongs to the asset class, not the consumer.**

- **Reads from:** `../ingest/` (the shared news/macro/price cache)
- **Writes to:** `../outputs/crypto-signals.json`

## Consumers (current and future)

- **CATS** — planned crypto trading strategy. Will read `crypto-signals.json` for BTC regime, altcoin news, regulatory headlines.
- Future crypto strategies — any new crypto-side strategy reads the same file. The lens does not change shape per consumer.

## What this lens produces

- BTC bias windows (bullish vs bearish regime — strategies can use this to switch behaviour)
- Major altcoin news (listings, delistings, exchange issues)
- Regulatory headlines (SEC, ETF flows, country-level crypto bans)
- Macro events that historically move crypto (FOMC, CPI, large equity selloffs)

Price action / RSI / MACD signals come from the chart via TradingView MCP — not from this lens.

## Hand-off

`outputs/crypto-signals.json` is read by whichever crypto strategy consumes it. The lens never calls a strategy's bot — it just produces the file.

## Current state

Empty skeleton. **Phase 6** in the build order. By the time this gets built, CATS itself should be a first-class strategy in the root `CLAUDE.md` Strategy Index.
