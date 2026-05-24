# Lens: Stocks — Memory

## Status

Skeleton only. Not yet built. **Phase 5** in the build order.

## What this lens will do (when built)

Turn raw ingest data into stocks/ETF research signals — watchlist additions, catalyst flags on tracked tickers, sector context. Asset-class lens, not strategy-specific.

## Consumer mental model

The lens does **not** know or care which strategy is reading it. SID is the current consumer; future stock strategies will read the same `stocks-signals.json`. Don't bake strategy-specific logic into the lens.

## Open questions for when work starts

- **Output schema** for `stocks-signals.json` — design generically enough that multiple consumers can read it. SID's needs inform the schema but don't define it.
- **Refresh cadence** — schedule (e.g. every 15 min during market hours) or on-demand only?
- **Watchlist source** — does this lens propose new tickers, or only annotate ones consumers are already tracking?

## Context worth remembering

- SID is currently **PAUSED** (choppy market — see `ironclad_status` memory). Don't be surprised if no strategy is actively consuming signals when this gets built.
- SID's instructor strategy has 70%+ win rate over 300 trades. Signals from this lens are **confirmation aids only** to any consuming strategy — they must never override the strategy's core entry rules. (For SID specifically: RSI 30/70, MACD alignment, RSI 50 exit are non-negotiable.)
