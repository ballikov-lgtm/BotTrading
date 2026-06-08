#!/usr/bin/env python3
"""
backtest-maven.py — Maven: 4h mean-reversion 20-SMA trend rider, both directions.

Built on the CATS rig (keyless Bitget klines + stdlib indicators). Mirrors MAVEN.md.

RULES (per MAVEN.md, 2026-06-07):
  Regime      : the ASSET's own DAILY 200 SMA. Price above = BULL, below = BEAR.
  LONG  arm   : within last ARM bars, 4h RSI dipped to the oversold trigger
                (regime-adaptive: BULL=bull_os e.g. 32, BEAR=bear_os e.g. 30) — early trigger only.
  LONG  entry : first 4h candle CLOSES back ABOVE the 20 SMA, with 4h RSI turning up AND
                MACD histogram turning up. Enter at the NEXT 4h open. RSI need NOT still be oversold.
  SHORT arm   : within last ARM bars, 4h RSI reached the overbought trigger (ob, e.g. 70) — ANY regime.
  SHORT entry : first 4h candle CLOSES back BELOW the 20 SMA, RSI turning down AND MACD hist turning down.
  Stop        : tighter of (confirmation-candle wick) or (2%).  long: wick=low / short: wick=high.
  TP1         : 50% off at 4h RSI 50, then stop -> break-even + round-trip fees (runner can't post-fee-lose).
  TP2 (runner): exit the rest when a 1h candle CLOSES back through the 4h 20 SMA (below=long / above=short).
  Time stop   : force-exit after 20 x 4h candles (~3.3 days).
  Risk        : 1% of equity per trade. Costs: fee_bps/side (default 8 = ~0.06% taker + ~0.02% slip).

DATA: Bitget public spot klines, keyless. NOTE: this sandbox cannot reach exchanges —
      run this in Alan's environment (same as backtest-cats.py).

EXAMPLES:
  python3 backtest-maven.py --selftest                         # offline sanity check (no network)
  python3 backtest-maven.py --basket --start 2023-01-01 --end 2026-06-01 --append
  python3 backtest-maven.py --symbol SOLUSDT --start 2023-01-01 --end 2026-06-01
  python3 backtest-maven.py --basket --sweep                   # sweep bull oversold 30/32/35/40
  python3 backtest-maven.py --basket --no-shorts               # longs only
  # CROSS-ARMED v3 (the TradingView-validated config): 4h 20x200 cross gate + 20/200 gap,
  # RSI floor 35, longs-only. Expect runner-alts (SOL/VIRTUAL) to shine, majors/rangers weak.
  python3 backtest-maven.py --basket --use-cross-gate --min-sep 3 --bull-os 35 --bear-os 35 --ob 65 --start 2023-01-01 --end 2026-06-01
  python3 backtest-maven.py --basket --use-cross-gate --min-sep 3 --bull-os 35 --bear-os 35 --no-shorts --start 2023-01-01 --end 2026-06-01
"""
import sys, json, time, argparse, csv, urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
BITGET = "https://api.bitget.com"
GRAN = {"1h": "1h", "4h": "4h", "1d": "1day"}
FOURH_MS = 14400000
DAY_MS = 86400000

# Liquidity-based basket + runners (Alan, 2026-06-07). VIRTUAL flagged volatile (auto-dropped if no edge).
DEFAULT_BASKET = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "LINKUSDT",
                  "HYPEUSDT", "RENDERUSDT", "SUIUSDT", "VIRTUALUSDT"]

# ── HTTP + indicators (stdlib) ───────────────────────────────────────────────
def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "maven-backtest/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())

def fetch_candles(symbol, tf, start_ms, end_ms):
    """Page Bitget history-candles backward until [start,end] covered. Ascending list of dicts."""
    out, cursor = {}, end_ms
    while cursor > start_ms:
        url = (f"{BITGET}/api/v2/spot/market/history-candles?symbol={symbol}"
               f"&granularity={GRAN[tf]}&endTime={cursor}&limit=200")
        j = _get(url)
        rows = j.get("data") or []
        if not rows:
            break
        for r in rows:
            ts = int(r[0])
            out[ts] = {"ts": ts, "o": float(r[1]), "h": float(r[2]), "l": float(r[3]), "c": float(r[4])}
        oldest = min(int(r[0]) for r in rows)
        if oldest >= cursor:
            break
        cursor = oldest
        time.sleep(0.08)
    return [out[k] for k in sorted(out) if k <= end_ms]

CACHE_DIR = HERE / ".cache"
def fetch_candles_cached(symbol, tf, start_ms, end_ms):
    """Disk-cache wrapper around fetch_candles so repeat backtests are instant."""
    try:
        CACHE_DIR.mkdir(exist_ok=True)
        fp = CACHE_DIR / f"{symbol}_{tf}_{start_ms}_{end_ms}.json"
        if fp.exists():
            return json.loads(fp.read_text())
        data = fetch_candles(symbol, tf, start_ms, end_ms)
        fp.write_text(json.dumps(data))
        return data
    except Exception:
        return fetch_candles(symbol, tf, start_ms, end_ms)

