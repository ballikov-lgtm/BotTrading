# SID Telegram Alerts — Setup Guide

Get push notifications on your phone for every SID signal, entry, exit, and
daily run summary. Setup is ~2 minutes via Telegram's @BotFather.

---

## What you'll receive

Once configured, you'll get a Telegram message for each of these events:

| Event | Trigger | Sample message |
|---|---|---|
| **Entry fired** | Bot opens a position | `🟢 SID ENTRY FIRED [PAPER]  AAPL — LONG 12 sh  Entry: $172.30  Stop: $170  …` |
| **Exit fired** | Position closes (RSI 50 or stop) | `✅ SID EXIT — WIN [PAPER]  AAPL — LONG closed @ $176.50  Reason: RSI 50 reached  Realized: +$50.40` |
| **Run summary** | End of every bot run | `📊 SID Run Complete  Open: 2  New: 1  Closed: 0  Account: $10,124.30` |

You'll see `[DRY RUN]`, `[PAPER]`, or `[LIVE]` tags on every alert so you can
tell at a glance which Alpaca account just acted.

---

## Step 1 — Create the bot via @BotFather

1. Open Telegram on your phone.
2. Search for **@BotFather** and start a chat.
3. Send `/newbot`.
4. BotFather asks for a name. Reply with something like **SID Trading Bot**.
5. BotFather asks for a username — must end in `bot`. Try **sid_trading_bot**
   (if taken, add your initials or numbers, e.g. `sid_ab_bot`).
6. BotFather replies with a message containing a **token** that looks like:
   ```
   1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ-0123456789
   ```
   **Copy this token somewhere safe** — you only see it once.

## Step 2 — Get your chat ID

Telegram needs to know which chat to send alerts to.

1. In Telegram, **search for your new bot** (the username you picked in Step 1).
2. **Start a chat** with it and send any message (e.g. "hello").
3. In a browser, visit:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN_HERE>/getUpdates
   ```
   Replace `<YOUR_TOKEN_HERE>` with the token from Step 1.

4. The page shows JSON. Find:
   ```json
   "chat":{"id":123456789,...
   ```
   That `123456789` (your number will be different) is your **chat ID**.
5. Copy it.

## Step 3 — Add two GitHub repo secrets

1. Go to your repo on GitHub: <https://github.com/ballikov-lgtm/BotTrading>
2. **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** twice and add:

   | Name | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | the token from Step 1 |
   | `TELEGRAM_CHAT_ID` | the number from Step 2 |

4. (Optional) Add a third secret to disable alerts without removing the others:

   | Name | Value |
   |---|---|
   | `TELEGRAM_ALERTS_ENABLED` | `false` |

   Set this to `true` (or remove the secret entirely) to re-enable.

## Step 4 — Test it locally first (optional but recommended)

Before pushing to GitHub Actions, you can test the integration on your own
machine:

1. Add the secrets to your local `SID/.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   ```
2. Run the test command from inside the `SID` folder:
   ```
   node telegram-alerts.js test
   ```
3. You should see "OK — check Telegram" and a test message arrives on your
   phone within seconds. If you see "FAIL", the error message tells you
   what's wrong (most often: typo'd token or wrong chat ID).

## Step 5 — Trigger the workflow to confirm cloud setup

On GitHub Actions, the next scheduled run (14:35 UTC on weekdays) will
automatically pick up the new secrets. To test immediately:

1. **Actions** → **SID Swing Bot** → **Run workflow** → **Run workflow**
2. Watch the logs. You should see no Telegram errors.
3. The run-complete summary message should appear on your phone.

If the bot opens a position during that run, you'll also get the entry alert.

---

## Privacy + security notes

- The Telegram bot can only message YOUR chat — not anyone else's. Only the
  account that started the bot can receive messages from it.
- The token is essentially a password. If you accidentally publish it
  publicly, regenerate immediately via `/revoke` in @BotFather, then update
  the GitHub secret.
- The bot **only sends notifications, it doesn't accept commands** — you
  can't accidentally fire trades from Telegram. If you ever want a two-way
  bot (e.g. "/close AAPL"), that's a future feature.

## Common issues

| Problem | Cause | Fix |
|---|---|---|
| No messages arrive | Token / chat ID wrong | Re-run `node telegram-alerts.js test` and check the error |
| `chat not found` error | You haven't sent the bot a message yet | Open Telegram → find your bot → send "hello" |
| `Unauthorized` error | Token typo or revoked | Generate new token via @BotFather, update secret |
| Stops working suddenly | You blocked the bot in Telegram | Unblock it, or restart by sending `/start` |
| Way too many alerts | Bot fired multiple times | Set `TELEGRAM_ALERTS_ENABLED=false` temporarily while you debug |

---

## What gets sent (full list)

In the current implementation, the bot sends:

- **Once per run summary** — even if nothing happened
- **Per entry** — only when a position actually opens
- **Per exit** — only when a position actually closes (whether RSI 50 win or stop loss)

For a typical SID quarter (~6 entries + 6 exits + 60 daily runs) you'd see
roughly **75-90 messages over 3 months** — about 1 per day on average.

If that's too noisy, future versions can add per-event toggles via more
secrets. Tell me and I'll add them.
