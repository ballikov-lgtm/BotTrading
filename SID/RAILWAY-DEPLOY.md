# SID on Railway — deploy guide (v2.6.0)

**What this gives you:** SID stops depending on GitHub Actions crons, which have been
landing **~3 hours late** (the 14:35 UTC run arriving ~18:15, the 18:35 run ~21:10).
Railway's cron is documented as varying only *"by a few minutes"*. Combined with
v2.6.0's queue-for-open exits, a ripe exit now either fires in-session or is handed
to Alpaca to execute at the next open — it can no longer sit for days.

**This is a CRON service, not an always-on worker.** It wakes up, does one cycle of
work, and exits. You are billed for execution time, not for a process sitting
resident 24/7. On a daily-bar strategy that is a few seconds of work per cycle.

**Keep the GitHub Actions crons enabled for now.** This is Phase 1 — both run side
by side deliberately. Phase 2 (turning the Actions crons off) is at the bottom, and
only after Railway has covered a few clean sessions.

---

## Before you start

- You already have a Railway project running **Ironclad**. SID goes in as a
  **separate service** in that same project. Same project is fine; the two services
  must stay separate — different start commands, different variables, different
  logs. **Do not add SID's variables to the Ironclad service.**
- You will need to paste values for the variables listed in step 4. **This document
  deliberately contains no values** — only names. Get each value from where you
  already keep it (Alpaca dashboard, GitHub Secrets, your password manager).
- Nothing here changes any trading rule. It changes *when the bot gets a chance to
  act*, nothing else.

---

## 1. Create the service

1. Open your Railway project (the one with the Ironclad service in it).
2. Click **+ New** → **GitHub Repo** → pick **`ballikov-lgtm/BotTrading`**.
3. Railway creates a second service and starts a build. **It will initially try to
   run Ironclad's start command** (the repo-root `railway.json` says
   `node railway-runner.js`). That is expected — step 2 fixes it. If that first
   build deploys and starts Ironclad's loop, just continue; step 2 and step 5 stop it.
4. Rename the service so you can never confuse the two: service → **Settings** →
   **Service Name** → `sid-bot`.

---

## 2. Point it at SID's runner (do this before setting the cron)

Service → **Settings** → **Deploy** → **Custom Start Command**:

```
node SID/railway-sid-runner.js
```

That override is what keeps SID off Ironclad's runner. (Alternative, if you prefer
config-as-code: Settings → **Config as code** → set the path to
`SID/railway-sid.json`, which carries the same start command plus
`restartPolicyType: NEVER`. Either works — **do not do both**, and either way never
edit the repo-root `railway.json`, which belongs to Ironclad.)

---

## 3. Set the watch paths (IMPORTANT — skip this and you get a redeploy on every cycle)

The runner pushes SID's state files back to `main` after each cycle. If the service
redeploys on every push to `main`, every cycle triggers a rebuild.

Service → **Settings** → **Build** → **Watch Paths**, and enter *only the code*:

```
SID/railway-sid-runner.js
SID/bot-sid.js
SID/alpaca-client.js
SID/alpaca-executor.js
SID/telegram-alerts.js
SID/rsi-target-price.js
SID/watchlist-sid.json
SID/event-dates.json
package.json
package-lock.json
```

With those set, a `SID railway run ...` or `SID run ...` state commit does not
rebuild anything, but a real code change does.

---

## 4. Set the variables (NAMES ONLY below — paste your own values)

Service → **Variables** → **New Variable** for each.

### Required — the service refuses to run without these

| Variable name | What it is |
|---|---|
| `SID_GITHUB_TOKEN` | GitHub token with **contents: write** on `ballikov-lgtm/BotTrading` only. Used to pull state before the cycle and push it after. Prefer a fine-grained token scoped to this one repo. (`GITHUB_TOKEN` also works, but `SID_GITHUB_TOKEN` keeps SID's token separate from Ironclad's.) |
| `ALPACA_KEY_ID` | Alpaca API key id — **the paper one**. |
| `ALPACA_SECRET_KEY` | Alpaca API secret — **the paper one**. |
| `SID_TRADING_MODE` | `paper`. (Values: `dry_run` \| `paper` \| `live`.) |

