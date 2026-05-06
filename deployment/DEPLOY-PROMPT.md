# Cryptolanz — One-Shot Deployment Prompt

Copy everything between the lines below and paste it into a fresh Claude session.
Claude will build the entire system, walk you through setup, and get you running.

---

```
You are going to help me deploy the Cryptolanz Trading Strategy — an advanced,
real-time tested automated crypto futures trading bot with an expected 60–80%
win rate over 150+ trades.

Please build the complete system from scratch, step by step. Ask me for my
API keys and configuration values as you need them — never store or expose them
in any file you create. All sensitive values go into GitHub Secrets only.

───────────────────────────────────────────────
OVERVIEW
───────────────────────────────────────────────

This system uses two cloud platforms:
- Railway ($5/month) runs the trading bot 24/7 — required because Bitget's API is
  protected by Cloudflare which blocks GitHub Actions IPs from making authenticated
  trading calls. Railway uses clean IPs that pass through without issue.
- GitHub Actions (free tier) runs research, monitoring and the live dashboard.

Components to build:
1. bot-ironclad.js      — Main trading bot (called by Railway runner every 15 min)
2. railway-runner.js    — Railway entry point, pulls state from GitHub on startup,
                          runs bot on 15-min loop
3. railway.json         — Railway deployment config
4. research.js          — Market research + live HTML dashboard (runs 9am + 6pm UK)
5. monitor.js           — Fund balance monitor (runs with research)
6. .github/workflows/research.yml  — Research + dashboard scheduler (GitHub Actions)
7. rules-ironclad.json  — Strategy configuration file
8. package.json         — Node.js dependencies (start script points to railway-runner.js)
9. docs/index.html      — Live dashboard (auto-generated, hosted on GitHub Pages)

───────────────────────────────────────────────
STEP 1 — SOFTWARE PREREQUISITES
───────────────────────────────────────────────

Guide me through installing the following if I don't have them already:

1. Git — https://git-scm.com/downloads
   - Windows: download installer, accept defaults
   - Mac: run `xcode-select --install` or use Homebrew: `brew install git`
   - Linux: `sudo apt install git`

2. Node.js v20 LTS — https://nodejs.org
   - Download and install the LTS version
   - Verify: `node --version` should show v20.x.x

3. A GitHub account — https://github.com
   - Free account is sufficient
   - Enable GitHub Pages on the repo (Settings → Pages → Branch: main → /docs)

4. A Bitget account — https://www.bitget.com
   - Complete KYC verification
   - Enable futures trading
   - Create an API key: Account → API Management → Create API
     Permissions needed: Read + Trade on Futures (NO Withdrawal permission)
     Passphrase: use letters and numbers only — no special characters
     IP restriction: leave blank (Railway uses dynamic IPs)
   - Note down: API Key, Secret Key, Passphrase

5. A Railway account — https://railway.app
   - Sign up with your GitHub account (simplest)
   - Create a new project called "Ironclad"
   - You will deploy to Railway in Step 5

───────────────────────────────────────────────
STEP 2 — CREATE THE GITHUB REPOSITORY
───────────────────────────────────────────────

Guide me through:
1. Creating a new GitHub repository called "cryptolanz" (public or private)
2. Cloning it locally: `git clone https://github.com/YOUR_USERNAME/cryptolanz.git`
3. Opening the folder in my terminal

───────────────────────────────────────────────
STEP 3 — BUILD THE PROJECT FILES
───────────────────────────────────────────────

Create all files listed below with the exact logic described. Do not skip any file.

── package.json ──────────────────────────────

{
  "type": "module",
  "dependencies": {
    "node-fetch": "^3.3.2",
    "dotenv": "^16.0.0"
  }
}

── rules-ironclad.json ───────────────────────

Strategy configuration (do not hardcode these values in bot-ironclad.js):
{
  "strategy": "Cryptolanz Ironclad v1.6",
  "timeframes": { "htf": "1D", "ltf": "15m" },
  "swing_detection": {
    "swing_lookback": 2,
    "trend_swing_count": 2,
    "atr_threshold": 0.5,
    "ltf_swing_lookback": 2
  }
}

── bot-ironclad.js ───────────────────────────

Build the complete trading bot with the following exact logic:

CONFIG (all values from environment variables with these defaults):
- portfolioUsd: 1000
- maxTradeUsd: 100 (max position size cap)
- leverage: 3
- maxPerDay: 3 (max entries per symbol per day)
- paperTrading: true (reads IRONCLAD_PAPER env var — must be explicitly set to "false" to go live)
- maxDailyLossUsd: 50 (5% daily drawdown circuit-breaker)