# ── macro-event blackout (Alan, 2026-06-08): skip entries in a window around FOMC/CPI/PPI
def load_blackout_windows(P):
    """Build [ (start_ms, end_ms) ] blackout windows from event-dates.json.
    Window = [event - blackout_pre_h, event + blackout_post_h]. Default OFF."""
    if not P.get("event_blackout"):
        return []
    try:
        data = json.loads((HERE / "event-dates.json").read_text())
    except Exception:
        print("  [blackout] event-dates.json not found — blackout disabled."); return []
    times = data.get("_event_times_utc", {})
    pre = int(P.get("blackout_pre_h", 48) * 3600 * 1000)
    post = int(P.get("blackout_post_h", 2) * 3600 * 1000)
    wins = []
    for ev in P.get("blackout_events", ["fomc", "cpi", "ppi"]):
        ts = times.get(ev, "13:00"); hh, mm = int(ts[:2]), int(ts[3:5])
        for d in data.get(ev, []):
            dt = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc, hour=hh, minute=mm)
            ems = int(dt.timestamp() * 1000)
            wins.append((ems - pre, ems + post))
    wins.sort()
    return wins

def in_blackout(ts, wins):
    for a, b in wins:
        if a <= ts <= b:
            return True
        if a > ts:
            break
    return False

def rsi_series(closes, period=14):
    out = [None]*len(closes)
    if len(closes) < period+1:
        return out
    g = l = 0.0
    for i in range(1, period+1):
        ch = closes[i]-closes[i-1]; g += max(ch, 0); l += max(-ch, 0)
    ag, al = g/period, l/period
    out[period] = 100 - 100/(1+(ag/al)) if al else 100.0
    for i in range(period+1, len(closes)):
        ch = closes[i]-closes[i-1]
        ag = (ag*(period-1)+max(ch, 0))/period
        al = (al*(period-1)+max(-ch, 0))/period
        out[i] = 100 - 100/(1+(ag/al)) if al else 100.0
    return out

def sma_series(vals, period):
    out = [None]*len(vals)
    if period <= 0:
        return out
    s = 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= period:
            s -= vals[i-period]
        if i >= period-1:
            out[i] = s/period
    return out

def ema_series(vals, period):
    out = [None]*len(vals)
    if len(vals) < period:
        return out
    k = 2/(period+1); e = sum(vals[:period])/period; out[period-1] = e
    for i in range(period, len(vals)):
        e = vals[i]*k + e*(1-k); out[i] = e
    return out

def macd_hist_series(closes, fast=12, slow=26, sig=9):
    """MACD histogram (macd line - signal). None where undefined."""
    ef, es = ema_series(closes, fast), ema_series(closes, slow)
    macd = [(ef[i]-es[i]) if (ef[i] is not None and es[i] is not None) else None for i in range(len(closes))]
    idx = [i for i, v in enumerate(macd) if v is not None]
    sig_line = [None]*len(closes)
    if len(idx) >= sig:
        vals = [macd[i] for i in idx]
        esig = ema_series(vals, sig)
        for pos, i in enumerate(idx):
            sig_line[i] = esig[pos]
    return [(macd[i]-sig_line[i]) if (macd[i] is not None and sig_line[i] is not None) else None
            for i in range(len(closes))]

def atr_series(c, period=14):
    out = [None]*len(c)
    if len(c) < period+1:
        return out
    trs = [max(c[i]["h"]-c[i]["l"], abs(c[i]["h"]-c[i-1]["c"]), abs(c[i]["l"]-c[i-1]["c"])) for i in range(1, len(c))]
    a = sum(trs[:period])/period; out[period] = a
    for i in range(period+1, len(c)):
        a = (a*(period-1)+trs[i-1])/period; out[i] = a
    return out