If any of those four is missing the service **exits 1 with a message naming the
missing variable** and does no work. That is intentional: without Alpaca keys the
bot silently degrades to `dry_run` and would manage nothing while looking healthy.

### Strongly recommended

| Variable name | What it is |
|---|---|
| `ALPACA_BASE_URL` | Pin the endpoint explicitly, e.g. the paper API base URL. Belt and braces against a mode typo. |
| `TELEGRAM_BOT_TOKEN` | So the runner's alerts reach you — including the v2.6.0 "exit queued for the open" and "queued exit was dropped" messages. |
| `TELEGRAM_CHAT_ID` | Your chat id. |

### Optional

| Variable name | What it is |
|---|---|
| `TELEGRAM_ALERTS_ENABLED` | `false` to mute alerts without deleting the token. |
| `SID_PDT_SAFE` | `true` only if the account is under $25,000. **Must match what `sid.yml` uses** — a mismatch means the two runners manage positions differently. |
| `SID_ACCOUNT_USD`, `SID_RISK_PCT`, `SID_MAX_POS_PCT`, `SID_MAX_POSITIONS`, `SID_MAX_PER_DAY`, `SID_EARNINGS_WINDOW`, `SID_PAPER` | Strategy config. Leave unset to use the same defaults `sid.yml` runs on. **If you set any of these here, set the same value in GitHub Secrets** while both runners are live. |
| `SID_QUEUE_EXITS_FOR_OPEN` | `false` disables v2.6.0 queue-for-open exits (back to "refuse and retry next run"). |
| `SID_WEEKEND_EXIT_QUEUE` | `false` restores the old hard weekend stop (no position management at all Sat/Sun). |
| `SID_STATE_BRANCH` | Defaults to `main`. Do not change — `sid-dashboard.yml` builds the dashboard from `main`. |
| `GITHUB_OWNER`, `GITHUB_REPO` | Default to `ballikov-lgtm` / `BotTrading`. |
| `SID_RUNNER_DRY_PUSH` | `true` makes the cycle run for real but **not push state**. Useful for the very first smoke test (step 6). Remove it afterwards. |
| `SID_LIVE_CONFIRMED` | Only relevant if `SID_TRADING_MODE=live`. The service refuses to start on `live` without it. |

**Never** put a credential value in a repo file, a commit, a `railway.json`, or a
code default. The runner has no `|| '<literal>'` fallbacks by design.

---

## 5. Set the cron schedule

Service → **Settings** → **Cron Schedule**:

```
*/15 13-23 * * 1-5
```

Then make sure **no replica is left running as a worker**: a cron service should show
no persistently Active deployment between runs. If the first deploy (step 1) left
Ironclad's loop running, redeploy the service now that the start command is
overridden.

**Why that expression:**

- **UTC.** Railway cron is always UTC.
- `13-23` covers the US session in **both DST regimes** — US regular hours are
  14:30–21:00 UTC in winter (EST) and 13:30–20:00 UTC in summer (EDT) — plus the
  evening window after 19:00 ET when Alpaca will accept an at-the-open order for the
  next session. **The schedule never decides whether the market is open**; the runner
  asks Alpaca's `/v2/clock` every cycle, so DST and holidays are the broker's
  problem, not a hardcoded calendar's.
- `*/15` is the behaviour the brief asked for in-hours. Railway requires scheduled
  runs to be **at least 5 minutes apart**, and `*/15` is explicitly listed as valid.
- `1-5` = Mon–Fri UTC. Note Friday evening ET spills into Saturday UTC, so a
  Friday-evening exit is queued by the **Friday** 23:xx UTC cycle (22:00/23:00 UTC =
  18:00/19:00 ET) — which is exactly when Alpaca starts accepting an at-the-open
  order for Monday.

**Out-of-hours cycles are cheap on purpose.** When `/v2/clock` says closed, the
runner sets `SID_EXITS_ONLY=true`: the bot reconciles any pending exit and queues a
ripe one for the next open, but skips the 112-ticker Yahoo entry scan (an entry would
be refused out of hours anyway). With no open positions a closed-market cycle is
essentially just the state pull and the clock read.

---

## 6. Confirm it is working

**A. Watch one cycle.** Service → **Deployments** → open the latest → **Logs**.
Trigger one immediately rather than waiting: `railway cron run` from the CLI, or
Railway's **Deploy / Redeploy**. A healthy cycle looks like:

