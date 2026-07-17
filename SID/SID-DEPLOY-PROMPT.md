# SID Swing Strategy — Guided First-Run Deployment Prompt (v2.3.0)

This is a **guided, interactive installer prompt** for the SID strategy — the RSI
mean-reversion swing bot for US stocks and ETFs that trades **Alpaca PAPER** on a
daily schedule via **GitHub Actions**, with a live dashboard on GitHub Pages.

It is written for a **first-time user with NOTHING set up yet**, deploying SID on
**their own PC, their own GitHub fork, and their own Alpaca paper account.** Copy
everything between the lines below and paste it into a **fresh Claude session.**
That Claude will then walk you through the whole setup one step at a time, pausing
after each step to wait for you, and prompting you for each secret (with a link to
where to get it) only at the moment that step needs it.

**Before you start — two ground rules baked into the prompt:**
- You never paste secret values into the chat or into any file. You type them
  straight into **GitHub's own Secrets UI** (and, only if you choose to run a local
  test, into your own git-ignored `.env`). Claude guides — you are the one who
  enters and stores every credential.
- Everything stays on **Alpaca PAPER** (simulated money). Going live is a separate,
  deliberate decision you make yourself later — it is not part of this template.

**Related prompt:** once you are set up and later want to pull a published SID
revision into your fork WITHOUT disturbing your trades, secrets, or account, use
the companion **`SID-UPDATE-PROMPT.md`** in this same folder.

---

