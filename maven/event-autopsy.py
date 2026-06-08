#!/usr/bin/env python3
"""
event-autopsy.py — tag Maven trades that fell in a macro-event window and compare
their performance to the rest. Answers: did FOMC/CPI/PPI actually hurt our trades,
or did crypto ignore the print? (Alan, 2026-06-08)

Reads maven-trades.csv (entry time = `etime`, UTC) and event-dates.json.
A trade is "in-window" if its ENTRY falls in [event - PRE h, event + POST h].

  python3 event-autopsy.py                 # 48h pre / 2h post, all 3 events
  python3 event-autopsy.py --pre 48 --post 2 --events fomc
"""
import csv, json, argparse
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

def load_windows(events, pre_h, post_h):
    data = json.loads((HERE / "event-dates.json").read_text())
    times = data.get("_event_times_utc", {})
    pre, post = pre_h * 3600, post_h * 3600
    wins = []  # (start, end, event_type)
    for ev in events:
        ts = times.get(ev, "13:00"); hh, mm = int(ts[:2]), int(ts[3:5])
        for d in data.get(ev, []):
            e = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc, hour=hh, minute=mm).timestamp()
            wins.append((e - pre, e + post, ev))
    return wins

def which_event(ts, wins):
    for a, b, ev in wins:
        if a <= ts <= b:
            return ev
    return None

def stats(rows):
    n = len(rows)
    wins = [r for r in rows if float(r["pnl"]) > 0]
    gw = sum(float(r["pnl"]) for r in wins)
    gl = -sum(float(r["pnl"]) for r in rows if float(r["pnl"]) <= 0)
    net = sum(float(r["pnl"]) for r in rows)
    pf = (gw / gl) if gl > 0 else (float("inf") if gw > 0 else 0.0)
    wr = (100 * len(wins) / n) if n else 0.0
    return n, wr, pf, net

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=str(HERE / "maven-trades.csv"))
    ap.add_argument("--pre", type=float, default=48)
    ap.add_argument("--post", type=float, default=2)
    ap.add_argument("--events", default="fomc,cpi,ppi")
    a = ap.parse_args()
    events = [e.strip() for e in a.events.split(",") if e.strip()]
    wins = load_windows(events, a.pre, a.post)
    rows = list(csv.DictReader(open(a.csv, newline="")))
    inw, clean = [], []
    by_ev = {}
    for r in rows:
        try:
            ts = datetime.strptime(r["etime"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp()
        except Exception:
            clean.append(r); continue
        ev = which_event(ts, wins)
        (inw if ev else clean).append(r)
        if ev:
            by_ev.setdefault(ev, []).append(r)

    print(f"=== EVENT AUTOPSY ({a.pre:.0f}h pre / {a.post:.0f}h post · {events}) ===")
    print(f"trade log: {Path(a.csv).name} · {len(rows)} trades total\n")
    for label, grp in [("IN event window", inw), ("CLEAN (no event)", clean)]:
        n, wr, pf, net = stats(grp)
        share = (100 * n / len(rows)) if rows else 0
        print(f"  {label:<18} {n:>4} trades ({share:4.0f}% of all) | WR {wr:5.1f}% | PF {pf:5.2f} | net ${net:>8,.0f}")
    print()
    for ev in events:
        grp = by_ev.get(ev, [])
        if grp:
            n, wr, pf, net = stats(grp)
            print(f"   - {ev.upper():<5} {n:>3} trades | WR {wr:5.1f}% | PF {pf:5.2f} | net ${net:>8,.0f}")
    print("\nRead: if IN-window trades have a much LOWER PF / more negative net than CLEAN,")
    print("the events hurt us and a blackout helps. If they're similar, crypto ignored them.")

if __name__ == "__main__":
    main()