```
[SID-RAILWAY] Mode: PAPER  state branch: main  repo: ballikov-lgtm/BotTrading
==============================================================
  SID Railway cron cycle — 2026-10-24 18:15 UTC
==============================================================

-- Pulling state from ballikov-lgtm/BotTrading@main --
  v SID/watchlist-sid.json (...)
  v SID/open-positions-sid.json (2 bytes)
  ...
-- Market clock -- is_open=true now=2026-10-24T14:15:… next_close=…
   Market OPEN -> FULL cycle (position management + entry scan)

-- Running bot-sid.js --
══ SID Bot run 2026-10-24T18:15:…
[Alpaca] Account snapshot refreshed: equity $100,543.43 …
…
══ SID run complete — 0 new trade(s) ══

-- Pushing changed state to main --
  ^ SID/alpaca-account-sid.json -> main
  -- state push: 1 written, 6 unchanged, 0 failed --

==============================================================
  Cycle complete in 41.3s — cycle=FULL bot=ok pushed=1 failed=0
==============================================================
```

**The five things to check, in order:**

1. `Mode: PAPER` — not `DRY_RUN`, not `LIVE`.
2. A `Market clock` line with a real `is_open=` — if it says *clock unavailable*,
   the Alpaca variables are wrong and every cycle will take the cheap path.
3. `══ SID Bot run` appears — the bot itself actually ran.
4. `state push: … 0 failed` — the GitHub token works.
5. The run **ends** (`Cycle complete`) and the deployment stops being Active.
   A cron run that never exits makes Railway **skip every subsequent run**.

**B. Check the commit landed.** On GitHub, `main` should get a commit titled
`SID railway run YYYY-MM-DD HH:MM UTC` whenever state actually changed. (Quiet cycles
push nothing by design — "6 unchanged" above is a healthy cycle, not a failure.)
That commit message is deliberately distinct from Actions' `SID run …`, so you can
always tell which runner did a thing.

**C. First smoke test without touching the cloud.** Set
`SID_RUNNER_DRY_PUSH=true`, run one cycle, confirm the log says
`CHANGED (dry push, not sent)` for any file it would have written, then delete the
variable.

---

## 7. If something is wrong — rollback

Rollback is cheap and total, because **the GitHub Actions crons are still running**
(Phase 1). SID keeps trading on Actions alone the moment you disable Railway.

| Situation | Do this |
|---|---|
| Stop Railway running SID, keep everything else | Service → **Settings** → **Cron Schedule** → clear the field and save. No more cycles. Actions crons carry on. |
| Stop it and remove it | Service → **Settings** → **Danger** → **Remove Service**. Nothing in the repo needs changing. |
| Roll back to the previous code | Service → **Deployments** → pick the last good deployment → **Redeploy**. |
| Suspect it is fighting the Actions runs over state | Clear the Cron Schedule (above). Then check `main` for interleaved `SID railway run …` and `SID run …` commits and confirm `SID/closed-positions-sid.json` has no duplicate trade ids. |
| Turn off only the new exit behaviour, keep the runner | Set `SID_QUEUE_EXITS_FOR_OPEN=false` on **both** the Railway service and GitHub Secrets. Exits revert to "refuse when closed, retry next run". |

---

## What runs where, during Phase 1

| | GitHub Actions (`sid.yml`) | Railway cron (`sid-bot`) |
|---|---|---|
| Schedule | 14:35 / 16:35 / 18:35 UTC, Mon–Fri | `*/15 13-23 * * 1-5` UTC |
| Punctuality | best-effort; **observed hours late** | Railway: varies "by a few minutes" |
| Out-of-hours cycles | no | yes (cheap, exits only) |
| Entry scan | yes | only when `/v2/clock` says open |
| State commit message | `SID run …` | `SID railway run …` |

**Running both is safe, and not by luck.** The bot is idempotent across same-day
runs (`tp1_hit` persists in committed state, an open symbol is skipped,
`countTodayTrades()` caps entries per *calendar day* across all runs, the approval
queue is de-duped on a deterministic id), and v2.6.0 adds the broker-level guard
that matters: every queued exit carries a **deterministic daily
`client_order_id`**, so if both runners decide to queue the same exit in the same
minute, Alpaca rejects the second as a duplicate. Local state can be stale; the
broker's uniqueness check cannot.

