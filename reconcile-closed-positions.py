"""
reconcile-closed-positions.py
------------------------------
Patches closed-positions-ironclad.json using the real Bitget XLS exports as
the source of truth. Run once from the Trading Setup folder:

    python reconcile-closed-positions.py

What it does:
  1. Reads Bitget position history XLS  → real entry / exit / P&L per position
  2. Reads Bitget order history XLS     → maps individual order IDs to positions
  3. Loads closed-positions-ironclad.json
  4. For every entry that matches a Bitget position record:
       - Overwrites exitPrice, realizedPnl, exitLevel, closeDate, closeTime
       - Sets source = "bitget-verified"  and  locked = True
  5. Removes duplicate entries (same id → keep the latest / best)
  6. Removes "reconstructed-estimate" entries where Bitget has no record
     (keeps them as "estimated" so the dashboard still shows something)
  7. Saves patched file back → closed-positions-ironclad.json
  8. Pushes to logs branch
"""

import json, re, os, subprocess, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
from datetime import datetime, timezone

try:
    import xlrd
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "xlrd", "-q"])
    import xlrd

FOLDER = r"C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\docs\live_bitget-trades"
CLOSED = r"C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\closed-positions-ironclad.json"
ORDERS = r"C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\trades-ironclad.csv"

# ── helpers ──────────────────────────────────────────────────────────────────

def strip_units(s):
    """'98.4699USDT' → 98.4699,  '71XRP' → 71"""
    m = re.match(r"[-\d.]+", str(s).strip())
    return float(m.group()) if m else 0.0

def parse_symbol(futures_str):
    """'XRPUSDT Long Isolated' → ('XRPUSDT', 'long')"""
    s = str(futures_str).replace('\xa0', ' ')
    parts = s.split()
    symbol = parts[0].upper()
    side   = 'long' if 'long' in s.lower() else 'short'
    return symbol, side

def near(a, b, pct=0.003):
    if b == 0: return False
    return abs(a - b) / abs(b) < pct

def ts_close(s):
    """'2026-05-08 16:24:09' → (date_str, time_str)"""
    dt = datetime.strptime(str(s), '%Y-%m-%d %H:%M:%S')
    return dt.strftime('%Y-%m-%d'), dt.strftime('%H:%M:%S')

def infer_exit_level(entry, close, side, sl, tp1, tp2, tp3):
    """Guess exit level from close price."""
    p = [('sl', sl), ('tp1', tp1), ('tp2', tp2), ('tp3', tp3)]
    for label, lvl in p:
        if lvl and near(close, lvl, 0.005):
            return label
    # fall back to P&L sign
    if side == 'long':
        return 'tp1' if close > entry else 'sl'
    else:
        return 'tp1' if close < entry else 'sl'

# ── 1. Read Bitget position history XLS ─────────────────────────────────────

def read_position_history():
    fname = next(f for f in os.listdir(FOLDER) if 'position history' in f and 'USDT-M' in f)
    wb = xlrd.open_workbook(os.path.join(FOLDER, fname))
    sh = wb.sheets()[0]
    rows = []
    for r in range(1, sh.nrows):          # skip header
        c = lambda i: sh.cell_value(r, i)
        symbol, side = parse_symbol(c(0))
        entry   = strip_units(c(2))
        exit_p  = strip_units(c(3))
        qty     = strip_units(c(4))       # just the number
        pos_pnl = strip_units(c(6))       # Position Pnl (gross)
        net_pnl = strip_units(c(7))       # Realized PnL (after fees)
        open_t  = str(c(1)).strip()
        close_t = str(c(11)).strip()
        close_date, close_time = ts_close(close_t)
        open_date = open_t[:10]
        open_time = open_t[11:]
        rows.append({
            'symbol': symbol, 'side': side,
            'entry': entry, 'exitPrice': exit_p, 'qty': qty,
            'realizedPnl': round(net_pnl, 4),
            'openDate': open_date, 'openTime': open_time,
            'closeDate': close_date, 'closeTime': close_time,
        })
    print(f"  Loaded {len(rows)} Bitget position records")
    return rows

# ── 2. Read Bitget order history XLS (maps open-order IDs to dates/prices) ──