SYMBOLS watchlist (10 Bitget USDT-M futures pairs):
BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, LINKUSDT,
HYPEUSDT, VIRTUALUSDT, APTUSDT, ONDOUSDT, JUPUSDT

State files (committed to repo for persistence across GitHub Actions runs):
- trades-ironclad.csv        — trade log
- open-positions-ironclad.json  — currently open positions
- closed-positions-ironclad.json — completed trades with P&L
- cooldown-ironclad.json     — per-symbol cooldown timestamps
- ironclad-log.json          — debug/signal log

MARKET DATA:
Fetch candles from Bitget public API (no auth needed for market data):
GET https://api.bitget.com/api/v2/mix/market/candles
  ?symbol={symbol}&productType=USDT-FUTURES&granularity={gran}&limit={limit}
Returns newest first — reverse to chronological order.

INDICATORS (implement from scratch — no external indicator libraries):

1. ATR(14) — Average True Range
   TR = max(high-low, |high-prevClose|, |low-prevClose|)
   ATR = average of last 14 TRs

2. EMA(period) — Exponential Moving Average
   k = 2 / (period + 1)
   Seed with SMA of first `period` closes, then: EMA = close × k + prevEMA × (1-k)
   Calculate for periods: 21, 50, 100, 200 on daily candles

3. Swing detection — detectSwings(candles, lookback=2)
   A swing high at index i: all candles within `lookback` bars either side have lower highs
   A swing low at index i: all candles within `lookback` bars either side have higher lows
   Returns { swingHighs: [{index, price, time}], swingLows: [{index, price, time}] }

4. Trend detection — detectTrend(candles, lookback=2, swingCount=2, atrThreshold=0.5)
   Filter swings: only keep swings where adjacent swings differ by >= ATR × atrThreshold
   BULL: last `swingCount` highs are higher highs AND last `swingCount` lows are higher lows
   BEAR: last `swingCount` highs are lower highs AND last `swingCount` lows are lower lows
   NEUTRAL: neither condition met → skip symbol

5. Entry detection — detectEntry(ltfCandles, htfTrend, lookback=2)
   For BULL trend:
     Find most recent swing low on 15m
     If current price > high of that swing low candle → LONG signal
     Stop Loss = min(swingLow - ATR×0.5, entry×0.997)  (minimum 0.3% stop)
   For BEAR trend:
     Find most recent swing high on 15m
     If current price < low of that swing high candle → SHORT signal
     Stop Loss = max(swingHigh + ATR×0.5, entry×1.003)

6. Fibonacci levels — calcFibLevels(direction, entry, htfSwingHighs, htfSwingLows)
   Use most recent HTF swing high and swing low
   Range = swingHigh - swingLow
   For LONG: levels = swingLow + range × ratio  for ratios [0.236, 0.382, 0.5, 0.618, 0.786, 1.0, 1.272, 1.618]
   For SHORT: levels = swingHigh - range × ratio

7. Take-profit levels — calcTakeProfitLevels(direction, entry, stopLoss, emaLevels, swingHighs, swingLows)
   Candidate pool: ema21, ema50, ema100, ema200, all HTF swing prices, all fib levels
   For LONG: filter candidates > entry × 1.002, sort ascending
   For SHORT: filter candidates < entry × 0.998, sort descending
   Deduplicate: remove levels within 0.3% of each other
   Pick first 3 deduplicated levels as TP1, TP2, TP3
   Fallback if < 3 structural levels: use risk multiples 1.5R, 2.5R, 4.0R
   Return: { tp1, tp2, tp3, rr1, rr2, rr3 }

POSITION SIZING — calcQuantity(entry, stopLoss):
   riskUsd = portfolioUsd × 0.01
   slPct = |entry - stopLoss| / entry
   qty = min(riskUsd / (slPct × leverage), maxTradeUsd) / entry
   Round to 6 decimal places