---

## Phase 2 — retire the GitHub Actions crons

**Do not do this yet.** Only after the Railway service has covered **a few clean
sessions** — specifically, you want to have seen all of:

- at least one **in-hours** cycle that managed a real position;
- at least one **out-of-hours** cycle that queued an exit for the open **and** the
  follow-up cycle that booked the fill;
- no duplicate trades in `SID/closed-positions-sid.json`;
- no repeated `state push … failed` lines.

Then edit `.github/workflows/sid.yml` and comment out the `schedule:` block, keeping
`workflow_dispatch` so you can still fire a run by hand. Use the same banner style as
`.github/workflows/trade.yml`:

```yaml
on:
  workflow_dispatch: # Manual trigger for testing
  # ── SCHEDULE PAUSED <date> ─────────────────────────────────────────────────
  # SID now runs from the Railway cron service (SID/railway-sid-runner.js), which
  # lands within minutes instead of the hours-late GHA crons that caused the
  # 2026-09-09 IBM missed exit. This workflow is kept as a MANUAL backup — a
  # dispatch still runs the full bot.
  # TO RESTORE: delete the '# ' prefix from the schedule block below.

#   schedule:
#     - cron: '35 14 * * 1-5'   # 14:35 UTC (09:35 ET) — 5 min after open
#     - cron: '35 16 * * 1-5'   # 16:35 UTC (12:35 ET) — mid-session backup
#     - cron: '35 18 * * 1-5'   # 18:35 UTC (14:35 ET) — late-session backup
```

Leave the rest of the workflow alone — a manual `workflow_dispatch` remains the
emergency path if Railway is ever down.

---

## If Railway cron proves unreliable — the fallback

The cron design is the right default on cost and on overlap safety, but it is not
the only option. **Switch to an always-on worker** if, over a couple of weeks, you
see any of:

- cycles **skipped** regularly because a previous execution was still Active (the
  docs say Railway skips the new run in that case — so a hung cycle costs you every
  subsequent one until it clears);
- cycle start times drifting by **more than ~10 minutes** (Railway explicitly does
  not guarantee minute precision);
- cron runs silently not firing at all for a session.

The fallback is a small change: wrap `runCycle()` in a `setInterval` (15 minutes
in-hours / 30 minutes out-of-hours), drop the `process.exit(0)`, clear the **Cron
Schedule** field, and let it run as a normal worker. That is the shape Ironclad's
`railway-runner.js` already uses, so there is a working precedent in this repo. The
cost difference is the reason it is not the default: an always-on Node process
resident 24/7 adds a real multiple of the current Railway bill to run a strategy
that needs seconds of work per cycle.

---

## Notes on Railway's cron behaviour (from Railway's own docs, 2026-10-24)

Stated here because the design depends on it — if any of this changes, revisit the
decision:

- Cron Schedule lives in **service Settings**, and Railway "will … execute the start
  command for that service on the given schedule".
- Schedules are **UTC**.
- Scheduled runs must be **at least 5 minutes apart**; `*/15 * * * *` is given as a
  valid example.
- **Overlap:** "if a previous execution is still running when the next scheduled
  execution is due, Railway will skip the new cron job." This is why the service must
  exit cleanly — and it is also what makes the runner unable to race itself.
- **Precision:** "Railway does not guarantee execution times to the minute as they
  can vary by a few minutes."
- The service is expected to "exit as soon as that task is finished, not leaving any
  resources open".
- The docs present cron as the way to "save resources between executions, as opposed
  to having an in-code scheduler run 24/7" — which is the basis for expecting no idle
  billing between cycles. **Confirm that against the first month's actual bill**; it
  is the one cost assumption here that is inferred from the docs' intent rather than
  stated as a billing rule.
- The docs do **not** promise a retry on a non-zero exit. The runner therefore exits
  `0` whenever a cycle ran (letting the next tick retry transient failures) and
  reserves `exit 1` for a configuration error, so that shows up as a failed run.
  `SID/railway-sid.json` sets `restartPolicyType: NEVER` so a failing run cannot
  restart-loop.
