# SID Swing Strategy — Guided Update Prompt (pull a published revision into your fork)

This is a **guided, interactive prompt** for pulling a newly published SID revision
into **your own fork** WITHOUT touching your live trade state, your account ledger,
or any of your secrets. It refreshes the **strategy logic and the release notes
only** — your positions, closed trades, account balance, pending approvals, run log,
and every GitHub Secret are left exactly as they are.

Use this when the canonical SID dashboard's Updates tab (or the source repo's commit
log) shows a new version and you want your fork to run it.

**Prerequisites (from the fresh install):**
- You deployed SID with `SID-DEPLOY-PROMPT.md`, so your fork already has:
  - an `origin` remote pointing at YOUR fork, and
  - an `upstream` remote pointing at the SOURCE repo
    (`https://github.com/ballikov-lgtm/BotTrading.git`).
- The non-SID workflows in your fork are DISABLED (keep them that way after updating).

If you don't have the `upstream` remote yet, add it first:
`git remote add upstream https://github.com/ballikov-lgtm/BotTrading.git`

Copy everything between the lines below and paste it into a **fresh Claude session.**

---

```
You are going to walk me through updating my existing SID Swing Strategy fork to a
newly published revision. I already have SID deployed on MY OWN machine, in MY OWN
GitHub fork (MY_USERNAME/MY_REPO), trading MY OWN Alpaca PAPER account. My fork has
an "origin" remote (my fork) and an "upstream" remote (the source repo). Do not
assume anything about your own environment or file paths — everything is on MY side.

This update must refresh the STRATEGY LOGIC and RELEASE NOTES only. It must NOT touch
my trade state, my account ledger, my pending approvals, my run log, my dashboard
build output, my local .env, or any of my GitHub Secrets. Those are MINE and stay
exactly as they are.

Work through the numbered steps below IN ORDER. After EACH step, STOP and wait for me
to confirm it's done before you move to the next step. Do not run ahead. Keep every
command simple and copy-pasteable, and tell me exactly what I should see.

SECURITY RULES (non-negotiable, same as the install):
- This process only pulls CODE from the "upstream" source repo. It NEVER touches,
  reads, or changes any secret. You will never ask me for a secret value, because
  updating code needs none.
- You will NEVER check out any of my STATE files from upstream (see the explicit lists
  in Step 3). Doing so would overwrite my own trades/account with someone else's — the
  single most important rule of this whole process.

────────────────────────────────────────────────────────
STEP 1 — CONFIRM AN UPDATE EXISTS + WHAT CHANGED
────────────────────────────────────────────────────────

First, check whether there's actually a new SID revision to pull, and summarise it
for me before we change anything.

1. Fetch the latest from the source repo (this downloads but does NOT apply anything):
      git fetch upstream
2. Show me what has changed in SID on upstream since my fork last updated:
      git log upstream/main --oneline -- SID/ | head -n 30
3. Show me the SID release-notes changes specifically (this is the human-readable
   changelog the dashboard uses), so I can read the summary of the new version:
      git diff HEAD upstream/main -- SID/strategy-updates.json SID/SID-README.md

Read me back: the new version number, a one-paragraph plain-English summary of what
changed, and whether it's a signal-logic change or execution/infra/docs only. If
there is NOTHING new (the log is empty / the diff is empty), tell me I'm already up to
date and STOP here. Otherwise PAUSE and ask me to confirm I want to proceed.

────────────────────────────────────────────────────────
STEP 2 — MAKE SURE MY WORKING TREE IS CLEAN FIRST (avoid clobbering local edits)
────────────────────────────────────────────────────────

Checking files out from upstream will OVERWRITE my local copy of those code files. If
I have any uncommitted local edits to SID code, I could lose them. Guard against that.

1. Check for uncommitted changes:
      git status
2. If the working tree is clean (nothing to commit) — good, continue to Step 3.
3. If I have uncommitted local edits, help me decide:
   - If they're edits I want to KEEP: commit them first
        git add -A && git commit -m "chore: my local changes before SID update"
     (or stash them: `git stash push -m "pre-SID-update"` and I can `git stash pop`
      afterwards — but be aware a pop can conflict with the incoming update).
   - If they're throwaway: discard them (`git checkout -- <file>`), but only the ones
     I'm sure about.
   NOTE: my STATE files (positions, account, trades, log, pending approvals) may show
   as "modified" simply because my bot has been trading — that's expected and correct.
   We are NOT going to check those out from upstream (Step 3), so they're safe; just
   don't discard them.

PAUSE until I confirm my working tree is in a state I'm happy with (clean, or my
wanted edits are committed/stashed).

────────────────────────────────────────────────────────
STEP 3 — CHECK OUT ONLY THE CODE FILES FROM UPSTREAM (never the state files)
────────────────────────────────────────────────────────

This is the heart of the update. We check out the CODE files from upstream/main into
my working tree, and we DELIBERATELY leave every STATE file untouched.

FIRST, read me both lists so I understand the split, then run the checkout.

CODE — safe to check out from upstream (this is the strategy logic + release notes +
workflows + docs; overwriting my copies with upstream's is exactly what an update is):
   SID/bot-sid.js
   SID/scan-sid.js
   SID/sid-dashboard.js
   SID/alpaca-executor.js
   SID/alpaca-client.js
   SID/telegram-alerts.js
   SID/approve-trade.js
   SID/manual-trade.js
   SID/manual-close.js
   SID/rsi-target-price.js
   SID/watchlist-sid.json
   SID/asset-classification.json
   SID/event-dates.json
   SID/strategy-updates.json
   SID/requirements.txt
   SID/strategy-audit.js
   SID/SID-README.md
   SID/CLAUDE.md
   SID/SID-DEPLOY-PROMPT.md
   SID/SID-UPDATE-PROMPT.md
   SID/pine/            (whole folder — TradingView visualisers)
   SID/approval-worker/ (whole folder — Cloudflare Worker + its setup README)
   package.json         (root — shared Node deps)
   .github/workflows/sid.yml
   .github/workflows/sid-dashboard.yml
   .github/workflows/sid-approve-trade.yml
   .github/workflows/sid-manual-trade.yml
   (and any other .github/workflows/sid-*.yml that exists on upstream)

STATE — NEVER check out from upstream (these are MY live data + build output; pulling
upstream's copies would overwrite my trades/account/dashboard with someone else's):
   SID/open-positions-sid.json
   SID/closed-positions-sid.json
   SID/sid-account.json
   SID/sid-log.json
   SID/trades-sid.csv
   SID/pending-approvals-sid.json
   SID/scanner-sid.json          (my dashboard's scan output — regenerated by my run)
   docs/sid/index.html           (my dashboard build output — regenerated by my run)
   .env                          (local, git-ignored — never in git anyway)
   ...and every GitHub Secret     (not files — nothing here can touch them)

  NOTE: SID does not have a "safety-check-log.json" — its run/safety log IS
  SID/sid-log.json (in the STATE list above). Any safety-check-log.json in the repo
  belongs to a DIFFERENT strategy; leave it alone.

Now run the checkout — list the CODE paths explicitly so nothing else can be touched.
(Only include a path if it actually exists on upstream; if `git checkout` complains a
path doesn't exist upstream, drop that one and continue.)

   git checkout upstream/main -- \
     SID/bot-sid.js SID/scan-sid.js SID/sid-dashboard.js SID/alpaca-executor.js \
     SID/alpaca-client.js SID/telegram-alerts.js SID/approve-trade.js \
     SID/manual-trade.js SID/manual-close.js SID/rsi-target-price.js \
     SID/watchlist-sid.json SID/asset-classification.json SID/event-dates.json \
     SID/strategy-updates.json SID/requirements.txt SID/strategy-audit.js \
     SID/SID-README.md SID/CLAUDE.md SID/SID-DEPLOY-PROMPT.md SID/SID-UPDATE-PROMPT.md \
     SID/pine SID/approval-worker package.json \
     .github/workflows/sid.yml .github/workflows/sid-dashboard.yml \
     .github/workflows/sid-approve-trade.yml .github/workflows/sid-manual-trade.yml

Then confirm the split held:
   git status
   -> I should see the CODE files staged as modified, and NONE of my STATE files
      (positions/account/trades/log/pending/scanner/docs-sid) in the list. If a STATE
      file somehow appears, STOP and tell me — we do not commit it.

PAUSE until I confirm the diff shows only code/docs/workflows changed, not my state.

────────────────────────────────────────────────────────
STEP 4 — RE-INSTALL DEPENDENCIES IF THEY CHANGED (only if package.json / requirements moved)
────────────────────────────────────────────────────────

If the update touched package.json or SID/requirements.txt, refresh the installs so
the new code has what it needs:
   - If package.json changed:            npm install
   - If SID/requirements.txt changed:    pip install -r SID/requirements.txt

If neither changed (the `git status` from Step 3 doesn't list them), SKIP this step.
PAUSE until I confirm.

────────────────────────────────────────────────────────
STEP 5 — COMMIT + PUSH THE UPDATE TO MY FORK
────────────────────────────────────────────────────────

Commit the code update (state files are untouched, so they won't be in this commit),
using the new version number from Step 1:
   git add -A
   git commit -m "chore: update SID to <VERSION>"     (e.g. chore: update SID to v2.3.0)
   git push origin main

If the push is rejected as non-fast-forward (because my own bot/dashboard workflows
committed state in the meantime), rebase on my own fork first, then push:
   git pull --rebase --autostash origin main
   git push origin main
If the rebase reports a conflict on one of MY state files, keep MY version (mine is
authoritative for my account) and continue the rebase. It should not conflict on code
files — those we just replaced wholesale from upstream.

PAUSE until I confirm the push succeeded.

────────────────────────────────────────────────────────
STEP 6 — CONFIRM NON-SID WORKFLOWS ARE STILL DISABLED
────────────────────────────────────────────────────────

The update may have pulled in new or changed workflow files. Re-check that ONLY the
SID workflows are enabled in my fork:
1. My fork on github.com -> Actions tab.
2. Confirm every workflow whose name does NOT start with "SID" is still Disabled
   (Ironclad / the VWAP scalper / the other strategy's research / any maven* / etc.).
   If the update ADDED a new non-SID workflow, disable it.
3. Confirm the SID workflows are enabled: sid.yml, sid-dashboard.yml, and any sid-*
   helpers I use.

PAUSE until I confirm only the SID workflows are enabled.

────────────────────────────────────────────────────────
STEP 7 — LET THE DASHBOARD REBUILD + VERIFY THE RELEASE NOTES
────────────────────────────────────────────────────────

Because SID/strategy-updates.json is part of the CODE we just pulled, my own
dashboard will now show the new version and its release notes on the next rebuild.
This is a mandatory convention for SID: the dashboard release notes ALWAYS reflect
the deployed version, so anyone reading my dashboard sees exactly what changed.

1. Trigger the dashboard rebuild (or wait for its next scheduled run):
      gh workflow run sid-dashboard.yml
   (or: my fork -> Actions -> "SID Dashboard" -> Run workflow)
2. Once it finishes, open my dashboard:
      https://MY_USERNAME.github.io/MY_REPO/sid/
   and check that the version markers and the Updates tab now show the new version
   and its notes.

Explain what changed in the strategy in plain language (from the Step 1 summary), and
remind me: my positions, account ledger, trades, pending approvals, run log, and all
my secrets were NOT touched — only the strategy logic and release notes were updated.

────────────────────────────────────────────────────────
STEP 8 — WRAP-UP
────────────────────────────────────────────────────────

Confirm the update is complete:
- My fork now runs the new SID version (code + workflows + release notes updated).
- My trade state, account ledger, and secrets are unchanged.
- The non-SID workflows are still disabled.
- The dashboard shows the new version and its Updates entry.

Tell me I can re-run this same prompt any time a newer SID revision is published (I'll
know because the canonical SID dashboard's Updates tab shows it, or `git fetch
upstream && git log upstream/main --oneline -- SID/` shows new commits).
```

---

**How you'll know an update exists.** Watch the canonical SID dashboard's **Updates
tab** (it lists every published revision with a category badge and summary), or from
your fork run:

```
git fetch upstream
git log upstream/main --oneline -- SID/
```

New commits under `SID/` since your last update mean there's something to pull.

**The one rule to remember.** This process pulls **CODE only**. Your positions,
closed trades, account ledger (`sid-account.json`), pending approvals, run log
(`sid-log.json`), trade CSV, dashboard build output (`docs/sid/index.html`), local
`.env`, and every GitHub Secret are **yours and are never overwritten**. If a `git
status` during the update ever shows one of those state files staged for commit,
stop — you're about to overwrite your own data.
