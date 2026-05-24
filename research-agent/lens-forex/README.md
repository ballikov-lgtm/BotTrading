# Lens: Forex

Turns shared research data into FX-specific trading signals.

- **Reads from:** `../ingest/` (the shared news/macro/price cache)
- **Writes to:** `../outputs/forex-signals.json`

## Why a separate lens

Forex is driven by different forces than crypto: central-bank policy, rate differentials, currency-pair geopolitics, sovereign risk. Mixing forex and crypto research into one lens would muddy the signals that downstream FX strategies (when they exist) need.

## Scope (when built)

- Central bank decisions and forward guidance (Fed, BoE, ECB, BoJ, SNB, RBA)
- Rate differential shifts (US 2yr vs EUR 2yr, etc.)
- Major pair news (EUR/USD, GBP/USD, USD/JPY, AUD/USD)
- Sovereign / political risk on currency areas
- Commodity-currency linkages (AUD/CAD/NOK ↔ oil, copper)

## Current state

Empty skeleton. **No forex strategy exists yet** — this lens is built ahead of time so the slot's there when a strategy lands (mirrors how `lens-crypto/` existed before CATS was built).

No phase number assigned. Will be wired when a forex strategy starts taking shape.
