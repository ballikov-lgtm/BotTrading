"""Debug why V2.1 backtest produces fewer entries than V2 on the same ticker.

Each backtest is run in its own subprocess so that the TextIOWrapper rewrap
at the top of each file doesn't break the other. Trade results are written to
a temp file and read back here for comparison.

Usage:
    cd SID
    python scripts/debug-v2-v21-entry.py AVGO
"""
from __future__ import annotations
import os, sys, subprocess, json, tempfile
from pathlib import Path

TICKER = sys.argv[1] if len(sys.argv) > 1 else 'AVGO'
SID_DIR = Path(__file__).resolve().parent.parent
SID_POSIX = str(SID_DIR).replace('\\', '/')

V2_CODE = '''
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import importlib.util
spec = importlib.util.spec_from_file_location("v2", r"{SID}/backtest-sid-v2.py")
v2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(v2)
import yfinance as yf, pandas as pd
from datetime import datetime, timedelta
TICKER = "{TICKER}"
end = datetime.now().date()
# Match V2's main(): download 5y warmup + 5y trade window, then filter trades to last 5y only
HISTORY_WARMUP_DAYS = 365 * 5 + 30
start_dl = end - timedelta(days=HISTORY_WARMUP_DAYS + 365*5)
backtest_start_str = (end - timedelta(days=365*5)).strftime("%Y-%m-%d")
df = yf.download(TICKER, start=start_dl, end=end+timedelta(days=1), auto_adjust=False, progress=False)
if isinstance(df.columns, pd.MultiIndex): df.columns = df.columns.get_level_values(0)
sys.stderr.write(f"[V2 SUB] df rows={{len(df)}} from {{df.index[0].date()}} to {{df.index[-1].date()}}\\n")
try:
    ec = json.loads(open(r"{SID}/.earnings-cache.json","r",encoding="utf-8").read())
    ed = ec.get(TICKER, [])
except Exception:
    ed = []
variant = next(v for v in v2.VARIANTS if v["name"] == "v2-weekly-or")
trades = v2.backtest_ticker(TICKER, df, variant, ed)
# Filter to actual trade window (V2's main() does this)
trades = [t for t in trades if t["entry_date"] >= backtest_start_str]
out = [
    dict(entry_date=t["entry_date"], side=t["side"],
         entry_price=float(t["entry_price"]), entry_rsi=float(t["entry_rsi"]),
         exit_date=t["exit_date"], exit_reason=t["exit_reason"], pnl=float(t["pnl"]))
    for t in trades
]
with open(r"{OUT}", "w", encoding="utf-8") as f: f.write(json.dumps(out))
'''

V21_CODE = '''
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import importlib.util
spec = importlib.util.spec_from_file_location("v21", r"{SID}/backtest-sid-v2.1.py")
v21 = importlib.util.module_from_spec(spec); spec.loader.exec_module(v21)
import yfinance as yf, pandas as pd
from datetime import datetime, timedelta
TICKER = "{TICKER}"
end = datetime.now().date()
# Match V2's main(): download 5y warmup + 5y trade window, then filter trades to last 5y only
HISTORY_WARMUP_DAYS = 365 * 5 + 30
start_dl = end - timedelta(days=HISTORY_WARMUP_DAYS + 365*5)
backtest_start_str = (end - timedelta(days=365*5)).strftime("%Y-%m-%d")
df = yf.download(TICKER, start=start_dl, end=end+timedelta(days=1), auto_adjust=False, progress=False)
if isinstance(df.columns, pd.MultiIndex): df.columns = df.columns.get_level_values(0)
try:
    ec = json.loads(open(r"{SID}/.earnings-cache.json","r",encoding="utf-8").read())
    ed = ec.get(TICKER, [])
except Exception:
    ed = []
variant = v21.VARIANTS[0]
trades = v21.backtest_ticker_v2_1(TICKER, df, variant, ed)
trades = [t for t in trades if t["entry_date"] >= backtest_start_str]
out = [
    dict(entry_date=t["entry_date"], side=t["side"],
         entry_price=float(t["entry_price"]), entry_rsi=float(t["entry_rsi"]),
         tp1_reason=t.get("tp1_reason"), tp2_reason=t.get("tp2_reason"),
         total_pnl=float(t.get("total_pnl", 0)))
    for t in trades
]
with open(r"{OUT}", "w", encoding="utf-8") as f: f.write(json.dumps(out))
'''


def run_block(label, code_tmpl):
    out_path = tempfile.mktemp(suffix=f'-{label}.json')
    code = code_tmpl.format(SID=SID_POSIX, TICKER=TICKER, OUT=out_path.replace('\\','/'))
    p = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, encoding='utf-8')
    if p.returncode != 0:
        print(f'[{label}] FAILED rc={p.returncode}')
        print(p.stderr[-1500:])
        return []
    try:
        return json.loads(open(out_path, 'r', encoding='utf-8').read())
    finally:
        try: os.remove(out_path)
        except: pass


print(f'Comparing V2 vs V2.1 entry behaviour on {TICKER}\n')
v2  = run_block('v2',  V2_CODE)
v21 = run_block('v21', V21_CODE)

print(f'V2  trades: {len(v2)}')
for t in v2:
    print(f"  {t['side']:5s} {t['entry_date']} rsi={t['entry_rsi']:5.1f} -> {t['exit_date']:10s} ({t['exit_reason']}) pnl ${t['pnl']:+.0f}")
print(f'\nV2.1 trades: {len(v21)}')
for t in v21:
    print(f"  {t['side']:5s} {t['entry_date']} rsi={t['entry_rsi']:5.1f} tp1={t.get('tp1_reason')} tp2={t.get('tp2_reason')} pnl ${t['total_pnl']:+.0f}")

v2_d  = set(t['entry_date'] for t in v2)
v21_d = set(t['entry_date'] for t in v21)
print(f'\nV2-only dates (n={len(v2_d - v21_d)}):')
for d in sorted(v2_d - v21_d): print(f'  {d}')
print(f'V2.1-only dates (n={len(v21_d - v2_d)}):')
for d in sorted(v21_d - v2_d): print(f'  {d}')
