# Outputs

The drop folder for results. Each lens writes its own JSON file here. **Filenames are asset-class-based, not strategy-based** — that way a future second strategy in the same asset class can read the same file without anything being renamed.

| File | Written by (asset-class lens) | Consumed by (strategies / agents) |
|---|---|---|
| `stocks-signals.json` | `lens-stocks` | SID strategy (current); future stock strategies |
| `crypto-signals.json` | `lens-crypto` | CATS strategy (when built); future crypto strategies |
| `forex-signals.json` | `lens-forex` | No strategy yet — slot reserved |
| `holdings-alerts.json` | `lens-holdings` | `holdings-agent` (Phase 3), Telegram hub |

## Hard rule

**Lenses never read each other's output files.** Segmentation is the whole point — SID's logic never sees `cats-signals.json` and vice versa. If you find yourself wanting cross-lens reads, the data probably belongs in `ingest/` instead.

## Gitignore policy

Currently undecided. Options:
- Commit them → dashboard can show historical signals from git
- Local-only → smaller repo, no leaking of in-flight signal state

Decision deferred until the first lens produces real output and we see the shape/size.

## Current state

Empty.
