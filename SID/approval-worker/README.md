# SID Telegram Approval Worker — Setup (v2.3.0)

This is the receiver that turns the **[✅ Approve]** button on a SID short-approval
Telegram alert into a **properly tracked bot position**. When you tap Approve:

```
Telegram button tap
   → Cloudflare Worker (this folder)         [validates it's YOU + a valid webhook]
   → GitHub workflow_dispatch (sid-approve-trade.yml)
   → approve-trade.js enters the trade on Alpaca PAPER as a tracked position
     (full TP1/TP2 management by the normal bot)
```

Before this, "approve" meant manually running `sid-manual-trade.yml`, which
created an **untracked** off-strategy trade. This closes that gap.

---

## Security model (why this is safe)

Every layer fails **closed** — a missing secret makes the check reject, never
fall back to something insecure.

| Guard | What it stops |
|---|---|
| **Webhook secret header** — Telegram sends `X-Telegram-Bot-Api-Secret-Token`; the Worker rejects (401) anything that doesn't match `WEBHOOK_SECRET`. | Anyone who guesses the Worker URL injecting fake button taps. |
| **Chat-id allowlist** — the Worker only acts if `callback_query.from.id === ALLOWED_CHAT_ID` (your Telegram user id). | Any other Telegram user approving trades, even if they find the bot. |
| **Least-privilege GitHub token** — a fine-grained PAT with **Actions: read+write** on **only** the BotTrading repo. Nothing else. | A leaked token doing anything beyond triggering this one workflow. |
| **Secrets never in code** — set via `wrangler secret put` (encrypted at Cloudflare) + GitHub repo secrets. Nothing secret is committed. | Secrets leaking through the public repo. |
| **Paper only** — the workflow runs `approve-trade.js` under `SID_TRADING_MODE` (paper). Live needs the separate `SID_LIVE_CONFIRMED` token. | Real money firing by accident. |
| **Safe abort** — `approve-trade.js` aborts (no Alpaca call) if the `approval_id` is unknown, already actioned, or expired. | A blind or duplicate trade. |

---

## One-time setup

You do all of this yourself — **never share any secret value with anyone,
including in chat.** Have the SID Telegram bot token handy (the same
`TELEGRAM_BOT_TOKEN` the bot already uses).

### Step 1 — Create a free Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account.
2. Verify your email.

### Step 2 — Install wrangler (Cloudflare's CLI)

You need Node 20+ (you already have it for the bot).

```bash
npm install -g wrangler
wrangler login          # opens a browser to authorise the CLI against your account
```

> Alternatively you can paste the Worker code directly in the Cloudflare
> dashboard (Workers & Pages → Create → Worker → paste `worker.js`), but the CLI
> is easier for setting secrets.

### Step 3 — Create the fine-grained GitHub token (least privilege)

Do this on GitHub yourself. **Copy the value once and paste it straight into
`wrangler secret put` (Step 5) — don't save it anywhere else, don't share it.**

1. GitHub → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Token name:** `sid-approval-worker`.
3. **Expiration:** pick a finite one (e.g. 90 days) — never "no expiration".
4. **Resource owner:** your account (`ballikov-lgtm`).
5. **Repository access:** **Only select repositories** → choose **`BotTrading`** only.
6. **Permissions:** under **Repository permissions**, set **Actions** to
   **Read and write**. Leave everything else at "No access".
7. Generate, then **copy the token** (starts with `github_pat_...`).

This token can ONLY trigger workflows in the one repo. That's the whole point.

### Step 4 — Find your Telegram chat/user id

Your alerts already go to `TELEGRAM_CHAT_ID`. For a 1:1 chat with the bot, your
**user id** equals that chat id — it's what you set up in `SID-TELEGRAM-SETUP.md`.
To re-confirm:

1. Open `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` in a browser
   (send the bot a message first if it's empty).
2. Find `"from":{"id":NUMBER` — that `NUMBER` is your user id. Use it as
   `ALLOWED_CHAT_ID`.

### Step 5 — Set the Worker secrets

From this folder (`SID/approval-worker/`), run each of these and paste the value
when prompted (values are NOT echoed):

```bash
cd SID/approval-worker

wrangler secret put TELEGRAM_BOT_TOKEN     # the SID bot token (same as the bot)
wrangler secret put WEBHOOK_SECRET         # invent a long random string (see below)
wrangler secret put ALLOWED_CHAT_ID        # your Telegram user id from Step 4
wrangler secret put GITHUB_TOKEN           # the github_pat_... from Step 3
wrangler secret put GH_OWNER               # ballikov-lgtm
wrangler secret put GH_REPO                # BotTrading
```

Generate a strong `WEBHOOK_SECRET` (you'll reuse it in Step 7):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### Step 6 — Deploy the Worker

```bash
wrangler deploy
```

Wrangler prints the Worker URL, e.g.
`https://sid-approval-worker.<your-subdomain>.workers.dev`. **Copy it** — you
need it for Step 7.

Quick liveness check (should return a plain "alive" string, no secrets):

```bash
curl https://sid-approval-worker.<your-subdomain>.workers.dev
```

### Step 7 — Register the Telegram webhook

Point Telegram at your Worker and hand it the same `WEBHOOK_SECRET` so it echoes
it in the header the Worker checks:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://sid-approval-worker.<your-subdomain>.workers.dev" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"callback_query\",\"message\"]"
```

Confirm it took:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

You want `"url"` = your Worker and no `last_error_message`.

> ⚠️ The webhook and the bot's `getUpdates` polling are mutually exclusive.
> The SID bot only ever *sends* messages (it never polls), so registering the
> webhook is safe and won't break alerts.

---

## Test procedure

1. **Manual workflow test first (no Telegram needed):**
   ```bash
   gh workflow run sid-approve-trade.yml -f approval_id="DOES-NOT-EXIST-short"
   ```
   Watch the run — it should abort safely ("No pending approval found … NO
   trade") and exit 0. This proves the workflow + safe-abort path work.

2. **End-to-end button test:** wait for a real bullish-asset short signal (or, to
   test on demand, add a `pending` record to `SID/pending-approvals-sid.json`
   with a matching `approve:<id>` — the next alert with buttons references it).
   When the alert arrives with **[✅ Approve] [❌ Skip]**:
   - Tap **Skip** → the message edits to "❌ Skipped" (no trade).
   - Tap **Approve** → the message edits to "✅ Approved — firing…", the
     workflow runs, and (during US market hours, paper mode) the position opens
     and you get a "SID APPROVED ENTRY — now a TRACKED position" confirmation.

3. **Authorisation test:** if anyone else taps the button, the Worker answers
   "Not authorised" and does nothing.

---

## Operating notes

- **Approvals can arrive days later.** `approve-trade.js` enters at the **current
  market price**, recomputes the stop (reusing the original level if still valid,
  else a buffer beyond the current price), sizes by **1% risk on the live
  entry→stop distance**, and logs the proposed-vs-actual entry delta. If the
  price has moved > 5% from the proposal it still enters (you chose to approve)
  but flags the delta.
- **Market closed?** The workflow leaves the record `pending` and tells you to
  approve again during US market hours.
- **Rotating the GitHub token:** regenerate on GitHub, then
  `wrangler secret put GITHUB_TOKEN` again. No redeploy needed.
- **Disable the flow:** unregister the webhook
  (`.../deleteWebhook`) or remove the buttons by reverting the
  `alertShortApprovalNeeded` change — the bot keeps working, alerts just go back
  to text-only with the manual runbook.
