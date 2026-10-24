# SID on Railway — deploy guide (v2.6.1)

**What this gives you:** SID stops depending on GitHub Actions crons, which have been
landing **~3 hours late** (the 14:35 UTC run arriving ~18:15, the 18:35 run ~21:10).
Railway's cron is documented as varying only *"by a few minutes"*. Combined with
v2.6.0's queue-for-open exits, a ripe exit now either fires in-session or is handed
to Alpaca to execute at the next open — it can no longer sit for days.

**New in v2.6.1 — the entry scan happens in the last few minutes of the session.**
See [§ 5a The close window](#5a-the-close-window-v261--entries-only) for the whole
story, the three new variables, and why the cron expression does **not** need
changing. Nothing about *which* trades fire changed; only *when the bot looks*.

**⚠ ONE-TIME DEPLOY ACTION for v2.6.1: if `SID_MAX_PER_DAY` is set to `1` anywhere
(GitHub Secrets, or this service's Variables), DELETE it.** v2.6.1 removes the daily
entry cap — the only position limit is now **5 concurrent open positions** — but an
explicitly set value still wins over the new default and would keep throttling
entries to one a day in the cloud.

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
| `SID_ACCOUNT_USD`, `SID_RISK_PCT`, `SID_MAX_POS_PCT`, `SID_MAX_POSITIONS`, `SID_EARNINGS_WINDOW`, `SID_PAPER` | Strategy config. Leave unset to use the same defaults `sid.yml` runs on. **If you set any of these here, set the same value in GitHub Secrets** while both runners are live. `SID_MAX_POSITIONS` defaults to **5** and is the *only* position limit — see `SID_MAX_PER_DAY` below. |
| `SID_QUEUE_EXITS_FOR_OPEN` | `false` disables v2.6.0 queue-for-open exits (back to "refuse and retry next run"). |
| `SID_WEEKEND_EXIT_QUEUE` | `false` restores the old hard weekend stop (no position management at all Sat/Sun). |
| `SID_CLOSE_WINDOW_MIN` | **v2.6.1.** How close to the closing bell a cycle must start for it to be *the* entry cycle. **Default 20** (minutes). Must be at least as long as your cron interval or no tick will land inside it — see § 5a. `0` disables entry scans on this service entirely (exits are still managed every cycle). |
| `SID_ENTRY_SUBMIT_OFFSET_MIN` | **v2.6.1.** How many minutes before the close the entry scan actually runs. **Default 3.** Raise it (e.g. `15`) if you ever see the bot still scanning when the bell goes — it is a one-variable change, no redeploy of logic. |
| `SID_MAX_ENTRY_WAIT_MIN` | **v2.6.1.** Hard ceiling on a single wait, in minutes. **Default 30.** Belt-and-braces only; the wait is already bounded by the window. Exists so a fat-fingered `SID_CLOSE_WINDOW_MIN=600` cannot pin the container for ten hours. |
| `SID_MAX_PER_DAY` | **v2.6.1: now OFF by default.** An *optional* manual throttle on NEW ENTRIES per calendar day. Leave it unset (or `0`) for **no daily cap** — which is the intended configuration. The only position limit is `SID_MAX_POSITIONS` (5 concurrent). **⚠ If this is currently set to `1` in GitHub Secrets or here, DELETE it** — a set value still applies and will keep throttling entries regardless of the new default. |
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

### ✅ DOES THE CRON EXPRESSION NEED CHANGING FOR v2.6.1? **No.**

`*/15 13-23 * * 1-5` already lands a tick inside the close window in **both** DST
regimes and on the half-day sessions. Worked through, with the window at its default
20 minutes:

| Session | Close (ET) | Close (UTC) | Window (UTC) | Tick that lands inside |
|---|---|---|---|---|
| EDT, normal | 16:00 | **20:00** | 19:40–20:00 | **19:45** (hour 19 ∈ `13-23`) ✅ |
| EST, normal | 16:00 | **21:00** | 20:40–21:00 | **20:45** (hour 20 ∈ `13-23`) ✅ |
| EDT, early close | 13:00 | 17:00 | 16:40–17:00 | 16:45 ✅ |
| EST, early close (e.g. **2026-11-27**, confirmed in Alpaca's calendar as `close: 13:00`) | 13:00 | **18:00** | 17:40–18:00 | **17:45** ✅ |

The reason it works everywhere is structural: a half-open window of 15 minutes or
more always contains at least one quarter-hour mark, whatever the close time is. The
runner never reads the schedule — it asks `/v2/clock` for `next_close` — so the
November DST switch needs no change here either.

**The one rule to respect: `SID_CLOSE_WINDOW_MIN` must be ≥ your cron interval.** At
exactly 15 there is zero margin, and Railway explicitly does not guarantee minute
precision, so a tick that fires "a few minutes late" could land past the submit
point. The default of **20** gives 5 minutes of slack. If you ever shorten the
window below 15 on a `*/15` cron, some days will have **no** entry scan at all.

**Optional redundancy: `SID_CLOSE_WINDOW_MIN=35`.** That makes the window span TWO
ticks (19:30 and 19:45 in EDT). The first one to land claims the slot and waits;
Railway's overlap rule then **skips** the second, so you still get exactly one entry
scan at T-3 — but if the first tick is ever skipped or dies, the second covers for
it. Costs an extra ~15 minutes of wait per trading day (see the cost note below).

---

## 5a. The close window (v2.6.1) — entries only

**Why:** `bot-sid.js` defines an entry as `entry = close`. The strategy enters on the
**signal bar's close**, so a run at 14:15 ET is judging an unfinished daily bar — the
RSI, the MACD direction and the entry price all come from whatever the last trade
happened to be at that moment. Measured on three real SID entries, the price the bot
booked as "the close" was **0.48% / 0.49% / 0.03%** away from that day's actual close;
on a trade whose stop sits ~2.7% below entry, half a percent is ~18% of the risk unit.

And the scheduling was worse: over the 25 trading days to 2026-10-23, **seven (28%)
had no `sid.yml` run land inside market hours at all**, so an entry was impossible
regardless of signal.

**What the runner now does, every cycle:**

| `/v2/clock` says | Cycle |
|---|---|
| Market **closed** (or clock unreadable) | CHEAP — `SID_EXITS_ONLY=true`. Reconcile + queue ripe exits. No entry scan. |
| Market **open**, more than `SID_CLOSE_WINDOW_MIN` to the close | CHEAP — exits managed, **no entry scan** |
| Market **open**, inside the window | **WAIT** to `SID_ENTRY_SUBMIT_OFFSET_MIN` before the close, **re-read the clock**, then FULL cycle (exits **and** entry scan) |

So entries are evaluated **once per trading day, ~3 minutes before the bell**, against
a bar that is effectively the closing bar. Exits are unchanged — they are managed on
every cycle and v2.6.0's queue-for-open still covers anything that ripens after hours.

**What happens to the cron tick that would fire during the wait: Railway skips it.**
("If a previous execution is still running when the next scheduled execution is due,
Railway will skip the new cron job.") That is fine, and it is the overlap guard doing
its job:

- the skipped tick would have been an **exit** cycle, and the waiting cycle runs exit
  management itself when it wakes — still in-hours, just later;
- SID's exits are **daily-bar** triggers (RSI 50, SMA50/200 touch), so reading them at
  T-3 is *more* faithful than at T-18, not less;
- intraday protection never depended on the bot running: the stop is a resting GTC
  order at the broker for the whole wait;
- anything still ripe after the bell is queued for the next open by the first
  post-close tick.

It also means the window can never produce two entry scans in one session.

**The wait is safe by construction, not by hope.** It is bounded three ways (the
window, `SID_MAX_ENTRY_WAIT_MIN`, and `minutes-to-close − 1` so it always wakes at
least a minute before the bell); the clock is **re-read** on waking, and if the market
has closed, halted out, had its early close moved, or the clock became unreadable, the
entry scan is **abandoned** rather than fired into a shut market; and it sleeps **at
most once** per cycle.

**Cost.** One ~12-minute wait per trading day ≈ 250 container-minutes a month at
~60–80 MB. On Railway's published $10/GB-month memory rate that is **under 1p a
month** (0.08 GB × 250 min × $10/GB/30d/24h/60m ≈ $0.007), and a sleeping process
uses essentially no vCPU. The 35-minute-window option roughly doubles it — still
pennies. (Same caveat as v2.6.0: that a cron service bills no *idle* time between
runs is inferred from the docs' intent, so **check the first month's actual bill**.)

**How to tell it is working, from the logs:**

```
-- Market clock -- is_open=true now=2026-11-03T15:45:…-05:00 next_close=2026-11-03T16:00:00-05:00
   Market OPEN — 15m to the close — waiting 12m to T-3 so the bar being judged is effectively the closing bar

-- Close window -- waiting 12m (to ET 15:57, close ET 16:00) before the entry scan
-- Market clock (re-read after the wait) -- is_open=true now=2026-11-03T15:57:…-05:00 …
   2m to the close, already at/past T-3 — scanning for entries NOW

-- Cycle type -- FULL (position management + ENTRY SCAN) [scan_now]
```

Every other cycle of the day should read
`-- Cycle type -- CHEAP (SID_EXITS_ONLY — position management only) [pre_window]`
or `[closed]`. If you **never** see a `FULL` cycle, the window is mis-tuned (or the
in-window tick is being skipped by a hung previous cycle) and the bot will take no
entries at all.

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
-- Market clock -- is_open=true now=2026-10-24T14:15:…-04:00 next_close=2026-10-24T16:00:00-04:00
   Market OPEN — 105m to the close, outside the 20m close window — exits only, no entry scan

-- Cycle type -- CHEAP (SID_EXITS_ONLY — position management only) [pre_window]

-- Running bot-sid.js --
══ SID Bot run 2026-10-24T18:15:…
[Alpaca] Account snapshot refreshed: equity $100,543.43 …
…
══ SID run complete — 0 new trade(s) ══

-- Pushing changed state to main --
  ^ SID/alpaca-account-sid.json -> main
  -- state push: 1 written, 6 unchanged, 0 failed --

==============================================================
  Cycle complete in 41.3s — market=OPEN cycle=CHEAP (pre_window) bot=ok pushed=1 failed=0
==============================================================
```

**The six things to check, in order:**

1. `Mode: PAPER` — not `DRY_RUN`, not `LIVE`.
2. An `Entries: close window 20m, scan at T-3m, …` line with no `WARNING` under it.
3. A `Market clock` line with a real `is_open=` — if it says *clock unavailable*,
   the Alpaca variables are wrong and every cycle will take the cheap path.
4. `══ SID Bot run` appears — the bot itself actually ran.
5. `state push: … 0 failed` — the GitHub token works. (On a dry-push cycle this
   reads `0 written, N skipped (M of them dry-push)` — that is correct, nothing was
   sent.)
6. The run **ends** (`Cycle complete`) and the deployment stops being Active.
   A cron run that never exits makes Railway **skip every subsequent run**.
   *Exception:* the one in-window cycle per day is Active for the length of its
   wait (~12 minutes by default) — look for the `-- Close window -- waiting …`
   line before assuming it has hung.

**And once a day, check the one that matters:** exactly ONE cycle per trading day
should report `cycle=FULL` with phase `[scan_now]` (or `[wait_then_scan]`). That is
the entry cycle. No `FULL` cycle at all means no entries are possible that day.

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
| Turn off only the v2.6.1 close-window entries, keep everything else | Set `SID_CLOSE_WINDOW_MIN=0`. Railway then manages exits only and never scans for entries; the Actions crons keep taking entries as before. No code change. |
| The bot is still scanning when the bell goes | Raise `SID_ENTRY_SUBMIT_OFFSET_MIN` (try `5`, then `15`). Nothing else needs touching. |
| No `cycle=FULL` appears on any day | The in-window tick is not landing. Check `SID_CLOSE_WINDOW_MIN` ≥ your cron interval, and that no previous cycle is hanging (Railway skips a tick while one is Active). |

---

## What runs where, during Phase 1

| | GitHub Actions (`sid.yml`) | Railway cron (`sid-bot`) |
|---|---|---|
| Schedule | 14:35 / 16:35 / 18:35 UTC, Mon–Fri | `*/15 13-23 * * 1-5` UTC |
| Punctuality | best-effort; **observed hours late** | Railway: varies "by a few minutes" |
| Out-of-hours cycles | no | yes (cheap, exits only) |
| Entry scan | yes, whenever the run happens to land in-hours | **only in the close window, at T-3 (v2.6.1)** |
| State commit message | `SID run …` | `SID railway run …` |

**⚠ Phase-1 asymmetry worth knowing about.** The close-window discipline lives in the
**Railway runner's timing**, not in `bot-sid.js`, so a GitHub Actions run still scans
for entries at whatever time it lands — which is the old mid-session behaviour, on an
unfinished bar. That is deliberate for Phase 1 (the Actions crons are the fallback and
must keep working), and it is one more reason to get to Phase 2. Until then, an entry
can still be taken mid-session by Actions; the per-day cap and the open-symbol check
stop the two runners duplicating a position, and the entry `client_order_id` makes a
simultaneous duplicate impossible at the broker.

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
- **(v2.6.1)** a `cycle=FULL` close-window cycle on **every** trading day in the
  window you are reviewing — i.e. the entry scan is reliably getting its slot;
- **(v2.6.1)** at least one entry actually taken from a close-window cycle, with the
  recorded entry price close to that day's official close (that is the whole point of
  the change, and it is the thing the Actions crons were getting wrong);
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