POSITION MONITORING — checkPositions():
Runs at start of every bot execution BEFORE scanning for new entries.
Loads open-positions-ironclad.json, fetches latest 500 × 15m candles per symbol.
Only processes candles with timestamp AFTER the position open time.
Walks through candles simulating the 3-TP trailing stop plan:

  Splits: [0.40, 0.35, 0.25] of position closed at TP1, TP2, TP3
  For LONG on each candle:
    If low <= currentSL → full stop (pessimistic, SL checked before TP)
    If high >= TP1 and not tp1Hit → close 40%, set tp1Hit=true, move SL to entry (break-even)
    If high >= TP2 and tp1Hit and not tp2Hit → close 35%, set tp2Hit=true, move SL to TP1
    If high >= TP3 and tp2Hit → close final 25%, fully exited
  Mirror logic for SHORT (low/high swapped)

  Outcomes:
    LOSS = stopped at SL before any TP hit → triggers 3-hour cooldown on that symbol
    BE   = stopped at entry after TP1 hit → no cooldown (profitable outcome)
    WIN  = TP3 hit

  On close: write to closed-positions-ironclad.json with fields:
    id, symbol, side, entry, stopLoss, tp1/tp2/tp3, qty, totalUsd,
    openDate, openTime, strategy, tp1Hit, tp2Hit, currentSl, partialCloses[],
    realizedPnl, exitLevel, exitPrice, closeDate, closeTime, outcome

COOLDOWN SYSTEM:
  File: cooldown-ironclad.json — { "BTCUSDT": "2024-01-01T15:00:00.000Z", ... }
  After LOSS outcome: write symbol → ISO timestamp of (now + 3 hours)
  Before each symbol scan: if current time < cooldown timestamp → skip with log message

DAILY DRAWDOWN CIRCUIT-BREAKER:
  Read closed-positions-ironclad.json, filter where closeDate === today
  Sum all realizedPnl values
  If sum <= -maxDailyLossUsd → log warning and return early (no trading today)

ECONOMIC EVENT BLACKOUT:
  Read research-signals.json (written by research.js)
  If any event datetime is within ±60 minutes of current time → halt all entries
  Log the event name and minutes away

RESEARCH SIGNAL FILTER:
  Read research-signals.json signals array
  For each symbol: find matching token signal { signal: 'bull'|'bear'|'neutral' }
  If signal conflicts with entry direction (bull research but short entry) → skip
  Neutral research = allow both directions

ORDER PLACEMENT — placeOrder(symbol, side, qty, entry, stopLoss, tp1):
  In paper mode: simulate order, return { orderId: "PAPER-{timestamp}" }
  In live mode: place market order via Bitget authenticated API
  
  Bitget API authentication (HMAC-SHA256):
    timestamp = Date.now().toString()
    message = timestamp + "POST" + path + JSON.stringify(body)
    sign = base64(HMAC-SHA256(secretKey, message))
    Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, Content-Type

  Bitget futures order endpoint:
    POST https://api.bitget.com/api/v2/mix/order/place-order
    Body: { symbol, productType: "USDT-FUTURES", marginMode: "crossed",
            marginCoin: "USDT", size: qty.toString(), side: "buy"/"sell",
            tradeSide: "open", orderType: "market", leverage }

MAIN RUN FLOW:
1. checkPositions() — monitor and close any resolved positions
2. checkDailyDrawdown() — halt if 5% daily loss breached
3. checkEconomicBlackout() — halt if within 60 min of major event
4. For each symbol in SYMBOLS:
   a. countTodayTrades(symbol) — skip if >= maxPerDay
   b. isOnCooldown(symbol) — skip if within 3h post-loss window
   c. fetchCandles(symbol, '1D', 50) + fetchCandles(symbol, '15m', 100)
   d. detectTrend(dailyCandles) — skip if neutral
   e. calcEMALevels(dailyCandles)
   f. detectEntry(ltfCandles, htfTrend) — skip if no signal
   g. calcTakeProfitLevels(...)
   h. isResearchAligned(researchSignal, direction) — skip if conflicting
   i. calcQuantity(entry, stopLoss)
   j. placeOrder(...)
   k. appendTrade to CSV, addOpenPosition to JSON, writeLog

── .github/workflows/ironclad.yml ───────────

Schedule (UTC — GitHub Actions uses UTC):
Weekends: every 4 hours (not all exchanges — crypto runs 24/7)
Weekdays:
  Asian session 00:00–02:00 UTC: every 15 min  → cron: '0,15,30,45 0,1 * * 1-5'
  Quiet 02:00–07:00 UTC: hourly                → cron: '0 2,3,4,5,6 * * 1-5'
  London open 07:00–10:00 UTC: every 15 min    → cron: '0,15,30,45 7,8,9 * * 1-5'
  Mid-morning 10:00–13:00 UTC: every 30 min    → cron: '0,30 10,11,12 * * 1-5'
  US open 13:00–17:00 UTC: every 15 min        → cron: '0,15,30,45 13,14,15,16 * * 1-5'
  Afternoon 17:00–20:00 UTC: every 30 min      → cron: '0,30 17,18,19 * * 1-5'
  US close 20:00–22:00 UTC: every 15 min       → cron: '0,15,30,45 20,21 * * 1-5'
  Wind down 22:00–00:00 UTC: hourly            → cron: '0 22,23 * * 1-5'

