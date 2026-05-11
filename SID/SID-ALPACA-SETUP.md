# SID + Alpaca Integration — Setup Guide

This guide walks you from a fresh Alpaca account to having the SID bot place
real trades against your paper or live broker. The integration is gated by a
three-mode switch so you can move from "log only" → "paper trades" → "live
money" at your own pace.

---

## Three operating modes

The bot reads `SID_TRADING_MODE` to decide what to do with each signal:

| Mode      | Behaviour                                                                                  | Risk      |
|-----------|--------------------------------------------------------------------------------------------|-----------|
| `dry_run` | (Default) Logs trades to `trades-sid.csv` and JSON files. No Alpaca calls. Same as before. | None      |
| `paper`   | Hits Alpaca's **paper-trading** API. Real order tracking, simulated fills.                 | None      |
| `live`    | Hits Alpaca's **live** API. **Real money.** Requires explicit confirmation token.          | Real cash |

The default is `dry_run`. **Nothing happens at Alpaca unless you explicitly
flip the mode.**

---

## Step 1 — Open the Alpaca account

If you haven't already, follow the **Money transfer methods.docx** in this
folder to:

1. Open a Wise account + activate a USD balance
2. Open an Alpaca Trading account
3. Complete W-8BEN (non-US persons)
4. Link Wise USD as a bank in Alpaca

**Until your account is funded, the bot stays in `dry_run` mode.**

---

## Step 2 — Generate API keys

You'll need **two sets of keys**: paper and live. They're separate, so
practising on paper never risks live cash.

### Paper-trading keys (start here)

1. Sign in to Alpaca: <https://app.alpaca.markets/login>
2. Top right → switch to **Paper Trading** account
3. Left sidebar → **Settings** → **API Keys**
4. Click **Generate New Key**
5. Copy **API Key ID** and **Secret Key** somewhere safe — Alpaca only shows
   the secret once. If you lose it, regenerate.

### Live-trading keys (later, after you've verified the bot on paper)

Same flow, but switch the account toggle to **Live Trading** before generating
the keys. **Keep these separate from your paper keys** — never reuse.

---

## Step 3 — Local testing (`paper` mode)

Before pushing anything to GitHub, you can run the bot against your paper
account from your own machine.

### Add to `.env` in this folder

```dotenv
# Mode switch — choose dry_run | paper | live
SID_TRADING_MODE=paper

# Paper-trading credentials
ALPACA_KEY_ID=PKXXXXXXXXXXXXXXXXXX
ALPACA_SECRET_KEY=YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY
# Base URL — leave default for paper, or set explicitly:
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

### Run it

```powershell
cd SID
node bot-sid.js
```

You should see:

```
Mode: PAPER
[SID-EXEC] Mode: PAPER — Alpaca paper-trading account in use (...)
[Alpaca] Equity     : $100000.00  (used for position sizing this run)
[Alpaca] Buying pwr : $200000.00
[Alpaca] Market open: YES  next open: ...
```

If you see a 401, the keys are wrong. If you see `account_blocked`, your
account isn't fully approved yet — wait a day and try again.

---

## Step 4 — Trigger a signal & watch the order land

The bot only fires entries when a real SID signal is detected. To force a test
fill, you can either wait for a natural signal (typical: 0–3 per day across
the 50-symbol watchlist) or temporarily lower the `SID_MAX_PER_DAY` cap.

After a successful entry the bot prints:

```
✓ LONG
    Entry    : $123.45
    Stop     : $120  (lowest low since 2026-05-08)
    Shares   : 8
    [Alpaca:paper] Submitting BUY 8 AAPL @ market, stop $120
    [Alpaca:paper] Entry order abc123 submitted (status: accepted)
    [Alpaca:paper] Stop order def456 submitted at $120
    Order ID : abc123 (stop def456)
```

Verify in the Alpaca dashboard:

1. Sign in → **Paper Trading** account
2. **Positions** tab — your new position is listed
3. **Orders** tab — the entry order shows filled and the stop shows accepted /
   gtc / open

---

## Step 5 — Wiring into GitHub Actions

The repo already has a workflow at `.github/workflows/sid.yml` that runs every
weekday at 14:35 UTC. To enable Alpaca execution in the cloud:

### a) Add repository secrets

1. GitHub → your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** for each of:

   | Name                 | Value                                          |
   |----------------------|------------------------------------------------|
   | `ALPACA_KEY_ID`      | (your paper or live API key)                   |
   | `ALPACA_SECRET_KEY`  | (your paper or live secret)                    |
   | `ALPACA_BASE_URL`    | `https://paper-api.alpaca.markets` for paper   |
   | `SID_TRADING_MODE`   | `paper` (or `dry_run` to silence Alpaca)       |

   For live trading, also add:

   | Name                  | Value                                                   |
   |-----------------------|---------------------------------------------------------|
   | `SID_LIVE_CONFIRMED`  | `YES_I_REALLY_MEAN_IT`                                  |

   And change:

   | `ALPACA_BASE_URL`    | `https://api.alpaca.markets`                            |
   | `SID_TRADING_MODE`   | `live`                                                  |