```
You are going to walk me through deploying the SID Swing Strategy for the very
first time. Assume I have NOTHING set up yet — no repo forked, no accounts beyond
what you tell me to create, no API keys, no secrets. I am a first-time user, and
I am deploying this on MY OWN machine, into MY OWN GitHub fork, trading MY OWN
Alpaca PAPER account. Do not assume anything about your own environment, file
paths, or tooling — everything is on MY side.

Work through the numbered steps below IN ORDER. After EACH step, STOP and wait for
me to confirm it's done (or to give you the input you asked for) before you move to
the next step. Do not run ahead. Keep every command simple and copy-pasteable, and
tell me exactly what I should see after I run it. Whenever a command references my
repo, use the placeholders MY_USERNAME and MY_REPO — I will tell you my real values.

SECURITY RULES YOU MUST FOLLOW THE WHOLE WAY THROUGH (non-negotiable):
- NEVER ask me to paste a secret value (API key, secret key, token, chat id) into
  this chat, and NEVER write a secret into any file that gets committed.
- NEVER enter or store my credentials on my behalf. When a secret is needed, tell me
  WHERE to get it (give me the URL) and WHERE to put it (GitHub Secrets UI), then
  PAUSE and let ME enter it myself. You will never see the value, and that is correct.
- If at any point a local test needs credentials, they go ONLY into a local `.env`
  file that is git-ignored — confirm `.env` is in `.gitignore` BEFORE I put anything
  in it. Secrets are never committed, ever.
- Prompt me for each secret ONE AT A TIME, at the step that actually needs it — do
  not dump a big list of secrets up front.

────────────────────────────────────────────────────────
STEP 1 — GREETING + WHAT SID IS (read this to me, then PAUSE)
────────────────────────────────────────────────────────

Greet me and explain, in plain language:

- SID is a DAILY-timeframe RSI mean-reversion SWING strategy on US stocks and ETFs.
  It looks for stocks pushed to an RSI extreme (oversold below 30 / overbought
  above 70), waits for confirmation, enters in the mean-reversion direction, and
  exits as RSI returns toward the midpoint (50).
- It runs fully automated on GitHub Actions: once per weekday at 14:35 UTC (about 5
  minutes after the US market opens), the bot wakes, scans its 80-ticker universe,
  manages any open positions, and logs everything back to my repo.
- Execution is on Alpaca PAPER (simulated money) by default. A separate dashboard
  pipeline rebuilds a live web dashboard (hosted free on GitHub Pages) three times a
  trading day.

HONEST DISCLAIMER — say this clearly:
- This is PAPER / simulated trading. No real money is at risk in this template.
- The current version is v2.3.0. Its ENTRY logic (the v2.2.3 "entry overhaul") was
  validated on a 5-year backtest: 280 trades, 73.9% win rate, profit factor 3.19,
  +$31,426 — measured on the tier1 80-ticker universe over 5 years at a FIXED $200
  risk per trade. That is a BACKTEST under one specific sizing method, not a promise.
- IMPORTANT — live behaviour deliberately DIVERGES from that backtest, in two ways:
  (1) the live bot sizes with 1% compounding off its own internal ledger, NOT fixed
  $200 risk, so running P&L totals look different (same trades, different sizing);
  and (2) a short-approval gate (below) means bullish-asset shorts do NOT auto-fire
  live, whereas the backtest includes them firing mechanically. So do not expect the
  live equity curve to match the +$31,426 figure — that figure is the pure-mechanical
  ENTRY validation, and it is unchanged on purpose so you can always trace the delta.
- Past performance does NOT predict future results. This is NOT financial advice.
  You are responsible for your own decisions and your own capital.

Then tell me: "I'll pause after every step so you can confirm before we continue."
PAUSE and wait for me to say I'm ready.

────────────────────────────────────────────────────────
STEP 2 — PREREQUISITES CHECK
────────────────────────────────────────────────────────

Tell me to make sure I have these, and give me the simple verify command for each.
Have me run the verify commands and paste the output back to you:

1. Git — https://git-scm.com/downloads
   Verify:  git --version
2. Node.js 20 LTS — https://nodejs.org  (install the LTS build)
   Verify:  node --version     (should print v20.x.x)
3. Python 3.x — https://www.python.org/downloads  (only needed for the dashboard's
   price-scan step, which uses Python)
   Verify:  python --version   (or: python3 --version)
4. A free GitHub account — https://github.com
5. A free Alpaca PAPER account — https://app.alpaca.markets  (we'll generate the
   PAPER keys later, in Step 5 — don't do it yet).

If any verify command fails, help me install that one thing, then re-verify.
PAUSE until I confirm all five are in place.

────────────────────────────────────────────────────────
STEP 3 — FORK THE REPO + ENABLE ACTIONS
────────────────────────────────────────────────────────

Walk me through getting the code onto MY OWN GitHub account so the workflows run
under my account, not anyone else's:

1. Fork the source repo into my own GitHub account (GitHub's "Fork" button on the
   source repo page). This gives me MY_USERNAME/MY_REPO — my own independent copy.
2. Go to my fork on github.com -> Actions tab. On a fresh fork, GitHub disables
   workflows by default — click the green button to enable workflows for this fork.
3. Confirm I can see the workflows listed. The ones that matter for SID are:
   - "SID Swing Bot"  (.github/workflows/sid.yml) — the daily trading run
   - "SID Dashboard"  (.github/workflows/sid-dashboard.yml) — rebuilds the dashboard
   - (optional, only if I set up the Telegram approval add-on later)
     "SID Approve Trade"  (.github/workflows/sid-approve-trade.yml)
     and the manual one-shot helpers (sid-manual-trade.yml, etc.)

Explain that nothing will actually trade yet, because the Alpaca secrets aren't set —
the bot safely falls back to dry-run (log only) when its keys are missing. We add the
keys, clone the repo, and clean up its state in the next steps. PAUSE until I confirm
Actions are enabled on my fork and I can see the SID workflows.

────────────────────────────────────────────────────────
STEP 4 — CLONE MY FORK + INSTALL DEPENDENCIES
────────────────────────────────────────────────────────

Walk me through getting a local copy of MY fork and installing its dependencies:

1. Clone my fork (use my real username/repo in place of the placeholders):
   git clone https://github.com/MY_USERNAME/MY_REPO.git
   cd MY_REPO
2. Install the Node dependencies (the bot is Node.js) from the repo root:
   npm install
3. Install the Python dependencies used by the dashboard's price scanner. The
   manifest is SID/requirements.txt (it pins yfinance and pandas):
   pip install -r SID/requirements.txt

Tell me what a successful install looks like for each (npm prints an "added N
packages" line; pip prints "Successfully installed ..."). If `pip` isn't found, try
`pip3` / `python -m pip`. PAUSE until both installs succeed.

────────────────────────────────────────────────────────
STEP 5 — CLEAN-SLATE MY FORK'S TRADE STATE (do this once, right after cloning)
────────────────────────────────────────────────────────

CRITICAL for a fork: the repo I forked still contains the ORIGINAL author's live
trade state — their open positions, closed trades, account ledger, and run log. If
I leave those in place, my bot will try to "manage" positions that were never opened
on MY Alpaca account, and my dashboard will show someone else's history. I need to
reset the state files to a clean, empty slate that is MINE.

Walk me through resetting each SID STATE file. These live in the SID/ folder. Give me
copy-pasteable commands (run from the repo root). On Windows use Git Bash so these
POSIX commands work; on macOS/Linux the terminal is fine.

  # empty JSON arrays — no open positions, no closed history, no pending approvals
  echo "[]" > SID/open-positions-sid.json
  echo "[]" > SID/closed-positions-sid.json
  echo "[]" > SID/pending-approvals-sid.json
  echo "[]" > SID/sid-log.json

  # trade log — keep ONLY the header row (delete every data row)
  #   the exact header the bot expects is:
  #   Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy
  #   simplest safe method: keep just the first line of the existing file
  head -n 1 SID/trades-sid.csv > SID/trades-sid.csv.tmp && mv SID/trades-sid.csv.tmp SID/trades-sid.csv

Now the ACCOUNT LEDGER. The bot sizes off its own internal ledger in
SID/sid-account.json (1% compounding). Two clean options — pick ONE and tell me
which:

  OPTION A (recommended, simplest): delete the file. On the first run the bot
  auto-creates it, seeded from my SID_ACCOUNT_USD secret (or its internal default if
  I don't set that secret). We set SID_ACCOUNT_USD in Step 6.
       rm -f SID/sid-account.json

  OPTION B (seed it explicitly now to my chosen starting equity, e.g. 10000 — this
  should MATCH whatever I set SID_ACCOUNT_USD to in Step 6):
       cat > SID/sid-account.json <<'JSON'
{
  "accountUsd": 10000,
  "startingUsd": 10000,
  "realizedPnl": 0,
  "tradeCount": 0,
  "lastUpdated": "",
  "method": "v2.3.0",
  "mode": "paper",
  "resetReason": "Fresh fork — clean slate for my own paper account"
}
JSON

Two clarifications, say them clearly:
- I do NOT touch SID/scanner-sid.json or docs/sid/index.html. Those are BUILD OUTPUT
  — my "SID Dashboard" workflow regenerates them from live data on its next run, so
  any stale content there is harmless and gets overwritten.
- SID does NOT have a file called "safety-check-log.json" — its run/safety log IS
  SID/sid-log.json (already reset above). If you see a safety-check-log.json in the
  repo it belongs to a DIFFERENT strategy in the same repo, not SID; leave it alone.

Finally, stage and commit this clean slate to my fork so the workflows run against
it:
       git add SID/open-positions-sid.json SID/closed-positions-sid.json \
               SID/pending-approvals-sid.json SID/sid-log.json SID/trades-sid.csv \
               SID/sid-account.json
       git commit -m "chore: reset SID trade state to clean slate for my fork"
       git push origin main
  (If I chose OPTION A and deleted sid-account.json, `git add -A SID/` will stage the
   deletion too — use that instead.)

PAUSE until I confirm the state files are reset, committed, and pushed to my fork.

────────────────────────────────────────────────────────
STEP 6 — DISABLE THE NON-SID WORKFLOWS IN MY FORK
────────────────────────────────────────────────────────

CRITICAL for a fork: the source repo contains workflows for OTHER strategies that
share the repo. On my fork those will try to run against accounts/credentials I do
not have and will error (or, worse, do something I didn't intend). I only want the
SID workflows active.

Walk me through disabling every NON-SID workflow:
1. Go to my fork on github.com -> Actions tab.
2. In the left-hand list of workflows, for EACH workflow whose name does NOT start
   with "SID", open it, click the "..." menu (top-right of that workflow's page), and
   choose "Disable workflow". The non-SID ones to disable include:
     - Ironclad  (.github/workflows/ironclad.yml)
     - the VWAP scalper  (.github/workflows/trade.yml)
     - the research/dashboard for the other strategy  (.github/workflows/research.yml)
     - any "maven"* workflow  (.github/workflows/maven-paper.yml)
     - anything else that is NOT prefixed sid-*
3. KEEP ENABLED only the SID workflows:
     - sid.yml            (SID Swing Bot — required)
     - sid-dashboard.yml  (SID Dashboard — required)
     - sid-approve-trade.yml + sid-manual-trade.yml + any other sid-*.yml
       (optional helpers — keep if I might use the manual/approval flows)

Explain WHY: keeping the non-SID workflows enabled just means red X's in my Actions
tab and possible noise/failures on schedules I don't care about. Disabling them keeps
my fork clean and focused on SID. (I can always re-enable one later if I decide to
run that strategy too.) PAUSE until I confirm only the SID workflows are enabled.

────────────────────────────────────────────────────────
STEP 7 — ADD OUR REPO AS AN "upstream" REMOTE (for future updates)
────────────────────────────────────────────────────────

Set up the pipe that future SID updates flow through. My fork's default remote
("origin") points at MY copy. I add a SECOND remote called "upstream" pointing at
the ORIGINAL source repo, so that later I can pull published SID revisions from it
without leaving my fork.

From my repo root:
   git remote add upstream https://github.com/ballikov-lgtm/BotTrading.git
   git remote -v      # verify: origin -> my fork, upstream -> the source repo

Explain: I will NOT pull from upstream now. This is purely wiring for later — the
companion SID-UPDATE-PROMPT.md uses this "upstream" remote to pull only the strategy
CODE (never my trade state or secrets) when a new SID version is published. PAUSE
until I confirm `git remote -v` shows both origin and upstream.

────────────────────────────────────────────────────────
STEP 8 — ALPACA PAPER KEYS (prompt me, then I add them to GitHub Secrets)
────────────────────────────────────────────────────────

Now prompt me for the Alpaca PAPER credentials — but remember the security rules:
you tell me where to get them and where to put them, and I enter them myself. You
never see the values.

Tell me to do this:
1. Go to https://app.alpaca.markets and log into my account.
2. IMPORTANT: switch the account toggle to "Paper Trading" (top-left / account
   switcher). We are using PAPER, not live.
3. In the Paper Trading dashboard, find the API Keys panel and generate a new key.
   It shows me an API Key ID and a Secret Key. The Secret is shown ONCE — I copy it
   somewhere safe now (NOT into this chat, NOT into any committed file).
4. Now go to MY fork on github.com -> Settings -> Secrets and variables -> Actions
   -> "New repository secret", and add these secrets. The NAMES below must match
   exactly (these are the exact names the SID workflow reads):

   ALPACA_KEY_ID       <- my Alpaca PAPER API Key ID
   ALPACA_SECRET_KEY   <- my Alpaca PAPER Secret Key
   ALPACA_BASE_URL     <- https://paper-api.alpaca.markets   (the PAPER endpoint)
   SID_TRADING_MODE    <- paper
   SID_PAPER           <- true

   (Leave SID_LIVE_CONFIRMED unset — it's only needed to go live, which we are NOT
   doing. If ALPACA_KEY_ID / ALPACA_SECRET_KEY are ever unset, the bot automatically
   falls back to dry-run and places no orders, which is a safe default.)

Optional account/sizing secrets the workflow also reads — all have safe built-in
defaults, so I can SKIP these for a first run and add them later if I want to tune:
   SID_ACCOUNT_USD        starting equity the bot sizes off. If I chose Step 5
                          OPTION A (deleted the ledger), set this to my chosen
                          starting equity (e.g. 10000) so the fresh ledger seeds to
                          it. If I chose OPTION B, set it to the SAME number I seeded.
   SID_RISK_PCT           risk per trade as a fraction (e.g. 0.01 = 1%)
   SID_MAX_POS_PCT        max position size as a fraction of equity (e.g. 0.10)
   SID_MAX_POSITIONS      max concurrent open positions (default 5)
   SID_MAX_PER_DAY        max new entries per day
   SID_EARNINGS_WINDOW    earnings blackout window in days (strategy default is 14)
   SID_SHORT_APPROVAL_GATE
                          default ON. When ON (the safe default), a mechanical SHORT
                          on a long-term-bullish asset does NOT auto-fire — the bot
                          alerts me for approval instead (see Step 11). Set to false
                          ONLY if I explicitly want fully-mechanical bullish-asset
                          shorts (= pure-backtest behaviour). Leave it unset to keep
                          it ON.

Re-state: I add these in GitHub's UI myself; you do NOT want me to paste any value
into this chat. PAUSE until I confirm the Alpaca secrets (and mode=paper) are saved.

────────────────────────────────────────────────────────
STEP 9 — TELEGRAM ALERTS (OPTIONAL — skip if I don't want them)
────────────────────────────────────────────────────────

Tell me Telegram alerts are entirely OPTIONAL. If I skip them, the bot just runs
silently and trades normally — nothing breaks. Ask me whether I want them.

If I say YES, prompt me for these ONE AT A TIME (same security rules — I get them
myself and add them to GitHub Secrets; you never see the values). The NAMES must
match exactly what the SID workflow reads:

   TELEGRAM_BOT_TOKEN
   -> Open Telegram, message @BotFather, send /newbot, follow the prompts, and it
      gives me a bot token. I paste that token into the GitHub secret.

   TELEGRAM_CHAT_ID
   -> The numeric id of the chat the bot should message me in. Easiest way: message
      @userinfobot on Telegram and it replies with my id. (Alternative: after I've
      sent my bot a message, open
      https://api.telegram.org/bot<MY_BOT_TOKEN>/getUpdates in a browser and read
      the "chat":{"id":...} field.) I paste that id into the GitHub secret.

   TELEGRAM_ALERTS_ENABLED
   -> set to: true   (set it to false later if I ever want to mute alerts without
      deleting the secrets).

If I say NO, skip all three and move on. Either way, PAUSE before continuing.

────────────────────────────────────────────────────────
STEP 10 — GITHUB PAGES (the live dashboard)
────────────────────────────────────────────────────────

Walk me through turning on the dashboard:
1. My fork on github.com -> Settings -> Pages.
2. Source: "Deploy from a branch". Branch: main. Folder: /docs. Save.
3. After the dashboard workflow has run at least once, my SID dashboard will be live
   at:  https://MY_USERNAME.github.io/MY_REPO/sid/
   (note the /sid/ subpath — that's where the SID dashboard lives).

Explain the dashboard is rebuilt automatically three times each trading day by the
"SID Dashboard" workflow (pre-open, midday, post-close), and that it shows the
backtest headline plus my own live trades once they exist. It also shows the current
version and the release notes — those come from the code, so after any future update
(see SID-UPDATE-PROMPT.md) the dashboard's Updates tab automatically reflects exactly
what changed. PAUSE until Pages is enabled.

────────────────────────────────────────────────────────
STEP 11 — THE STRATEGY IN PLAIN ENGLISH (read it back, then ask if I'm happy)
────────────────────────────────────────────────────────

Before we run anything, explain the current rules to me in plain language so I can
confirm they match what I intend. Cover the entry stack, the exit model, and the
approval gate.

ENTRY STACK (the v2.2.3 entry overhaul — what has to be true to take a trade):
- RSI(14) extreme: the daily RSI must CROSS INTO an extreme to arm a setup — below
  30 to arm a LONG, above 70 to arm a SHORT. (Crossing-in, not merely "still in the
  zone", so a long downtrend doesn't re-arm every bar.)
- RSI(3) confirmation: the fast 3-period RSI must also be in the same extreme zone on
  the signal bar.
- Weekly SMA arm gate: the weekly 50/200 SMA relationship must agree with the trade
  direction (longs need the weekly uptrend regime; shorts the downtrend regime).
- 3-day arm timeout: once armed, the entry trigger must fire within 3 trading days,
  or the setup expires.
- Re-arm cooldown: after an arm expires, LONGS can re-arm freely (to catch fast
  V-shaped recoveries), but SHORTS must wait a 5-day cooldown (to avoid re-firing
  low-quality counter-trend repeats while a name is still recovering).
- RSI no-go zone at entry: rejects late entries — for a long, RSI must still be below
  45 at entry; for a short, still above 55 — so there's room to run to the RSI-50
  target before the partial.
- Weekly RSI OR weekly MACD direction must match the trade direction (trend filter).
- 14-day pre-earnings blackout: no new trade within 14 calendar days BEFORE an
  earnings date (pre-only — the day after earnings is allowed).
- Macro gates: a VIX gate (blocks new arming when fear is extreme) and a pre-PPI
  blackout.
- Universe: only the 80-ticker tier1 AUTO universe fires automatically.

EXIT MODEL (the v2.2.1 HYBRID model — how a position is managed once open):
- TP1 at RSI 50, routed by side:
  - LONGS use close-based RSI-50 (the bot waits for the daily candle to close past
    the RSI-50 level, which books a bigger partial because the bullish drift of US
    equities works in a long's favour).
  - SHORTS use intraday-touch RSI-50 (a resting GTC limit order sits at the exact
    price where RSI hits 50, so the partial is locked in the moment price touches it,
    before a round-trip against the short can take it back).
  - At TP1, close 50% of the position and move the stop on the remaining 50% to
    break-even.
- TP2 on the runner fires on whichever comes FIRST: the 50-day SMA, the 200-day SMA,
  the break-even stop being hit, or a 30-trading-day timeout since TP1.
- Stops are real broker GTC orders on Alpaca from the moment of entry, so the
  position is never unprotected. (The v2.2.5 and v2.2.6 releases fixed a live
  execution bug where the resting broker stop "held" the shares and blocked the TP1
  and TP2 partial/runner closes — now the bot cancels the resting stop FIRST, submits
  the close, confirms it filled, and raises a loud alert if it can't, so a close can
  never fail silently.)
- Concurrency: up to 5 positions open at once (default; SID_MAX_POSITIONS-overridable).
- Sizing compounds off the bot's own internal ledger (SID/sid-account.json), not
  Alpaca's paper equity, so the risk math is consistent regardless of the paper
  balance.

SHORT APPROVAL GATE (v2.2.4 — a live execution-discipline overlay, ON by default):
- A mechanical SHORT on a LONG-TERM-BULLISH asset (one where price > 200-day SMA AND
  50-day SMA > 200-day SMA) does NOT auto-fire. Instead the bot logs it and sends a
  Telegram alert so I can approve and enter it at a sensible level (e.g. into a supply
  zone) rather than mechanically below it.
- This is why LIVE behaviour deliberately diverges from the backtest: the backtest
  INCLUDES these bullish-asset shorts firing mechanically; the live bot gates them.
  Longs and non-bullish-asset shorts are unaffected and still auto-fire.
- Toggle: SID_SHORT_APPROVAL_GATE=false reverts to fully-mechanical bullish-asset
  shorts (= pure-backtest behaviour). Leave it ON (default) unless I have a reason.
- OPTIONAL advanced add-on (v2.3.0): I can wire up a one-tap Telegram [Approve]/[Skip]
  button flow via a small Cloudflare Worker, so tapping Approve enters the trade as a
  fully TRACKED bot position (full TP1/TP2 management). This is entirely optional and
  the bot works FULLY without it — without the Worker, the approval alert is simply
  an advisory message and I approve by firing the trade myself via the manual
  one-shot flow (sid-manual-trade.yml). If I want the button flow, the guided,
  self-service setup is in SID/approval-worker/README.md (create a free Cloudflare
  account, deploy the Worker, set the secrets, register the Telegram webhook). Do NOT
  set this up as part of first-run — note it and move on.

Then ask me: "Are you happy with these rules before we run?" PAUSE for my yes.

────────────────────────────────────────────────────────
STEP 12 — FIRST PAPER TEST RUN
────────────────────────────────────────────────────────

Run the bot once, in PAPER mode, the simplest way. The CLOUD path is preferred
because it needs NO local secrets (the keys live in MY GitHub Secrets):

PREFERRED — trigger the workflow in the cloud (workflow_dispatch):
   - Either from the GitHub UI: my fork -> Actions -> "SID Swing Bot" -> Run workflow.
   - Or from my terminal with the GitHub CLI:  gh workflow run sid.yml
   Then watch the run in the Actions tab.

ALTERNATIVE — run it locally (only if I WANT to, and only after I've created a
git-ignored .env myself with my Alpaca PAPER keys):
   - First confirm .env is in .gitignore (never commit it).
   - Then:  node SID/bot-sid.js

Either way, read the output back to me and explain:
   - which tickers it scanned (the 80-ticker tier1 universe),
   - whether anything ARMED or TRIGGERED a trade today (often nothing fires on a
     given day — that's normal and correct for a selective mean-reversion strategy),
   - if a paper order was placed: the symbol, side, share count, entry, and the GTC
     stop,
   - if a bullish-asset short was detected: it will be GATED for approval (logged +
     alerted, not auto-fired) — that's the approval gate working,
   - where it logged: SID/sid-log.json (run/safety log), SID/trades-sid.csv (trade
     log), SID/open-positions-sid.json and SID/closed-positions-sid.json (position
     state), SID/pending-approvals-sid.json (any gated shorts awaiting approval).

PAUSE and ask me whether I want to run again, adjust anything, or stop here.

────────────────────────────────────────────────────────
STEP 13 — GOING-LIVE CONSIDERATIONS (read this; do NOT flip anything)
────────────────────────────────────────────────────────

Make these points clearly, and do NOT change anything to live for me:

- PAPER FIRST. Let it run on paper and watch real signals accumulate before you even
  think about live money. A few weeks of paper validation is the sane minimum.
- The core strategy is CANON and must not be changed: RSI(14) 30/70 extremes, daily
  RSI + MACD direction alignment, the RSI-50 exit trigger, the 14-day pre-earnings
  blackout, and the 80-ticker AUTO universe are all LOCKED. Only minor confirmation
  tweaks (extra filters, sizing, exit refinements) are ever appropriate — never a
  change to those core rules.
- Only ever risk capital you can genuinely afford to lose. This is NOT financial
  advice and past backtest results do not predict the future.
- This template stays on Alpaca PAPER. Going live is entirely my own decision and my
  own responsibility — it would mean I, myself, fund a live Alpaca account and switch
  the configuration (point ALPACA_BASE_URL at the live endpoint, set
  SID_TRADING_MODE=live, and set SID_LIVE_CONFIRMED to its required confirmation
  value). You are NOT to do that for me as part of this setup.
- To pull a future published SID revision into my fork WITHOUT disturbing my trades,
  account ledger, or secrets, I use the companion SID-UPDATE-PROMPT.md (it pulls only
  the strategy CODE from the "upstream" remote I wired up in Step 7).

Finish by confirming setup is complete: the fork is mine, Actions are enabled, the
non-SID workflows are disabled, the trade state is a clean slate, the "upstream"
remote is wired, the Alpaca PAPER secrets are saved, the dashboard is live on GitHub
Pages, and the bot has done its first paper run.
```

---

**That's the whole guided installer.** Paste the block above (everything between the
triple backticks) into a fresh Claude session and follow along — it pauses after
each step and prompts you for each secret only when that step needs it.

**Optional — see the entries on a chart.** The TradingView visualiser lives in
`SID/pine/` (the most recent is `sid-strategy-v2.2.3.pine` for the entry overhaul,
and `sid-strategy-v2.2.1-hybrid.pine` for the hybrid exits). Load it into TradingView
(Pine Editor → paste the file → Add to chart) to watch SID's arm/trigger/exit logic
plotted on any of the 80 tickers. It's purely for visualisation — the live bot is the
GitHub Actions deployment you set up above.

**A note on the numbers.** The headline 280 trades / 73.9% WR / PF 3.19 / +$31,426 is
the **v2.2.3 ENTRY validation** — a 5-year backtest on the tier1 universe under
**fixed $200 risk per trade**, with bullish-asset shorts firing mechanically. The
live bot instead (a) sizes with **1% compounding off its own internal ledger** and
(b) **gates bullish-asset shorts** for approval. So its running P&L will look
different from that fixed-risk backtest figure — same entry logic, different sizing,
and one gated subset. Always note which sizing method a P&L number came from before
comparing.
