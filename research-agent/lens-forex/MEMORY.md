# Lens: Forex — Memory

## Status

Skeleton only. Not yet built. **No phase number** — waits for a forex strategy to exist.

## Why this folder exists

User clarified (2026-05-24) that forex must be kept separate from crypto at the research layer — different drivers (rate differentials, central-bank policy, sovereign risk) vs crypto's adoption/regulatory/on-chain drivers.

Created proactively so the architectural slot exists; mirrors the pattern of `lens-crypto/` being created before CATS was built.

## When work starts

- Output schema for `forex-signals.json` — TBD when first FX consumer exists
- Source list — likely overlaps with stocks (FT, Bloomberg, Reuters) but adds FX-specific (DailyFX, FXStreet, central bank press release feeds)
- Will probably reuse shared ingest for FOMC / BoE calendar
