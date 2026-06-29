# SID Swing Strategy — Guided First-Run Deployment Prompt (v2.2.3 ENTRY OVERHAUL)

This is a **guided, interactive installer prompt** for the SID strategy — the RSI
mean-reversion swing bot for US stocks and ETFs that trades **Alpaca PAPER** on a
daily schedule via **GitHub Actions**, with a live dashboard on GitHub Pages.

It is written for a **first-time user with NOTHING set up yet.** Copy everything
between the lines below and paste it into a **fresh Claude session.** That Claude
will then walk you through the whole setup one step at a time, pausing after each
step to wait for you, and prompting you for each secret (with a link to where to
get it) only at the moment that step needs it.

**Before you start — two ground rules baked into the prompt:**
- You never paste secret values into the chat or into any file. You type them
  straight into **GitHub's own Secrets UI** (and, only if you choose to run a local
  test, into your own git-ignored `.env`). Claude guides — you are the one who
  enters and stores every credential.
- Everything stays on **Alpaca PAPER** (simulated money). Going live is a separate,
  deliberate decision you make yourself later — it is not part of this template.

---

```
You are going to walk me through deploying the SID Swing Strategy for the very
first time. Assume I have NOTHING set up yet — no repo cloned, no accounts beyond
what you tell me to create, no API keys, no secrets. I am a first-time user.

Work through the numbered steps below IN ORDER. After EACH step, STOP and wait for
me to confirm it's done (or to give you the input you asked for) before you move to
the next step. Do not run ahead. Keep every command simple and copy-pasteable, and
tell me exactly what I should see after I run it.

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
  manages any open positions, and logs everything back to the repo.
- Execution is on Alpaca PAPER (simulated money) by default. A separate dashboard
  pipeline rebuilds a live web dashboard (hosted free on GitHub Pages) three times a
  trading day.

HONEST DISCLAIMER — say this clearly:
- This is PAPER / simulated trading. No real money is at risk in this template.
- The current version is v2.2.3 (the "entry overhaul"). Its 5-year backtest result
  is 280 trades, 73.9% win rate, profit factor 3.19, +$31,426 — measured on the
  tier1 80-ticker universe over 5 years at a FIXED $200 risk per trade. That is a
  BACKTEST under one specific sizing method, not a promise.
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
STEP 3 — GET THE CODE + INSTALL DEPENDENCIES
────────────────────────────────────────────────────────

Walk me through getting a local copy of the project and installing its dependencies:

1. Have me clone my own copy of the repo (in Step 4 I'll create/fork it — if I
   already have a fork, clone that; the command pattern is):
   git clone https://github.com/MY_USERNAME/MY_REPO.git
   cd MY_REPO
2. Install the Node dependencies (the bot is Node.js):
   npm install
3. Install the Python dependencies used by the dashboard's price scanner. The
   manifest is SID/requirements.txt (it pins yfinance and pandas):
   pip install -r SID/requirements.txt

Tell me what a successful install looks like for each (npm prints an "added N
packages" line; pip prints "Successfully installed ..."). If `pip` isn't found, try
`pip3` / `python -m pip`. PAUSE until both installs succeed.

────────────────────────────────────────────────────────
STEP 4 — CREATE / FORK THE GITHUB REPO + ENABLE ACTIONS
────────────────────────────────────────────────────────

Walk me through getting the code onto MY GitHub account so the workflows can run:

1. Either fork the source repo into my own account, or create a new repo and push
   the files into it. Recommend fork if I'm starting from someone else's copy.
2. Once it's my repo, go to the repo on github.com -> Actions tab. If Actions are
   disabled on a fresh fork, click the button to enable workflows for this fork.
3. Confirm I can see the workflows listed — at minimum:
   - "SID Swing Bot"  (.github/workflows/sid.yml) — the daily trading run
   - "SID Dashboard"  (.github/workflows/sid-dashboard.yml) — rebuilds the dashboard

Explain that nothing will actually trade yet, because the Alpaca secrets aren't set —
the bot safely falls back to dry-run (log only) when its keys are missing. We add the
keys next. PAUSE until I confirm Actions are enabled and I can see both workflows.

────────────────────────────────────────────────────────
STEP 5 — ALPACA PAPER KEYS (prompt me, then I add them to GitHub Secrets)
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
4. Now go to my repo on github.com -> Settings -> Secrets and variables -> Actions
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
   SID_ACCOUNT_USD     starting equity the bot sizes off (defaults internally)
   SID_RISK_PCT        risk per trade as a fraction (e.g. 0.01 = 1%)
   SID_MAX_POS_PCT     max position size as a fraction of equity (e.g. 0.10)
   SID_MAX_POSITIONS   max concurrent open positions
   SID_MAX_PER_DAY     max new entries per day
   SID_EARNINGS_WINDOW earnings blackout window in days (strategy default is 14)

Re-state: I add these in GitHub's UI myself; you do NOT want me to paste any value
into this chat. PAUSE until I confirm the Alpaca secrets (and mode=paper) are saved.

────────────────────────────────────────────────────────
STEP 6 — TELEGRAM ALERTS (OPTIONAL — skip if I don't want them)
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
STEP 7 — GITHUB PAGES (the live dashboard)
────────────────────────────────────────────────────────

Walk me through turning on the dashboard:
1. Repo on github.com -> Settings -> Pages.
2. Source: "Deploy from a branch". Branch: main. Folder: /docs. Save.
3. After the dashboard workflow has run at least once, my SID dashboard will be live
   at:  https://MY_USERNAME.github.io/MY_REPO/sid/
   (note the /sid/ subpath — that's where the SID dashboard lives).

Explain the dashboard is rebuilt automatically three times each trading day by the
"SID Dashboard" workflow (pre-open, midday, post-close), and that it shows the
backtest headline plus any live trades once they exist. PAUSE until Pages is enabled.

────────────────────────────────────────────────────────
STEP 8 — THE STRATEGY IN PLAIN ENGLISH (read it back, then ask if I'm happy)
────────────────────────────────────────────────────────

Before we run anything, explain the v2.2.3 rules to me in plain language so I can
confirm they match what I intend. Cover BOTH the entry stack and the exit model:

ENTRY STACK (v2.2.3 entry overhaul — what has to be true to take a trade):
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

EXIT MODEL (v2.2.1 HYBRID — how a position is managed once open):
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
  position is never unprotected.
- Sizing compounds off the bot's own internal ledger (not Alpaca's paper equity), so
  the risk math is consistent regardless of the paper balance.

Then ask me: "Are you happy with these rules before we run?" PAUSE for my yes.

────────────────────────────────────────────────────────
STEP 9 — FIRST PAPER TEST RUN
────────────────────────────────────────────────────────

Run the bot once, in PAPER mode, the simplest way. The CLOUD path is preferred
because it needs NO local secrets (the keys live in GitHub Secrets):

PREFERRED — trigger the workflow in the cloud (workflow_dispatch):
   - Either from the GitHub UI: repo -> Actions -> "SID Swing Bot" -> Run workflow.
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
   - where it logged: SID/sid-log.json (run log), SID/trades-sid.csv (trade log),
     SID/open-positions-sid.json and SID/closed-positions-sid.json (position state).

PAUSE and ask me whether I want to run again, adjust anything, or stop here.

────────────────────────────────────────────────────────
STEP 10 — GOING-LIVE CONSIDERATIONS (read this; do NOT flip anything)
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

Finish by confirming setup is complete: the repo is mine, Actions are enabled, the
Alpaca PAPER secrets are saved, the dashboard is live on GitHub Pages, and the bot
has done its first paper run.
```

---

**That's the whole guided installer.** Paste the block above (everything between the
triple backticks) into a fresh Claude session and follow along — it pauses after
each step and prompts you for each secret only when that step needs it.

**Optional — see the entries on a chart.** The TradingView visualiser for this exact
version lives at `SID/pine/sid-strategy-v2.2.3.pine`. Load it into TradingView
(Pine Editor → paste the file → Add to chart) to watch SID's arm/trigger/exit logic
plotted on any of the 80 tickers. It's purely for visualisation — the live bot is the
GitHub Actions deployment you set up above.

**A note on the numbers.** The headline 280 trades / 73.9% WR / PF 3.19 / +$31,426 is
the v2.2.3 5-year backtest on the tier1 universe under **fixed $200 risk per trade.**
The live bot instead sizes with **1% compounding off its own internal ledger**, so its
running P&L totals will look different from that fixed-risk backtest figure — same
trades, different sizing method. Always note which sizing method a P&L number came
from before comparing.
