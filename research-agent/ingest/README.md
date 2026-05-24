# Ingest

The shared data layer. Fetches news, macro data, and prices **once per cycle**. All three lenses (`lens-stocks`, `lens-crypto`, `lens-holdings`) read from here — they never fetch directly.

## Why centralised

News headlines, macro releases (CPI, NFP, FOMC), and price snapshots are identical regardless of which strategy is consuming them. Three separate agents each calling the same APIs would:

- Waste API calls (rate limits, cost)
- Create drift — if SID and CATS fetch the same news 30 seconds apart, their decisions can diverge for no good reason

So we fetch once, write to a shared cache, and let each lens pull from that cache.

## Expected contents (once built)

- `news.js` — Bloomberg / Reuters / financial RSS pulls
- `macro.js` — economic calendar (FOMC, CPI, jobs)
- `prices.js` — bulk OHLCV snapshots
- `cache/` — local JSON cache the lenses read

## Current state

Empty skeleton. Will be wired in Phase 2 alongside `lens-holdings`.
