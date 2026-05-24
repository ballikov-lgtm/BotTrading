# Lens: Stocks

Turns shared research data into stocks/ETF research signals — independent of any one strategy. **The lens belongs to the asset class, not the consumer.**

- **Reads from:** `../ingest/` (the shared news/macro/price cache)
- **Writes to:** `../outputs/stocks-signals.json`

## Consumers (current and future)

- **SID** — current stocks/ETF trading strategy. Reads `stocks-signals.json` for catalyst flags and watchlist context.
- Future stock strategies — any new equity-side strategy can read the same file. The lens does not change shape per consumer.

## What this lens produces

Things that aren't already on the chart:

- New tickers worth watching (catalyst-driven)
- Catalyst flags on tickers any strategy is tracking (earnings dates, news hits, pre-market gaps)
- Sector-level context (e.g. "tech selloff overnight, expect gappy opens")

Price action and indicator signals come from the chart directly via the TradingView MCP — not from this lens.

## Hand-off

`outputs/stocks-signals.json` is read by whichever strategy consumes it. The lens never calls a strategy's bot — it just produces the file.

## Current state

Empty skeleton. **Phase 5** in the build order — comes after holdings is wired and the Telegram hub is extended.
