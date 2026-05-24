# Lens: Crypto — Memory

## Status

Skeleton only. Not yet built. **Phase 6** — the last lens to be wired.

## What this lens will do (when built)

Crypto research signals — BTC bias regime detection, altcoin news, regulatory headlines, macro events that move crypto. Asset-class lens, not strategy-specific.

## Consumer mental model

The lens does **not** know or care which strategy is reading it. CATS is the planned consumer; future crypto strategies will read the same `crypto-signals.json`. Don't bake strategy-specific logic into the lens.

## Open questions for when work starts

- **Output schema** for `crypto-signals.json` — design generically enough that multiple consumers can read it. CATS's needs inform the schema but don't define it.
- **BTC bias detection** — does this lens emit a clean bullish/bearish regime call, or just expose the underlying inputs and let each strategy decide?
- **24/7 vs market-hours** — crypto trades 24/7. This lens probably runs more often than the stocks lens.

## Context worth remembering

- CATS is a **new strategy replacing Ironclad** (see `cats_status` memory). Pine Script visualiser exists; bot is NOT yet coded.
- CATS uses dynamic short TPs: RSI 55 in bullish BTC window, RSI 50 in bearish. So this lens's BTC regime call (if it makes one) needs to be reliable — it would directly affect CATS exits.
