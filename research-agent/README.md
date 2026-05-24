# Research Agent

Shared research service that feeds three downstream consumers:

- **SID** — stock day-trading strategy
- **CATS** — crypto day-trading strategy
- **Holdings** — long-term portfolio (UK funds today, stocks/crypto later)

## How it works

One ingest layer fetches the universal inputs **once per cycle** — economic calendar, FOMC/BoE meetings, earnings dates, geopolitical events, virus outbreaks. Anything that moves multiple asset classes lives here.

Four separate "lens" modules turn that shared data, plus asset-class-specific research, into structured signals. **Each lens belongs to an asset class, not a strategy.** Strategies (SID, CATS, etc.) are downstream consumers that read whichever lens covers their asset class.

**Lenses never read each other's outputs** — hard segmentation at the output file layer. SID's stocks logic never sees crypto research, and vice versa.

## Folder map

| Folder | Asset class | Current/planned consumer | Output file | Phase |
|---|---|---|---|---|
| `ingest/` | Shared (universal) | All lenses | (in-memory cache) | Phase 2 |
| `lens-stocks/` | Stocks / ETFs | SID strategy | `outputs/stocks-signals.json` | Phase 5 |
| `lens-crypto/` | Crypto | CATS strategy | `outputs/crypto-signals.json` | Phase 6 |
| `lens-forex/` | Forex | (no strategy yet — slot reserved) | `outputs/forex-signals.json` | Unscheduled |
| `lens-holdings/` | ETFs / fund managers (long-term) | `holdings-agent/` (Phase 3) | `outputs/holdings-alerts.json` | Phase 2 (first wired) |
| `outputs/` | — | — | Per-lens JSON drops | Populated at runtime |

## Current state

- **Phase 1** ✅ done 2026-05-24 — folder skeleton.
- **Phase 2** ✅ done 2026-05-24 — `lens-holdings/` wired end-to-end. Run `py research-agent/lens-holdings/lens.py` to produce `outputs/holdings-alerts.json`. See `lens-holdings/MEMORY.md` for operating notes.

See `MEMORY.md` for what's next and where to pick up.

## Related

- Sister agent: `../holdings-agent/` (not yet created — Phase 3)
- Telegram hub: `Claude Base/hub/` (will gain `RESEARCH NOW STOCKS|CRYPTO|HOLDINGS` commands in Phase 4)
- Full architecture rationale: project memory file `holdings-research-architecture.md`
