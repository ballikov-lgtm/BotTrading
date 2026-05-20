# Agent roster

Specialist subagents for the Trading Setup repo. The main Claude Code session (the "orchestrator") delegates domain-specific work to these agents. Each runs in **isolated context** — it doesn't see the main conversation — and returns a single summary message.

## Who's here

| Agent | Use for | Touches | Mode |
|---|---|---|---|
| **sid-specialist** | All SID work — RSI mean-reversion swing on US stocks/ETFs via Alpaca | `SID/`, `docs/sid/`, `sid*.yml`, `*-sid` files | Read + write |
| **ironclad-specialist** | All Ironclad work — multi-timeframe trend bot on BitGet futures (currently PAUSED) | `bot-ironclad.js`, `bot-hype-manager.js`, `railway-runner.js`, `rules-ironclad.json`, `*-ironclad` files, `hype-state.json`, `docs/index.html`, `ironclad.yml`, `research.yml` | Read + write |
| **vwap-specialist** | All VWAP Scalper work — 4h crypto scalp on BitGet (ranging markets only) | `bot.js`, `rules.json`, `trades.csv`, `safety-check-log.json`, `trade.yml` | Read + write |
| **strategy-validator** | Cross-strategy audits — correctness drift, security, segregation violations, dead code, memory file drift | All three above, plus root `CLAUDE.md` and user-level memory | **Read-only** |

## How they work (one paragraph)

Each agent is a markdown file in this folder with a YAML header (`name`, `description`, `tools`, `model`) and a body that acts as its system prompt. When the orchestrator decides to delegate, it invokes the agent by `name`. The agent boots in a fresh context, reads its domain memory file (e.g. `SID/CLAUDE.md`), does the work, and returns a single message. The orchestrator's context window stays clean — heavy reading happens in the specialist's isolated thread.

You don't install or download these agents. They're text files. They ship with the repo at `.claude/agents/*.md`.

## Delegation rules

The orchestrator decides which agent to call based on the agent's `description` field. As the user, you can also force-route by saying e.g. *"ask the SID specialist to ..."* or *"have the validator audit Ironclad"*.

**Segregation is enforced by each specialist itself.** If you ask `sid-specialist` to edit an Ironclad file, it will refuse and route you to `ironclad-specialist`. This is the whole point of the split — no accidental cross-strategy bleed.

## What's deferred (phase 2+)

These agents don't exist yet — they're noted in the plan and will be built in later sessions:

- `research-agent` — stocks/ETF macro, crypto/BTC narrative, whale tracking. Reuses `SID/telegram-alerts.js` for messaging when wired.
- Scheduled whale/news alerts → Telegram (a GitHub Actions workflow, not an agent — agents can't run unattended).
- `design-agent` — dashboard styling, theme system, trade-report exports.
- `sipps-specialist` — blocked until we locate the SIPPs tooling (not currently in this repo).
- `life-admin` — diary, files, email triage. Lowest priority.

See the approved plan at `~/.claude/plans/hi-there-so-i-m-linked-pancake.md`.

## Listing & verifying

In any Claude Code session, run `/agents` to see the registered roster. To verify an agent works end-to-end, ask the orchestrator e.g. *"What's the current state of SID?"* and confirm it delegates rather than answering directly.
