"""
fetch-bars.py — Fetches OHLCV bars via yfinance and prints JSON to stdout.
Called by scan-sid.js as a subprocess.

Usage:
  python fetch-bars.py <SYMBOL> <INTERVAL> <PERIOD>

  INTERVAL: 1d | 1wk
  PERIOD:   14mo | 4y | etc (yfinance period string)
"""
import sys, json
import yfinance as yf
import pandas as pd

if len(sys.argv) < 4:
    print(json.dumps({"error": "Usage: python fetch-bars.py <SYMBOL> <INTERVAL> <PERIOD>"}), file=sys.stderr)
    sys.exit(1)

symbol, interval, period = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    df = yf.download(symbol, period=period, interval=interval, auto_adjust=False,
                     progress=False, threads=False, multi_level_index=False)
except Exception as e:
    print(json.dumps({"error": f"yfinance.download failed: {e}"}))
    sys.exit(1)

if df is None or df.empty:
    print(json.dumps({"error": f"No data returned for {symbol}"}))
    sys.exit(1)

bars = []
for idx, row in df.iterrows():
    if pd.isna(row.get("Close")):
        continue
    bars.append({
        "date":   pd.Timestamp(idx).isoformat(),
        "open":   float(row["Open"])  if not pd.isna(row.get("Open"))   else None,
        "high":   float(row["High"])  if not pd.isna(row.get("High"))   else None,
        "low":    float(row["Low"])   if not pd.isna(row.get("Low"))    else None,
        "close":  float(row["Close"]),
        "volume": int(row["Volume"])  if not pd.isna(row.get("Volume")) else 0,
    })

print(json.dumps(bars))