Steps: checkout → setup-node v20 → npm install → run bot → save state files

Save step must commit AND persist these files (use || true to not fail on untracked):
  trades-ironclad.csv, ironclad-log.json
  open-positions-ironclad.json, closed-positions-ironclad.json
  cooldown-ironclad.json

Git commit command: git commit -m "Ironclad run $(date -u '+%Y-%m-%d %H:%M UTC')"
After commit: git pull --rebase --autostash origin main && git push

Environment variables (from GitHub Secrets):
  BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE
  MODE: futures
  LEVERAGE: (from secret)
  PORTFOLIO_USD: (from secret)
  MAX_TRADE_USD: (from secret)
  MAX_TRADES_PER_DAY: (from secret)
  IRONCLAD_PAPER: (from secret — set to "false" to go live)
  MAX_DAILY_LOSS_USD: (from secret)

── .github/workflows/research.yml ───────────

Schedule: 9:00 UTC and 18:00 UTC Monday–Friday
  cron: '0 9,18 * * 1-5'

Steps: checkout → setup-node v20 → npm install → run monitor.js → run research.js → save outputs

Save: research-signals.json, docs/index.html, safety-check-log.json, research-log.json

── research.js ──────────────────────────────

This file does two jobs:

JOB 1 — Market Research (writes research-signals.json):
For each of the 10 tokens, use the web search capability or public APIs to gather:
  - Current sentiment signal: 'bull', 'bear', or 'neutral'
  - Brief reason string (1 sentence)
  - Any detected chart pattern
  - Key price level to watch

Also detect upcoming high-impact US economic events within the next 24 hours:
  (FOMC, NFP, CPI, PPI, FOMC Minutes, Fed Chair speech)
  Write them to the events array with datetime in ISO format.

Output format — research-signals.json:
{
  "date": "YYYY-MM-DD",
  "generated": "ISO timestamp",
  "signals": [
    { "token": "BTC", "signal": "bull", "reason": "...", "chart_pattern": "...", "price_level": "..." }
  ],
  "events": [
    { "name": "FOMC Rate Decision", "datetime": "2024-01-31T19:00:00.000Z", "impact": "high" }
  ]
}

JOB 2 — Live HTML Dashboard (writes docs/index.html):
Build a dark-themed (GitHub dark style) HTML dashboard with tabs:
  Tab 1 — Today's Overview: daily P&L, win rate, active positions, today's signals
  Tab 2 — Trade History: paginated table with filters (pair, month, bot, mode, side)
    Columns: Open Date, Open Time, Symbol, Side, Entry, Stop Loss, Exit/Live price,
             Qty, Close Date, Close Time, P&L (🔒 if realized), Cumulative P&L,
             Mode (📄 Paper / 💰 Live), Bot, Strategy, Version
  Tab 3 — Research signals table showing today's sentiment per token
  Tab 4 — Fund Monitor summary

Read trade data from trades-ironclad.csv.
Read realized P&L from closed-positions-ironclad.json (keyed by order ID).
Fetch live prices from Bitget public ticker API for open positions.
Embed all data as JSON in the HTML (no server-side rendering needed).

── monitor.js ───────────────────────────────

Simple fund monitor:
- Fetch USDT balance from Bitget authenticated API
- Fetch open futures positions
- Log balance and positions to console
- Write summary to a monitor output file

───────────────────────────────────────────────
STEP 4 — GITHUB SECRETS CONFIGURATION
───────────────────────────────────────────────

After building all files, guide me through adding these secrets:
GitHub repo → Settings → Secrets and variables → Actions → New repository secret

These secrets are used by the research and monitor workflows on GitHub Actions:

Required secrets:
  BITGET_API_KEY          Your Bitget API key
  BITGET_SECRET_KEY       Your Bitget secret key
  BITGET_PASSPHRASE       Your Bitget API passphrase
  LEVERAGE                3
  PORTFOLIO_USD           1000  (or your starting portfolio size)
  MAX_TRADE_USD           100   (max single position size in USD)
  MAX_TRADES_PER_DAY      3
  IRONCLAD_PAPER          true  (KEEP AS TRUE UNTIL READY TO GO LIVE)
  MAX_DAILY_LOSS_USD      50    (5% of $1000 — adjust proportionally)

