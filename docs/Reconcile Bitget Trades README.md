# Reconcile Bitget Trades README

Use this process any time the dashboard is showing incorrect exit prices, wrong P&L figures, or fabricated losses. It replaces bot-estimated data with verified figures taken directly from your Bitget XLS exports.

---

## When to run this

- The dashboard shows losses you didn't actually take
- Closed positions are showing live prices instead of real exit prices
- You see entries marked `reconstructed-estimate` or `estimated` in the trade table
- After any period where the bot was offline and missed position closes
- Any time you want to force-verify the trade history against your real Bitget account data

---

## Step 1 — Export your trade data from Bitget

1. Open the **Bitget app** or log in at [bitget.com](https://www.bitget.com)
2. Go to **Futures → Orders → Position History**
   - Set the date range to cover the period you want to reconcile
   - Export as **XLS** (not CSV)
   - File will be named something like: `Exported USDT-M Futures position history 1784989236-2026-05-09 19_19_10.531.xls`
3. Go to **Futures → Orders → Order History**
   - Same date range
   - Export as **XLS**
   - File will be named something like: `Exported USDT-M Futures order history 1784989236-2026-05-09 19_19_10.068.xls`
4. Move **both files** into this folder:
   ```
   C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\docs\live_bitget-trades\
   ```
   Replace any older exports — only the most recent pair of files is used.

> **Important:** The XLS exports only contain positions that were **already closed** at the time of export. Any positions still open when you export will not appear and cannot be reconciled until they close.

---

## Step 2 — Open a terminal in the Trading Setup folder

**Option A — from File Explorer:**
1. Open `C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\` in File Explorer
2. Click the address bar, type `cmd`, press Enter

**Option B — from the Start menu:**
1. Open Command Prompt or PowerShell
2. Run:
   ```
   cd "C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup"
   ```

---

## Step 3 — Run the reconcile script

```
python reconcile-closed-positions.py
```

The script will:

1. Pull the latest `closed-positions-ironclad.json` from the `logs` branch (Railway's live state)
2. Read both Bitget XLS files from `docs\live_bitget-trades\`
3. Match each bot position to a Bitget position record by: symbol + side + open date + entry price
4. Overwrite the exit price, realized P&L, close date/time, and exit level with the real Bitget figures
5. Mark matched entries as `locked: true` and `source: "bitget-verified"` — the bot will never overwrite these
6. Remove duplicate entries (same order ID appearing more than once)
7. Save the patched file and push it to the `logs` branch on GitHub

### Example output

```
══ Reconcile closed-positions-ironclad.json with Bitget XLS ══

Pulling latest closed-positions from logs branch...
  ✓ Pulled from logs branch
  Loaded 187 closed-position records

Reading Bitget XLS files...
  Loaded 26 Bitget position records
  Loaded 39 open-order records from order history

  Removed 6 duplicate entry(ies)

  ✅ XRPUSDT         long  2026-05-08  exit $2.314  tp1   P&L +18.42  (was exit=$0 pnl=+0.00)
  ✅ SOLUSDT          long  2026-05-07  exit $149.2  tp1   P&L +12.30  (was exit=$0 pnl=+0.00)
  ⚠  BTCUSDT          long  2026-05-08  — no Bitget record, keeping estimate (exit=$79491.5)

  Summary: 22 patched · 3 already locked · 1 estimated

  Saved 181 records to closed-positions-ironclad.json

Pushing to logs branch...
  ✓ Pushed to logs branch
══ Done ══
```

---

## Step 4 — Rebuild the dashboard

After the script completes, run:

```
node research.js
```

Then commit and push the updated dashboard:

```
git add docs/index.html research-signals.json closed-positions-ironclad.json
git commit -m "Dashboard update — reconciled Bitget trade data"
git pull --rebase --autostash origin main && git push origin main
```

The dashboard at GitHub Pages will update within a minute of the push.

---

## How the lock system works

Once an entry is marked `locked: true`, it is protected from being overwritten by:

- The Railway bot (`saveClosedPositions()` preserves locked entries)
- The `railway-runner.js` pull cycle (merges remote into local, locked entries survive)
- Future runs of the reconcile script itself (locked entries are skipped)

This means you only need to run this reconcile once per batch of trades. Future trades will be verified and locked as they appear in subsequent Bitget exports.

---

## If the script reports "no Bitget record" for a position

This happens when:

- The position was **still open** at the time of your XLS export — wait for it to close, export again, re-run the script
- The position was closed on a **different date** than the bot recorded — check the Bitget app manually and note the real close date
- The entry price difference is **more than 2%** — the script treats this as a different trade; check whether the bot split one Bitget position across multiple orders

In these cases the entry is flagged `estimated` and left in the file with whatever data the bot had. It will not be locked. Re-run the script after a fresh export to patch it.

---

## Files involved

| File | Purpose |
|------|---------|
| `reconcile-closed-positions.py` | Main reconcile script |
| `fix-estimated-positions.js` | Emergency cleanup — removes fabricated estimated-loss entries by querying the Bitget API directly |
| `closed-positions-ironclad.json` | Trade history file (local + `logs` branch + `main` branch) |
| `docs\live_bitget-trades\` | Drop your Bitget XLS exports here |

---

## Requirements

- **Python 3.8+** — comes with Windows; check with `python --version`
- **xlrd** — installed automatically by the script on first run (`pip install xlrd`)
- **Git** configured with push access to the repo — already set up if Railway is working
- **Node.js** — for `research.js` dashboard rebuild