def read_order_history():
    """Returns list of open orders with orderId, symbol, side, date, avgPrice."""
    fname = next(f for f in os.listdir(FOLDER) if 'order history' in f and 'USDT-M' in f)
    wb = xlrd.open_workbook(os.path.join(FOLDER, fname))
    sh = wb.sheets()[0]
    opens = []
    for r in range(1, sh.nrows):
        c = lambda i: sh.cell_value(r, i)
        direction = str(c(2)).lower()
        if 'open' not in direction:
            continue
        date_str  = str(c(0)).strip()
        order_id  = str(int(float(c(1)))) if c(1) else ''
        symbol    = str(c(3)).upper().strip()
        avg_price = strip_units(c(7)) if c(7) else strip_units(c(8))
        qty       = strip_units(c(9))
        side      = 'long' if 'long' in direction else 'short'
        opens.append({
            'orderId': order_id, 'symbol': symbol, 'side': side,
            'date': date_str[:10], 'time': date_str[11:],
            'avgPrice': avg_price, 'qty': qty,
        })
    print(f"  Loaded {len(opens)} open-order records from order history")
    return opens

# ── 3. Match a closed-position entry to a Bitget position record ─────────────

def find_bitget_record(pos, bitget_rows):
    """
    Match by: symbol + side + openDate (same day) + entry price close enough.
    Bitget aggregates multiple open orders into one position record, so the
    Bitget avg entry may differ slightly from any individual order's price.
    """
    sym  = pos.get('symbol', '')
    side = pos.get('side', '')
    entry = float(pos.get('entry', 0) or 0)
    open_date = str(pos.get('openDate', ''))

    candidates = [
        b for b in bitget_rows
        if b['symbol'] == sym
        and b['side'] == side
        and b['openDate'] == open_date
    ]
    # pick the one whose avg entry is closest
    if not candidates:
        return None
    best = min(candidates, key=lambda b: abs(b['entry'] - entry) if entry else 0)
    # reject if entry is wildly different (>2%) — different trade
    if entry and abs(best['entry'] - entry) / entry > 0.02:
        return None
    return best

# ── 4. Main ───────────────────────────────────────────────────────────────────