# ── asset DAILY 200-SMA regime ───────────────────────────────────────────────
def daily_regime_fn(symbol, start_ms, end_ms, sma_len=200, prefetched=None, slope_d=5):
    d = prefetched if prefetched is not None else fetch_candles_cached(symbol, "1d", start_ms - DAY_MS*(sma_len+15), end_ms)
    closes = [x["c"] for x in d]
    use = sma_len if len(closes) >= sma_len else max(20, len(closes)//2)
    sma = sma_series(closes, use)
    regimes = {}; slopes = {}   # slopes: +1 daily-200 rising / -1 falling / 0 flat-or-unknown
    for i in range(len(d)):
        s = sma[i]
        regimes[d[i]["ts"]] = "NEUTRAL" if s is None else ("BULL" if closes[i] > s else "BEAR")
        sp = 0
        if s is not None and i >= slope_d and sma[i-slope_d] is not None:
            sp = 1 if s > sma[i-slope_d] else (-1 if s < sma[i-slope_d] else 0)
        slopes[d[i]["ts"]] = sp
    days = sorted(regimes)
    def lookup(ts):
        best = "NEUTRAL"
        for day in days:
            if day <= ts:
                best = regimes[day]
            else:
                break
        return best
    def dslope(ts):           # last confirmed daily-200 slope at/just before ts
        best = 0
        for day in days:
            if day <= ts:
                best = slopes[day]
            else:
                break
        return best
    return lookup, dslope, (len(closes) >= sma_len)

# ── core backtest (accepts pre-fetched candles so it is unit-testable offline) ─
def run_core(symbol, c4, c1, regime_lookup, P, dslope_lookup=None, return_open=False):
    closes4 = [x["c"] for x in c4]
    sma20 = sma_series(closes4, P["sma"])
    sma200 = sma_series(closes4, P["sma200"])   # cross-armed v3: the 4h slow line
    rsi4 = rsi_series(closes4, P["rsi_len"])
    hist4 = macd_hist_series(closes4)
    atr4 = atr_series(c4, 14)

    # group 1h candles by their parent 4h open ts (for the TP2 runner exit)
    groups = {}
    for cc in c1:
        parent = cc["ts"] - (cc["ts"] % FOURH_MS)
        groups.setdefault(parent, []).append(cc)
    for k in groups:
        groups[k].sort(key=lambda x: x["ts"])

    cost = (P["fee_bps"]/10000.0) if P["use_costs"] else 0.0
    equity = 10000.0
    trades = []
    pos = None
    pending = None
    last_exit_i = -10**9
    n = 0
    warm = max(P["sma"], 35, P["rsi_len"]+1, 30)

    for i in range(warm, len(c4)):
        bar = c4[i]
        s20 = sma20[i]; r = rsi4[i]; h = hist4[i]
        if s20 is None or r is None or h is None or rsi4[i-1] is None or hist4[i-1] is None:
            continue

        # 0) execute a pending entry at THIS bar's open (next-open fill, no lookahead)
        if pending is not None and i == pending["enter_i"]:
            side = pending["side"]; entry = bar["o"]; conf = pending["conf"]  # confirmation candle
            a = atr4[i] if atr4[i] is not None else 0.0
            buf = P["atr_buf"]*a   # optional breathing room beyond the level
            stop = None; risk = 0.0
            if P["stop_mode"] == "prevclose":
                # WIDER stop: close of the candle before confirmation (last close beyond the 20 SMA), no 2% cap
                pc = pending["prev_close"]
                if side == "LONG":
                    stop = pc - buf; risk = entry - stop
                else:
                    stop = pc + buf; risk = stop - entry
            elif P["stop_mode"] == "swing":
                # SID-style: lowest-low wick (long) / highest-high wick (short) since the signal armed
                if side == "LONG":
                    stop = pending["swing_low"] - buf; risk = entry - stop
                else:
                    stop = pending["swing_high"] + buf; risk = stop - entry
            if stop is None or risk <= 0:   # wick-or-2% (default 'wick2', or fallback if a wider mode is invalid)
                if side == "LONG":
                    w = conf["l"] - buf; rw = entry - w
                    risk = entry*P["max_risk"] if rw <= 0 else min(rw, entry*P["max_risk"]); stop = entry - risk
                else:
                    w = conf["h"] + buf; rw = w - entry
                    risk = entry*P["max_risk"] if rw <= 0 else min(rw, entry*P["max_risk"]); stop = entry + risk
            pending = None
            if risk > 0:
                n += 1
                q = (equity*P["risk_pct"]/100)/risk
                pos = {"num": n, "symbol": symbol, "side": side, "regime": pending_regime,
                       "entry": entry, "stop": stop, "stop_orig": stop, "risk": risk,
                       "qty": q, "qty_open": q, "half": q*P["tp1_pct"], "tp1_done": False, "realized": 0.0,
                       "entry_i": i, "rsi_entry": round(r, 1),
                       "entry_ts": bar["ts"], "risk_amt": equity*P["risk_pct"]/100,  # for the portfolio sim
                       "etime": datetime.fromtimestamp(bar["ts"]/1000, timezone.utc).strftime("%Y-%m-%d %H:%M")}
            # do not manage on the entry bar
            continue

        # 1) manage an open position (only after its entry bar)
        if pos is not None and i > pos["entry_i"]:
            sgn = 1 if pos["side"] == "LONG" else -1
            closed = False
            # a) stop / break-even-stop (checked first, conservative, on 4h extremes)
            stop_hit = (bar["l"] <= pos["stop"]) if pos["side"] == "LONG" else (bar["h"] >= pos["stop"])
            if stop_hit:
                px = pos["stop"]
                pos["realized"] += (px-pos["entry"])*sgn*pos["qty_open"] - cost*px*pos["qty_open"]
                pos["exit"] = px; pos["reason"] = "BE-STOP" if pos["tp1_done"] else "STOP"; closed = True
            else:
                # b) TP1: half off at 4h RSI 50, move stop to break-even + round-trip fees
                if not pos["tp1_done"]:
                    tp1_hit = (r >= P["tp1_rsi"]) if pos["side"] == "LONG" else (r <= P["tp1_rsi"])
                    if tp1_hit:
                        px = bar["c"]
                        pos["realized"] += (px-pos["entry"])*sgn*pos["half"] - cost*px*pos["half"]
                        pos["qty_open"] -= pos["half"]
                        be = pos["entry"]*(1 + sgn*2*cost)   # break-even + fees
                        pos["stop"] = be
                        pos["tp1_done"] = True
                # c) TP2 runner: a 1h candle closes back through the 4h 20 SMA (use last CLOSED 4h SMA)
                ref = sma20[i-1]
                win = groups.get(bar["ts"], [])
                tp2_px = None
                if ref is not None:
                    for cc in win:
                        through = (cc["c"] < ref) if pos["side"] == "LONG" else (cc["c"] > ref)
                        if through:
                            tp2_px = cc["c"]; break
                timeout = (i - pos["entry_i"]) >= P["max_bars"]
                if tp2_px is not None or timeout:
                    px = tp2_px if tp2_px is not None else bar["c"]
                    pos["realized"] += (px-pos["entry"])*sgn*pos["qty_open"] - cost*px*pos["qty_open"]
                    pos["exit"] = px; pos["reason"] = "TP2" if tp2_px is not None else "TIME"; closed = True
            if closed:
                pnl = pos["realized"] - cost*pos["entry"]*pos["qty"]   # entry-side cost on full size
                equity += pnl
                trades.append({**pos, "stop": pos["stop_orig"], "exit": pos.get("exit", bar["c"]),
                               "pnl": round(pnl, 2), "result": "WIN" if pnl > 0 else "LOSS",
                               "exit_ts": bar["ts"],
                               "R": (pnl / pos["risk_amt"]) if pos.get("risk_amt") else 0.0,        # outcome in risk-multiples (sizing-invariant)
                               "stop_frac": (pos["risk"] / pos["entry"]) if pos["entry"] else 0.0,  # stop distance as a fraction of entry
                               "xtime": datetime.fromtimestamp(bar["ts"]/1000, timezone.utc).strftime("%Y-%m-%d %H:%M")})
                pos = None; last_exit_i = i

        # 2) detect a NEW setup (flat, no pending, past cooldown) -> arm entry for next bar
        if pos is None and pending is None and (i - last_exit_i) >= P["cooldown"] \
                and not (P.get("blackout_windows") and in_blackout(bar["ts"], P["blackout_windows"])):
            reg = regime_lookup(bar["ts"])
            lo = max(0, i-P["arm"]+1)
            recent = [x for x in rsi4[lo:i+1] if x is not None]
            if not recent:
                continue
            os_th = P["bull_os"] if reg == "BULL" else P["bear_os"]
            armed_long = min(recent) <= os_th
            armed_short = max(recent) >= P["ob"]
            reclaim_up = (bar["c"] > s20 and c4[i-1]["c"] <= sma20[i-1]) if sma20[i-1] is not None else False
            reclaim_dn = (bar["c"] < s20 and c4[i-1]["c"] >= sma20[i-1]) if sma20[i-1] is not None else False
            rsi_up = rsi4[i] > rsi4[i-1]; rsi_dn = rsi4[i] < rsi4[i-1]
            macd_up = hist4[i] > hist4[i-1]; macd_dn = hist4[i] < hist4[i-1]
            long_sig = armed_long and reclaim_up and rsi_up and macd_up
            short_sig = P["shorts"] and armed_short and reclaim_dn and rsi_dn and macd_dn
            if P.get("shorts_bear_only") and reg != "BEAR":
                short_sig = False
            if P.get("with_regime"):       # trade WITH the daily 200 trend only
                if reg != "BULL": long_sig = False
                if reg != "BEAR": short_sig = False
            # cross-armed v3 (Alan, 2026-06-07): only trade an ESTABLISHED 4h trend.
            #   gate: long only when 20 SMA > 200 SMA, short only when 20 < 200
            #   gap : require the 20 to sit >= min_sep_pct away from the 200 (skip the
            #         cross/transition zone where shorts get squeezed & longs chop).
            s200 = sma200[i]
            if P.get("use_cross_gate"):
                if not (s200 is not None and s20 > s200): long_sig = False
                if not (s200 is not None and s20 < s200): short_sig = False
            if P.get("min_sep_pct", 0.0) > 0:
                sep_ok = s200 is not None and s200 != 0 and abs(s20 - s200) / s200 * 100 >= P["min_sep_pct"]
                if not sep_ok:
                    long_sig = False; short_sig = False
            # MTF 200-slope agreement (Alan, 2026-06-07): long needs BOTH the 4h 200 and the
            # daily 200 rising; short needs BOTH falling. Kills shorts taken in a daily uptrend.
            if P.get("mtf_slope_gate"):
                sl4 = P["slope_4h"]
                s4_prev = sma200[i-sl4] if i-sl4 >= 0 else None
                up4 = s200 is not None and s4_prev is not None and s200 > s4_prev
                dn4 = s200 is not None and s4_prev is not None and s200 < s4_prev
                dsl = dslope_lookup(bar["ts"]) if dslope_lookup is not None else None
                upD = dsl is None or dsl > 0      # daily 200 rising (None => daily unavailable, skip daily leg)
                dnD = dsl is None or dsl < 0      # daily 200 falling
                if not (up4 and upD): long_sig = False
                if not (dn4 and dnD): short_sig = False
            if long_sig or short_sig:
                pending = {"side": "LONG" if long_sig else "SHORT", "enter_i": i+1, "conf": bar,
                           "prev_close": c4[i-1]["c"],
                           "swing_low": min(x["l"] for x in c4[lo:i+1]),
                           "swing_high": max(x["h"] for x in c4[lo:i+1])}
                pending_regime = reg
    if return_open:
        # live bot needs: closed trades, any still-OPEN position, and any ARMED-but-not-yet-entered signal
        return trades, pos, pending
    return trades

# ── fetch wrapper + summary ──────────────────────────────────────────────────
def run(symbol, start, end, P):
    start_ms = int(datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()*1000)
    end_ms   = int(datetime.strptime(end,   "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()*1000)
    print(f"Fetching {symbol} (4h + 1h + daily regime)...")
    c4 = fetch_candles_cached(symbol, "4h", start_ms, end_ms)
    c1 = fetch_candles_cached(symbol, "1h", start_ms, end_ms)
    if len(c4) < 260:
        print(f"  {symbol}: not enough 4h data ({len(c4)} bars) — skipping."); return []
    reg_lookup, dslope_lookup, full = daily_regime_fn(symbol, start_ms, end_ms, slope_d=P.get("slope_d", 5))
    if not full:
        print(f"  {symbol}: WARNING young coin — <200 daily bars, regime uses a shorter SMA fallback.")
    c4 = [x for x in c4 if x["ts"] >= start_ms]
    trades = run_core(symbol, c4, c1, reg_lookup, P, dslope_lookup)
    s = summarize(trades)
    print(f"  {symbol}: {s['n']} trades | WR {s['wr']:.1f}% | PF {s['pf']:.2f} | net ${s['net']:,.0f} ({s['ret']:+.1f}%)")
    return trades

def engine_state(symbol, start, end, P):
    """LIVE/PAPER bot helper. Fetch recent candles and run the EXACT validated engine,
    returning (closed_trades, open_pos, pending) so the bot can mirror it 1:1 (live == backtest).
      open_pos = a position the engine is currently holding (entered on a past closed bar)
      pending  = a signal that fired on the last closed bar (entry executes next 4h open)
    Returns ([], None, None) if not enough data."""
    start_ms = int(datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()*1000)
    end_ms   = int(datetime.strptime(end,   "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()*1000)
    c4 = fetch_candles_cached(symbol, "4h", start_ms, end_ms)
    c1 = fetch_candles_cached(symbol, "1h", start_ms, end_ms)
    if len(c4) < 210:
        return [], None, None
    reg_lookup, dslope_lookup, _ = daily_regime_fn(symbol, start_ms, end_ms, slope_d=P.get("slope_d", 5))
    Pl = dict(P); Pl["blackout_windows"] = load_blackout_windows(Pl)
    trades, pos, pending = run_core(symbol, c4, c1, reg_lookup, Pl, dslope_lookup, return_open=True)
    scan = scan_snapshot(c4, P, dslope_lookup, pos)
    return trades, pos, pending, scan

def scan_snapshot(c4, P, dslope_lookup, pos):
    """Latest-bar 'radar' state for the dashboard: where this coin sits vs the Maven setup.
    status: IN-TRADE / ARMED (gate open + RSI in the pullback zone) / WATCHING (gate open,
    waiting for a dip) / GATED (trend not established -> no trades)."""
    closes = [x["c"] for x in c4]
    s20 = sma_series(closes, P["sma"]); s200 = sma_series(closes, P["sma200"]); r = rsi_series(closes, P["rsi_len"])
    i = len(c4) - 1
    if i < 0 or s200[i] is None or r[i] is None or s20[i] is None:
        return None
    sl = P.get("slope_4h", 10)
    slope4h_up = i - sl >= 0 and s200[i - sl] is not None and s200[i] > s200[i - sl]
    dsl = dslope_lookup(c4[i]["ts"]) if dslope_lookup else None
    dslope_up = dsl is not None and dsl > 0
    gap = abs(s20[i] - s200[i]) / s200[i] * 100 if s200[i] else 0.0
    floor = P["bull_os"]
    cross_ok = (not P.get("use_cross_gate")) or s20[i] > s200[i]
    gap_ok   = (P.get("min_sep_pct", 0) <= 0) or gap >= P["min_sep_pct"]
    mtf_ok   = (not P.get("mtf_slope_gate")) or (slope4h_up and dslope_up)
    gate_open = cross_ok and gap_ok and mtf_ok
    status = ("IN-TRADE" if pos is not None else
              "ARMED" if (gate_open and r[i] <= floor) else
              "WATCHING" if gate_open else "GATED")
    return {"rsi": round(r[i], 1), "price": closes[i], "gap_pct": round(gap, 1),
            "rsi_floor": floor, "gate_open": gate_open, "cross_ok": cross_ok,
            "gap_ok": gap_ok, "slope4h_up": slope4h_up, "dslope_up": dslope_up,
            "status": status}

def summarize(trades):
    n = len(trades)
    wins = [t for t in trades if t["pnl"] > 0]
    gw = sum(t["pnl"] for t in wins); gl = -sum(t["pnl"] for t in trades if t["pnl"] <= 0)
    net = sum(t["pnl"] for t in trades)
    return {"n": n, "wins": len(wins), "wr": (100*len(wins)/n if n else 0),
            "pf": (gw/gl if gl > 0 else (float('inf') if gw > 0 else 0)),
            "net": net, "ret": net/100.0}  # ret% on 10000 start

# ── PORTFOLIO simulation (Alan, 2026-06-08): replay coin-level trades on ONE shared,
#    concurrency-capped, leverage-capped, compounding account = the real live behaviour.
def portfolio_sim(all_trades, start_equity=1000.0, risk_pct=2.0, max_concurrent=3, leverage_cap=3.0):
    import heapq
    trs = sorted([t for t in all_trades if t.get("entry_ts") and t.get("exit_ts")],
                 key=lambda t: t["entry_ts"])
    open_heap = []          # min-heap of (exit_ts, notional, pnl_at_exit, symbol)
    equity = start_equity; peak = equity; maxdd = 0.0
    taken = wins = 0; skip_conc = skip_lev = sized_down = 0; max_conc_seen = 0
    def close_due(until_ts):
        nonlocal equity, peak, maxdd, wins
        while open_heap and open_heap[0][0] <= until_ts:
            _, _, pnl, _ = heapq.heappop(open_heap)
            equity += pnl
            if pnl > 0: wins += 1
            peak = max(peak, equity)
            if peak > 0: maxdd = max(maxdd, (peak - equity) / peak)
    for t in trs:
        close_due(t["entry_ts"])                 # free slots / bank P&L before this entry
        if len(open_heap) >= max_concurrent:
            skip_conc += 1; continue
        sf = t.get("stop_frac", 0) or 0
        if sf <= 0:
            skip_lev += 1; continue
        risk_amt = risk_pct / 100.0 * equity
        desired = risk_amt / sf                  # position notional ($) to risk risk_amt at the stop
        open_notional = sum(n for (_, n, _, _) in open_heap)
        room = leverage_cap * equity - open_notional
        if room <= 0:
            skip_lev += 1; continue
        notional = min(desired, room)
        if notional < desired - 1e-9:
            sized_down += 1
        actual_risk = risk_amt * (notional / desired)   # sized-down trades risk proportionally less
        heapq.heappush(open_heap, (t["exit_ts"], notional, t["R"] * actual_risk, t["symbol"]))
        taken += 1; max_conc_seen = max(max_conc_seen, len(open_heap))
    close_due(float("inf"))
    return {"start": start_equity, "final": equity, "ret_pct": (equity/start_equity - 1) * 100,
            "maxdd_pct": maxdd * 100, "signals": len(trs), "taken": taken, "wins": wins,
            "wr": (100 * wins / taken if taken else 0), "skip_conc": skip_conc,
            "skip_lev": skip_lev, "sized_down": sized_down, "max_concurrent": max_conc_seen}

def write_csv(trades, path):
    cols = ["num", "symbol", "side", "regime", "rsi_entry", "entry", "stop", "exit",
            "pnl", "result", "reason", "tp1_done", "etime", "xtime"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(cols)
        for t in trades:
            w.writerow([t.get(c, "") for c in cols])

# ── offline self-test (no network) ───────────────────────────────────────────
def selftest():
    import math
    print("[selftest] building synthetic 4h/1h data (no network)...")
    base = 1_600_000_000_000
    c4 = []
    px = 100.0
    for i in range(400):
        # oscillating wave + mild uptrend -> produces both oversold and overbought arms
        px = 100 + 0.05*i + 18*math.sin(i/9.0) + 4*math.sin(i/2.3)
        o = px - math.sin(i)*0.5
        hi = max(o, px) + 1.2; loo = min(o, px) - 1.2
        c4.append({"ts": base + i*FOURH_MS, "o": round(o, 2), "h": round(hi, 2), "l": round(loo, 2), "c": round(px, 2)})
    c1 = []
    for b in c4:
        for k in range(4):
            t = b["ts"] + k*3600000
            frac = (k+1)/4.0
            cc = b["o"] + (b["c"]-b["o"])*frac
            c1.append({"ts": t, "o": round(b["o"], 2), "h": round(b["h"], 2), "l": round(b["l"], 2), "c": round(cc, 2)})
    P = default_params()
    P["use_costs"] = True
    reg = (lambda ts: "BULL")
    trades = run_core("TESTUSDT", c4, c1, reg, P)
    s = summarize(trades)
    longs = sum(1 for t in trades if t["side"] == "LONG"); shorts = s["n"]-longs
    print(f"[selftest] ran OK: {s['n']} trades ({longs}L/{shorts}S), WR {s['wr']:.0f}%, PF {s['pf']:.2f}, net ${s['net']:,.0f}")
    assert isinstance(trades, list)
    reasons = sorted({t.get("reason", "?") for t in trades})
    print(f"[selftest] exit reasons seen: {reasons}")
    print("[selftest] PASS — engine loads, indicators compute, trade loop completes.")

def default_params():
    return {"sma": 20, "rsi_len": 14, "bull_os": 32, "bear_os": 30, "ob": 70,
            "arm": 6, "tp1_rsi": 50, "tp1_pct": 0.5, "max_bars": 20, "max_risk": 0.02,
            "risk_pct": 1.0, "fee_bps": 8.0, "use_costs": True, "cooldown": 1,
            "shorts": True, "shorts_bear_only": False, "with_regime": False, "atr_buf": 0.0,
            "stop_mode": "wick2",
            # cross-armed v3 (Alan, 2026-06-07): 4h 20x200 cross gate + 20/200 gap filter.
            # Default OFF so the original reversal model is unchanged. Turn on with
            # --use-cross-gate (+ --min-sep, and usually --bull-os 35 --bear-os 35 --ob 65).
            "sma200": 200, "use_cross_gate": False, "min_sep_pct": 0.0,
            # MTF 200-slope agreement (Alan, 2026-06-07): long needs BOTH the 4h 200 AND
            # the daily 200 sloping UP; short needs BOTH sloping DOWN. Stops shorts firing
            # in a daily uptrend (the squeeze). slope_4h/slope_d = lookback bars per TF.
            "mtf_slope_gate": False, "slope_4h": 10, "slope_d": 5,
            # macro-event blackout (Alan, 2026-06-08): no new entries in a window around
            # FOMC/CPI/PPI. Default OFF. blackout_windows is filled by load_blackout_windows().
            "event_blackout": False, "blackout_pre_h": 48, "blackout_post_h": 2,
            "blackout_events": ["fomc", "cpi", "ppi"], "blackout_windows": []}

# ── CLI ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Maven 4h mean-reversion 20-SMA backtest")
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--basket", action="store_true", help="run the whole default basket")
    ap.add_argument("--symbols", default=None, help="custom comma-separated basket, e.g. SOLUSDT,VIRTUALUSDT,PEPEUSDT (overrides --basket)")
    ap.add_argument("--start", default="2023-01-01")
    ap.add_argument("--end", default="2026-06-01")
    ap.add_argument("--bull-os", type=float, default=32, help="long oversold trigger in a daily-200 BULL regime")
    ap.add_argument("--bear-os", type=float, default=30, help="long oversold trigger in a daily-200 BEAR regime")
    ap.add_argument("--ob", type=float, default=70, help="short overbought trigger (any regime)")
    ap.add_argument("--arm", type=int, default=6, help="how many 4h bars back the OB/OS trigger may have fired")
    ap.add_argument("--max-bars", type=int, default=20, help="time stop in 4h candles")
    ap.add_argument("--risk", type=float, default=1.0, help="percent of equity risked per trade")
    # --- portfolio sim (Alan, 2026-06-08): one shared, concurrency- & leverage-capped account ---
    ap.add_argument("--portfolio", action="store_true", help="after the per-coin runs, replay all trades on ONE shared account (the real live model)")
    ap.add_argument("--start-equity", type=float, default=1000.0, help="portfolio sim starting account (default 1000)")
    ap.add_argument("--max-concurrent", type=int, default=3, help="portfolio sim: max positions open at once (default 3)")
    ap.add_argument("--leverage-cap", type=float, default=3.0, help="portfolio sim: max total notional as x of equity (default 3)")
    ap.add_argument("--fee-bps", type=float, default=8.0, help="per-side cost in bps (8=~0.06%% taker +0.02%% slip)")
    ap.add_argument("--no-costs", action="store_true")
    ap.add_argument("--no-shorts", action="store_true")
    ap.add_argument("--shorts-bear-only", action="store_true", help="restrict shorts to BEAR regime (for comparison)")
    ap.add_argument("--with-regime", action="store_true", help="trade WITH the daily 200 trend only: longs in BULL, shorts in BEAR")
    ap.add_argument("--max-risk", type=float, default=2.0, help="max stop distance as %% of entry (raise to 3-4 to widen stops)")
    ap.add_argument("--atr-buf", type=float, default=0.0, help="extra room beyond the level, in 4h ATR (e.g. 0.5) so noise doesn't stop you out")
    ap.add_argument("--stop-mode", default="wick2", choices=["wick2", "prevclose", "swing"], help="wick2 = tighter of wick or 2%% (default); prevclose = pre-confirmation candle close, no cap (WIDER); swing = SID-style lowest-low/highest-high wick since arming")
    # --- cross-armed v3 (Alan, 2026-06-07) ---
    ap.add_argument("--use-cross-gate", action="store_true", help="CROSS-ARMED: long only when 4h 20 SMA > 200 SMA, short only when 20 < 200 (kills falling-knife trades). Pair with --bull-os 35 --bear-os 35 --ob 65.")
    ap.add_argument("--sma200", type=int, default=200, help="slow SMA length for the 20x200 cross gate (default 200)")
    ap.add_argument("--min-sep", type=float, default=0.0, help="min 20-vs-200 gap %% required to trade (e.g. 3) — skips the cross/transition zone. 0=off")
    ap.add_argument("--mtf-slope-gate", action="store_true", help="require BOTH the 4h 200 and the daily 200 SMA to slope the trade's way (up=long/down=short). Kills shorts in a daily uptrend.")
    ap.add_argument("--slope-4h", type=int, default=10, help="4h 200-SMA slope lookback in 4h bars (default 10)")
    ap.add_argument("--slope-d", type=int, default=5, help="daily 200-SMA slope lookback in daily bars (default 5)")
    # --- macro-event blackout (Alan, 2026-06-08) ---
    ap.add_argument("--event-blackout", action="store_true", help="skip new entries in a window around FOMC/CPI/PPI (dates from event-dates.json)")
    ap.add_argument("--blackout-pre", type=float, default=48, help="blackout hours BEFORE each event (default 48)")
    ap.add_argument("--blackout-post", type=float, default=2, help="blackout hours AFTER each event before trading resumes (default 2)")
    ap.add_argument("--blackout-events", default="fomc,cpi,ppi", help="which events to blackout, comma-separated (default fomc,cpi,ppi)")
    ap.add_argument("--sweep", action="store_true", help="sweep bull oversold 30/32/35/40 across the basket")
    ap.add_argument("--append", action="store_true", help="append all trades to one CSV")
    ap.add_argument("--selftest", action="store_true", help="offline engine check, no network")
    a = ap.parse_args()

    if a.selftest:
        selftest(); sys.exit(0)

    P = default_params()
    P.update({"bull_os": a.bull_os, "bear_os": a.bear_os, "ob": a.ob, "arm": a.arm,
              "max_bars": a.max_bars, "risk_pct": a.risk, "fee_bps": a.fee_bps,
              "use_costs": not a.no_costs, "shorts": not a.no_shorts,
              "shorts_bear_only": a.shorts_bear_only, "with_regime": a.with_regime,
              "max_risk": a.max_risk/100.0, "atr_buf": a.atr_buf, "stop_mode": a.stop_mode,
              "sma200": a.sma200, "use_cross_gate": a.use_cross_gate, "min_sep_pct": a.min_sep,
              "mtf_slope_gate": a.mtf_slope_gate, "slope_4h": a.slope_4h, "slope_d": a.slope_d,
              "event_blackout": a.event_blackout, "blackout_pre_h": a.blackout_pre,
              "blackout_post_h": a.blackout_post,
              "blackout_events": [e.strip() for e in a.blackout_events.split(",") if e.strip()]})
    P["blackout_windows"] = load_blackout_windows(P)
    if P["blackout_windows"]:
        print(f"[blackout] {len(P['blackout_windows'])} windows active "
              f"({a.blackout_pre:.0f}h pre / {a.blackout_post:.0f}h post: {a.blackout_events})")
    if a.symbols:
        symbols = [s.strip().upper() for s in a.symbols.split(",") if s.strip()]
    elif a.basket:
        symbols = DEFAULT_BASKET
    else:
        symbols = [a.symbol or "BTCUSDT"]

    if a.sweep:
        print("=== SWEEP bull oversold trigger: 30 / 32 / 35 / 40 ===")
        for bos in (30, 32, 35, 40):
            P2 = dict(P); P2["bull_os"] = bos
            allt = []
            for sym in symbols:
                allt += run(sym, a.start, a.end, P2)
            s = summarize(allt)
            print(f">>> bull_os={bos}: {s['n']} trades | WR {s['wr']:.1f}% | PF {s['pf']:.2f} | net ${s['net']:,.0f}\n")
        sys.exit(0)

    all_trades = []
    rows = []
    for sym in symbols:
        t = run(sym, a.start, a.end, P)
        all_trades += t
        rows.append((sym, summarize(t)))
    print("\n=== PER-COIN ===")
    for sym, s in rows:
        print(f"  {sym:<12} {s['n']:>4} trades | WR {s['wr']:>5.1f}% | PF {s['pf']:>5.2f} | net ${s['net']:>9,.0f}")
    agg = summarize(all_trades)
    print(f"\n=== BASKET TOTAL: {agg['n']} trades | WR {agg['wr']:.1f}% | PF {agg['pf']:.2f} | net ${agg['net']:,.0f} ===")
    out = HERE / "maven-trades.csv"
    write_csv(all_trades, out)
    print(f"[OK] wrote {len(all_trades)} trades -> {out}")

    if a.portfolio:
        ps = portfolio_sim(all_trades, start_equity=a.start_equity, risk_pct=a.risk,
                           max_concurrent=a.max_concurrent, leverage_cap=a.leverage_cap)
        print(f"\n=== PORTFOLIO (one shared account) ===")
        print(f"  ${ps['start']:,.0f} start | {a.risk:.0f}% risk/trade | max {a.max_concurrent} concurrent | {a.leverage_cap:.0f}x leverage cap")
        print(f"  FINAL ${ps['final']:,.0f}  ({ps['ret_pct']:+.1f}%)  |  max drawdown {ps['maxdd_pct']:.1f}%")
        print(f"  took {ps['taken']}/{ps['signals']} signals  (WR {ps['wr']:.1f}%)  |  peak concurrent: {ps['max_concurrent']}")
        print(f"  skipped: {ps['skip_conc']} (account full) + {ps['skip_lev']} (no leverage room)  |  sized-down: {ps['sized_down']}")