### b) Confirm next workflow run

The `sid.yml` workflow already includes the Alpaca env vars (added in this PR).
On the next scheduled run, check the Actions tab for the `Mode: PAPER` line in
the log.

---

## Step 6 — Going live (only when you're ready)

**Recommended checklist before flipping to `live`:**

- [ ] You've run `paper` mode for at least **4 weeks** of real signals
- [ ] At least **10 closed trades** in `closed-positions-sid.json` from paper
- [ ] Paper win rate ≥ 60% — if not, debug before risking cash
- [ ] You've funded the live Alpaca account with the amount you're willing to
      lose
- [ ] You've reviewed `SID_RISK_PCT` and are happy with the position size
      (default 0.5% — leave low while transitioning)
- [ ] You've manually placed and cancelled an order in Alpaca's live UI to
      confirm the account is in good standing

**To flip the switch:**

1. Generate live API keys (Step 2 → live toggle)
2. Update GitHub secrets:
   - `ALPACA_KEY_ID` → live key
   - `ALPACA_SECRET_KEY` → live secret
   - `ALPACA_BASE_URL` → `https://api.alpaca.markets`
   - `SID_TRADING_MODE` → `live`
   - `SID_LIVE_CONFIRMED` → `YES_I_REALLY_MEAN_IT` (required, otherwise the
     bot falls back to paper as a safety net)

3. Watch the **first live run carefully** — open the Actions log and the
   Alpaca dashboard side-by-side. Stop the workflow at the first sign of
   anything unexpected.

---

## Mode safety summary

| You want to…                | Set `SID_TRADING_MODE` | Set `SID_LIVE_CONFIRMED`  |
|-----------------------------|-----------------------|---------------------------|
| Log signals only (no Alpaca)| `dry_run` or unset    | n/a                       |
| Trade against paper account | `paper`               | n/a                       |
| Trade against live account  | `live`                | `YES_I_REALLY_MEAN_IT`    |

If `SID_TRADING_MODE=live` is set but `SID_LIVE_CONFIRMED` is missing or
wrong, the executor automatically downgrades to paper and logs a warning.
There is no path to live trading without explicit dual opt-in.

---

## What the bot does on every run

```
1. Load local account state (compounding ledger)
2. If executor enabled:
     a. Call Alpaca /v2/account     — get equity + blocked flags
     b. Call Alpaca /v2/clock        — is the market open?
     c. Call Alpaca /v2/positions    — what does Alpaca think we hold?
     d. Reconcile against local open-positions-sid.json
        - Any local positions Alpaca doesn't have → mark closed externally
3. checkPositions() — for each remaining open position:
     - Fetch daily candles from Yahoo
     - Walk forward looking for RSI(14) crossing 50 (exit signal)
     - If executor enabled and RSI 50 hit:
         - Cancel the existing stop order on Alpaca
         - Submit a market close order
     - Realise the P&L locally
4. If at max open positions or daily entry cap → stop
5. Scan watchlist for new entry signals:
     - Yahoo daily candles → RSI + MACD analysis
     - Earnings blackout check (skip if earnings within 14 days)
     - Calculate position size from current account equity
     - If executor enabled:
         - Submit market entry + stop loss to Alpaca
         - Use Alpaca's order ID as the canonical trade record
     - Else (dry_run):
         - Generate a synthetic SID-DRYRUN-{ts} ID
     - Append to trades-sid.csv + open-positions-sid.json
6. Commit logs back to the repo (handled by sid.yml)
```

---

## Files involved

| File                          | Purpose                                                            |
|-------------------------------|--------------------------------------------------------------------|
| `alpaca-client.js`            | Minimal REST wrapper — no SDK dependency. Pure fetch.              |
| `alpaca-executor.js`          | Mode-gated executor. Returns `null` in dry_run; live/paper otherwise. |
| `bot-sid.js`                  | Existing SID logic with `createExecutor()` wired in at three call sites. |
| `SID-ALPACA-SETUP.md`         | This document.                                                     |

---

## Common errors

| Error                                            | Meaning                                                   | Fix                                                     |
|--------------------------------------------------|-----------------------------------------------------------|---------------------------------------------------------|
| `401 Unauthorized`                               | API keys wrong / mismatched paper vs live                 | Regenerate, copy carefully, match the base URL          |
| `403 forbidden`                                  | Account blocked, trading blocked, or PDT rule hit         | Log into Alpaca dashboard and resolve                   |
| `Market closed`                                  | Bot trying to enter outside US session                    | Expected — bot only enters during market hours          |
| `Insufficient buying power`                      | Position size > account cash                              | Lower `SID_RISK_PCT` or fund more cash                  |
| `client_order_id already exists`                 | Bot tried to resubmit a previously-fired signal           | Idempotency working as designed — safe to ignore        |

---

## Useful links

- Alpaca paper login: <https://app.alpaca.markets/paper/dashboard/overview>
- Alpaca live login:  <https://app.alpaca.markets/login>
- API reference:      <https://docs.alpaca.markets/reference/getaccount>
- API status page:    <https://status.alpaca.markets/>