def main():
    print("\n══ Reconcile closed-positions-ironclad.json with Bitget XLS ══\n")

    # Pull latest from logs branch
    print("Pulling latest closed-positions from logs branch...")
    try:
        os.chdir(r"C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup")
        subprocess.run(
            'git fetch origin logs && git checkout origin/logs -- closed-positions-ironclad.json',
            shell=True, check=True, capture_output=True
        )
        print("  ✓ Pulled from logs branch")
    except Exception as e:
        print(f"  ⚠ Could not pull — using local file ({e})")

    # Load current closed positions
    with open(CLOSED, encoding='utf-8') as f:
        closed = json.load(f)
    print(f"  Loaded {len(closed)} closed-position records\n")

    # Load Bitget data
    print("Reading Bitget XLS files...")
    bitget_pos = read_position_history()
    bitget_ord = read_order_history()

    # Build a lookup: orderId → open order details (for price cross-check)
    ord_by_id = {o['orderId']: o for o in bitget_ord}

    # ── Deduplicate closed positions: keep last occurrence per id ─────────────
    seen_ids = {}
    for p in closed:
        seen_ids[p['id']] = p          # later entries overwrite earlier ones
    closed_dedup = list(seen_ids.values())
    dropped = len(closed) - len(closed_dedup)
    if dropped:
        print(f"\n  Removed {dropped} duplicate entry(ies)")
    closed = closed_dedup

    # ── Patch each live entry using Bitget position history ───────────────────
    patched = 0
    skipped_locked = 0
    estimated_kept = 0

    for pos in closed:
        pid = str(pos.get('id', ''))

        # Skip paper trades
        if pid.startswith('IRONCLAD-PAPER'):
            continue

        # Never touch already-locked entries
        if pos.get('locked'):
            skipped_locked += 1
            continue

        # Skip entries with no real data (open positions recorded with exitPrice=0)
        if not pos.get('entry'):
            continue

        # Try to find a matching Bitget position record
        brec = find_bitget_record(pos, bitget_pos)

        if brec:
            # Determine exit level
            sl  = float(pos.get('stopLoss', 0) or 0)
            tp1 = float(pos.get('tp1', 0) or 0)
            tp2 = float(pos.get('tp2', 0) or 0)
            tp3 = float(pos.get('tp3', 0) or 0)
            exit_level = infer_exit_level(
                brec['entry'], brec['exitPrice'], pos['side'], sl, tp1, tp2, tp3
            )
            outcome = 'WIN' if brec['realizedPnl'] >= 0 else 'LOSS'

            # When one Bitget position covers MULTIPLE open orders (e.g. 3× APT),
            # split P&L proportionally by position qty vs total Bitget qty.
            # pos['qty'] = this individual order's qty; brec['qty'] = combined qty.
            pos_qty     = float(pos.get('qty', 0) or 0)
            bitget_qty  = brec['qty']
            scale       = (pos_qty / bitget_qty) if bitget_qty > 0 else 1.0
            scaled_pnl  = round(brec['realizedPnl'] * scale, 4)

            old_exit = pos.get('exitPrice', 0)
            old_pnl  = pos.get('realizedPnl', 0)

            pos['exitPrice']   = brec['exitPrice']
            pos['realizedPnl'] = scaled_pnl
            pos['exitLevel']   = exit_level
            pos['closeDate']   = brec['closeDate']
            pos['closeTime']   = brec['closeTime']
            pos['outcome']     = outcome
            pos['source']      = 'bitget-verified'
            pos['locked']      = True

            # Update partialCloses to reflect real exit
            pos['partialCloses'] = [{
                'price': brec['exitPrice'],
                'level': exit_level,
                'date':  brec['closeDate'],
                'time':  brec['closeTime'],
                'pnl':   scaled_pnl,
            }]

            print(f"  ✅ {pos['symbol']:15s} {pos['side']:5s} {pos['openDate']}"
                  f"  exit ${brec['exitPrice']}  {exit_level:4s}"
                  f"  P&L {scaled_pnl:+.2f}"
                  f"  (was exit=${old_exit} pnl={old_pnl:+.2f})")
            patched += 1

        elif pos.get('source') == 'reconstructed-estimate':
            # No Bitget record found — keep the estimate but flag it clearly
            pos['source'] = 'estimated-no-bitget-record'
            pos['locked'] = False   # NOT locked — may be corrected later
            estimated_kept += 1
            print(f"  ⚠  {pos['symbol']:15s} {pos['side']:5s} {pos['openDate']}"
                  f"  — no Bitget record, keeping estimate (exit=${pos.get('exitPrice',0)})")

    print(f"\n  Summary: {patched} patched · {skipped_locked} already locked · {estimated_kept} estimated")

    # ── Save ─────────────────────────────────────────────────────────────────
    with open(CLOSED, 'w', encoding='utf-8') as f:
        json.dump(closed, f, indent=2)
    print(f"\n  Saved {len(closed)} records to closed-positions-ironclad.json")

    # ── Push to logs branch ───────────────────────────────────────────────────
    print("\nPushing to logs branch...")
    try:
        # Use temp branch approach (avoids non-fast-forward)
        subprocess.run('git fetch origin logs', shell=True, check=True, capture_output=True)
        subprocess.run('git checkout origin/logs -b _recon_temp 2>/dev/null || git checkout _recon_temp', shell=True, capture_output=True)
        subprocess.run('git checkout main -- closed-positions-ironclad.json', shell=True, check=True, capture_output=True)
        subprocess.run('git add closed-positions-ironclad.json', shell=True, check=True, capture_output=True)
        subprocess.run('git commit -m "fix: reconcile closed-positions with real Bitget XLS data (locked)"', shell=True, check=True, capture_output=True)
        subprocess.run('git push origin _recon_temp:logs', shell=True, check=True, capture_output=True)
        subprocess.run('git checkout main', shell=True, check=True, capture_output=True)
        subprocess.run('git branch -D _recon_temp', shell=True, capture_output=True)
        print("  ✓ Pushed to logs branch")
    except Exception as e:
        print(f"  ⚠ Push failed: {e}")
        print("    Manual push: git add closed-positions-ironclad.json && git push origin HEAD:logs")

    print("\n══ Done ══\n")

if __name__ == '__main__':
    main()