───────────────────────────────────────────────
STEP 5 — GITHUB PAGES SETUP
───────────────────────────────────────────────

Enable the live dashboard:
1. GitHub repo → Settings → Pages
2. Source: Deploy from a branch
3. Branch: main  /docs folder
4. Save — dashboard will be live at https://YOUR_USERNAME.github.io/cryptolanz/

───────────────────────────────────────────────
STEP 6 — RAILWAY DEPLOYMENT (TRADING BOT)
───────────────────────────────────────────────

The trading bot must run on Railway — Bitget's Cloudflare WAF blocks GitHub
Actions IPs from making authenticated API calls.

1. Go to https://railway.app and sign up with your GitHub account
2. Create a new project called "Ironclad"
3. Inside the project → + New → GitHub Repo → select your cryptolanz repo
4. Railway will detect railway.json and use `node railway-runner.js` as the start command
5. Go to the service → Variables tab and add:

   BITGET_API_KEY          Your Bitget API key
   BITGET_SECRET_KEY       Your Bitget secret key
   BITGET_PASSPHRASE       Your Bitget passphrase (letters/numbers only — no special chars)
   GITHUB_TOKEN            A GitHub Personal Access Token with repo Contents read access
                           (github.com → Settings → Developer settings → Fine-grained tokens
                            → BotTrading repo → Contents: read)
   PORTFOLIO_USD           1000
   MAX_TRADE_USD           100
   LEVERAGE                3
   MAX_TRADES_PER_DAY      3
   MAX_DAILY_LOSS_USD      50
   IRONCLAD_PAPER          true  (set to "false" only when ready to go live)

6. Railway deploys automatically — watch the logs for "Ironclad Railway runner started"
7. The bot will pull state from GitHub on startup and run every 15 minutes

IMPORTANT: In Railway service Settings, ensure Serverless is OFF (toggle to the left).
The bot must stay always-on to maintain its 15-minute schedule.

───────────────────────────────────────────────
STEP 7 — FIRST RUN TEST
───────────────────────────────────────────────

1. Push all files to GitHub: `git add . && git commit -m "Initial deploy" && git push`
2. Railway will deploy automatically from the GitHub push
3. Watch Railway logs — you should see all 9 symbols scanned with trend analysis
4. Go to GitHub → Actions → "Daily Market Research" → Run workflow manually
5. Check that docs/index.html was generated and GitHub Pages shows the dashboard

───────────────────────────────────────────────
STEP 8 — PAPER TRADE FOR AT LEAST 2 WEEKS
───────────────────────────────────────────────

Leave IRONCLAD_PAPER = true until you have:
- At least 20–30 paper trades completed
- Reviewed the dashboard and confirmed signals make sense
- Confirmed no technical errors in the Actions logs
- Reviewed a sample of trades on TradingView to validate entry logic

ONLY then change IRONCLAD_PAPER to "false" to go live.

───────────────────────────────────────────────
GOING LIVE CHECKLIST
───────────────────────────────────────────────

Before flipping to live mode, confirm:
[ ] Paper traded for 2+ weeks — results look consistent
[ ] Bitget account funded with your trading capital
[ ] Futures trading enabled on your Bitget account
[ ] API key has Trade permission (NOT Withdrawal)
[ ] PORTFOLIO_USD secret matches your actual Bitget USDT balance
[ ] MAX_DAILY_LOSS_USD set to 5% of your portfolio
[ ] You understand the strategy can lose money — only use capital you can afford to lose
[ ] Change IRONCLAD_PAPER secret from "true" to "false"

───────────────────────────────────────────────
IMPORTANT NOTES
───────────────────────────────────────────────

- NEVER commit API keys to the repository. Always use GitHub Secrets.
- The strategy performs best in TRENDING markets (clear bull or bear on daily chart).
- In choppy/ranging markets the neutral filter will naturally reduce trade frequency.
- The 5% daily drawdown limit is a hard safety net — if it fires frequently, the market
  conditions are unfavourable and the bot is working as designed by sitting out.
- Monitor the Actions logs regularly in the first few weeks.
- Expected trade frequency: 3–8 signals per day during active trending conditions.

Build everything now, file by file, and confirm each file before moving to the next step.
Start with package.json, then rules-ironclad.json, then bot-ironclad.js.
```

---

*Paste the block above (between the triple backticks) into a fresh Claude session to begin deployment.*
