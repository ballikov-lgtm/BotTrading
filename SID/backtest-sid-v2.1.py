"""
backtest-sid-v2.1.py — SID V2.1 Method backtest (Dynamic TP1 + TP2)

Identical entry rules to v2-weekly-or (the deployed v2.0 baseline). The ONLY
difference vs backtest-sid-v2.py is the exit model:

  V2 (current bot, "Option A"):
    Single exit at RSI 50 — full position closed.

  V2.1 (this file, "Option B"):
    TP1: Close 50% of position at RSI 50. Move stop to break-even on remaining 50%.
    TP2: Close remaining 50% on whichever of these fires first —
           - Price touches 50-day SMA
           - Price touches 200-day SMA
           - Break-even stop hit
           - 60-trading-day timeout (close at market)

Per the SID Method V2 transcripts (S3_P1 long / S3_P2 short):
  - "Take profits at TP1 where RSI goes up to a value of 50"
  - "Take profits at TP2 when the price hits the 50 day moving average or the
     200 day moving average"

Goals of this backtest:
  1. Verify WR stays ~70% (TP1 partial hit still counts as a win — WR shouldn't move)
  2. Measure avg-winner uplift (partials run to MA → larger $ per winning trade)
  3. Confirm max drawdown does not worsen materially

Usage:
  cd SID
  python backtest-sid-v2.1.py

  SID_UNIVERSE=tier1 SID_BACKTEST_YEARS=5 python backtest-sid-v2.1.py
"""
from __future__ import annotations
import yfinance as yf
import pandas as pd
import numpy as np
import json, math, sys, io, os
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Strategy params — match v2 verbatim
RSI_PERIOD          = 14
RSI_OVERSOLD        = 30
RSI_OVERBOUGHT_V2   = 70
RSI_NOGO_LONG_HI    = 45
RSI_NOGO_SHORT_LO   = 55
RSI_EXIT_TP1        = 50    # TP1: full RSI 50 trigger
RSI3_PERIOD         = 3
MACD_FAST           = 12
MACD_SLOW           = 26
MACD_SIGNAL         = 9
TIMEOUT_DAYS_ARM    = 3
TP2_TIMEOUT_DAYS    = int(os.environ.get('SID_TP2_TIMEOUT', '30'))    # NEW: max bars to hold remaining 50% after TP1
RISK_PER_TRADE      = float(os.environ.get('SID_RISK_PER_TRADE', '200'))
EARNINGS_BLACKOUT   = 14
BACKTEST_YEARS      = int(os.environ.get('SID_BACKTEST_YEARS', '5'))
HISTORY_WARMUP_DAYS = 365 * 5 + 30
UNIVERSE            = os.environ.get('SID_UNIVERSE', 'tier1').lower()

# TP1 partial split — 50% of position closes at TP1, 50% holds for TP2
TP1_PORTION         = 0.50

# Hybrid mode: route per-ticker based on long-term bullish classification.
# When SID_HYBRID=true:
#   • LONG entries on tickers that are long-term bullish AT ENTRY → V2.1 (TP1+TP2 runner)
#   • Everything else (LONG on non-bullish, ALL shorts) → V2 (full close at RSI 50)
# Definition of "long-term bullish":
#   weekly EMA50 > weekly EMA200  AND  weekly MACD > 0  AND  price > weekly 200-day SMA
HYBRID_MODE         = os.environ.get('SID_HYBRID', 'false').lower() in ('true', '1', 'yes')
FORCE_V2            = os.environ.get('SID_FORCE_V2', 'false').lower() in ('true', '1', 'yes')  # debug: route ALL trades to V2 single-exit

WATCHLIST_PATH = Path(__file__).parent / 'watchlist-sid.json'
EVENT_DATES    = Path(__file__).parent / 'event-dates.json'
# Suffix reports with non-default timeouts / risk / mode so we can compare runs side-by-side
_suffix_parts  = []
# Default universe is tier1 (80-ticker AUTO). Anything else gets suffixed.
if UNIVERSE not in ('tier1', 'tier1_80', '80', 'auto'):
    _suffix_parts.append(UNIVERSE)
if HYBRID_MODE:              _suffix_parts.append('hybrid')
if FORCE_V2:                 _suffix_parts.append('forcev2')
if TP2_TIMEOUT_DAYS != 30:   _suffix_parts.append(f'tp2t{TP2_TIMEOUT_DAYS}')
if RISK_PER_TRADE  != 200:   _suffix_parts.append(f'risk{int(RISK_PER_TRADE)}')
_suffix        = ('-' + '-'.join(_suffix_parts)) if _suffix_parts else ''
REPORT_MD      = Path(__file__).parent / f'backtest-v2.1-validation-report{_suffix}.md'
REPORT_JSON    = Path(__file__).parent / f'backtest-v2.1-validation-report{_suffix}.json'
EARNINGS_CACHE = Path(__file__).parent / '.earnings-cache.json'

# Reuse v2-weekly-or rule set (the deployed baseline). v2.1 only changes EXIT logic.
VARIANTS = [
    {
        'name': 'v2.1-dynamic-tp',
        'desc': 'V2.1 = v2-weekly-or entry + TP1/TP2 partial exits (50/50)',
        'rsi_overbought':       RSI_OVERBOUGHT_V2,
        'use_weekly_direction': True,
        'weekly_mode':          'or',
        'use_nogo_zone':        True,
        'slope_bars':           1,
    },
]

# ─── Indicators (same as v2) ───────────────────────────────────────────────

def wilder_rsi(closes, period=14):
    delta = closes.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def compute_macd_and_signal(closes, fast=12, slow=26, signal=9):
    ema_fast = closes.ewm(span=fast, adjust=False).mean()
    ema_slow = closes.ewm(span=slow, adjust=False).mean()
    macd = ema_fast - ema_slow
    sig  = macd.ewm(span=signal, adjust=False).mean()
    return macd, sig


# ─── Event date helpers (same as v2) ───────────────────────────────────────

def load_earnings_cache():
    if EARNINGS_CACHE.exists():
        try:
            return json.loads(EARNINGS_CACHE.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {}


def save_earnings_cache(cache):
    EARNINGS_CACHE.write_text(json.dumps(cache, indent=2, default=str), encoding='utf-8')


def fetch_earnings_dates(ticker, cache):
    if ticker in cache:
        return cache[ticker]
    try:
        df = yf.Ticker(ticker).earnings_dates
        if df is None or df.empty:
            dates = []
        else:
            dates = sorted({d.date().isoformat() for d in df.index})
    except Exception as e:
        print(f'    earnings fetch failed for {ticker}: {e}')
        dates = []
    cache[ticker] = dates
    return dates


def in_pre_earnings_window(check_date, earnings_dates, days):
    check = check_date.date()
    for ed_str in earnings_dates:
        try:
            ed = datetime.fromisoformat(ed_str).date()
        except Exception:
            continue
        delta = (ed - check).days
        if 0 <= delta <= days:
            return True
    return False


def compute_weekly_direction(df):
    weekly = df['Close'].resample('W-FRI').last().dropna()
    if len(weekly) < 30:
        return (pd.Series(False, index=df.index),
                pd.Series(False, index=df.index))
    w_rsi   = wilder_rsi(weekly, RSI_PERIOD)
    w_macd, _ = compute_macd_and_signal(weekly, MACD_FAST, MACD_SLOW, MACD_SIGNAL)
    rsi_rising  = (w_rsi  > w_rsi.shift(1))
    macd_rising = (w_macd > w_macd.shift(1))
    rsi_rising.index  = rsi_rising.index  - pd.Timedelta(days=4)
    macd_rising.index = macd_rising.index - pd.Timedelta(days=4)
    rsi_rising_daily  = rsi_rising.reindex(df.index, method='ffill').fillna(False)
    macd_rising_daily = macd_rising.reindex(df.index, method='ffill').fillna(False)
    return rsi_rising_daily, macd_rising_daily


# ─── Strategy simulation with TP1/TP2 partial exits ────────────────────────

def backtest_ticker_v2_1(ticker, df, variant, earnings_dates,
                          allow_longs=True, allow_shorts=True):
    """Backtest a single ticker with the V2.1 dynamic-TP exit model.

    Returns a list of trade records. For each underlying trade, ONE record is
    emitted with separate tp1_/tp2_ columns rather than two rows — easier to
    aggregate WR (a TP1 hit counts as a win for the whole trade).
    """
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], RSI3_PERIOD)
    macd, signal_line = compute_macd_and_signal(df['Close'])
    df['MACD']        = macd
    df['MACD_SIGNAL'] = signal_line
    # NEW: 50d and 200d SMAs for TP2 detection
    df['SMA50']  = df['Close'].rolling(50).mean()
    df['SMA200'] = df['Close'].rolling(200).mean()

    weekly_close = df['Close'].resample('W-FRI').last().dropna()
    if len(weekly_close) >= 200:
        wfast = weekly_close.rolling(50).mean()
        wslow = weekly_close.rolling(200).mean()
        sma_long_ok  = (wfast > wslow).reindex(df.index, method='ffill').fillna(False)
        sma_short_ok = (wfast < wslow).reindex(df.index, method='ffill').fillna(False)
    else:
        sma_long_ok  = pd.Series(True, index=df.index)
        sma_short_ok = pd.Series(True, index=df.index)
    df['sma_long_ok']  = sma_long_ok
    df['sma_short_ok'] = sma_short_ok

    wk_rsi_rising, wk_macd_rising = compute_weekly_direction(df)
    df['wk_rsi_rising']  = wk_rsi_rising
    df['wk_macd_rising'] = wk_macd_rising

    # ── Hybrid-mode bullish classification (per-bar, daily resolution) ─────
    # A ticker is "long-term bullish AT THIS BAR" when ALL of:
    #   - weekly EMA50 > weekly EMA200
    #   - weekly MACD > 0
    #   - price (daily close) > weekly 200-day SMA
    # The series is reindexed to daily so we can read it at any entry candle.
    if HYBRID_MODE and len(weekly_close) >= 200:
        w_ema50  = weekly_close.ewm(span=50,  adjust=False).mean()
        w_ema200 = weekly_close.ewm(span=200, adjust=False).mean()
        w_macd, _ = compute_macd_and_signal(weekly_close, MACD_FAST, MACD_SLOW, MACD_SIGNAL)
        w_sma200 = weekly_close.rolling(200).mean()
        # Shift weekly series so the Friday value applies to the FOLLOWING Mon-Fri
        ema_bullish  = (w_ema50  > w_ema200).reindex(df.index, method='ffill').fillna(False)
        macd_bullish = (w_macd   > 0).reindex(df.index, method='ffill').fillna(False)
        sma_ref      = w_sma200.reindex(df.index, method='ffill')
        price_bullish = (df['Close'] > sma_ref).fillna(False)
        df['is_lt_bullish'] = ema_bullish & macd_bullish & price_bullish
    else:
        # Hybrid disabled, OR insufficient weekly history → treat as not-bullish
        # (which means V2 single-exit path under HYBRID_MODE; or simply not used
        # under non-hybrid runs because use_dynamic_tp will be forced True).
        df['is_lt_bullish'] = pd.Series(False, index=df.index)

    trades = []
    arm_dir = None; arm_low = None; arm_high = None; days_since_arm = 0
    in_pos = None
    prev_rsi  = None
    prev_macd = None
    prev_signal = None

    rsi_overbought = variant['rsi_overbought']

    for i, (date, row) in enumerate(df.iterrows()):
        rsi    = row['RSI']
        m      = row['MACD']
        s      = row['MACD_SIGNAL']
        rsi3   = row['RSI3']

        if (pd.isna(rsi) or pd.isna(m) or pd.isna(s)
            or prev_rsi is None or prev_macd is None or prev_signal is None):
            prev_rsi, prev_macd, prev_signal = rsi, m, s
            continue

        rsi_rising   = rsi > prev_rsi
        rsi_falling  = rsi < prev_rsi
        macd_rising  = m   > prev_macd
        macd_falling = m   < prev_macd

        # ── EXIT LOGIC (V2.1: TP1 then TP2) ─────────────────────────────────
        if in_pos is not None:
            side  = in_pos['side']
            entry = in_pos['entry_price']
            shares_total = in_pos['shares_total']

            # Branch A: TP1 not yet hit. Original stop active on full position.
            if not in_pos['tp1_hit']:
                if side == 'LONG':
                    if row['Low'] <= in_pos['stop']:
                        # Stop hit — full loss
                        ex = in_pos['stop']
                        pnl = (ex - entry) * shares_total
                        in_pos['tp1_exit_px'] = ex
                        in_pos['tp1_exit_date'] = date.strftime('%Y-%m-%d')
                        in_pos['tp1_reason'] = 'stop'
                        in_pos['tp1_shares'] = shares_total
                        in_pos['tp1_pnl'] = round(pnl, 2)
                        in_pos['tp2_shares'] = 0
                        in_pos['tp2_pnl'] = 0.0
                        in_pos['tp2_reason'] = 'stopped_before_tp1'
                        in_pos['total_pnl'] = round(pnl, 2)
                        in_pos['bars_held'] = i - in_pos['entry_idx']
                        trades.append(in_pos)
                        in_pos = None
                    elif rsi >= RSI_EXIT_TP1:
                        ex = row['Close']
                        if not in_pos.get('use_dynamic_tp', True):
                            # HYBRID: non-bullish → V2-style FULL close at RSI 50
                            pnl_full = (ex - entry) * shares_total
                            in_pos['tp1_exit_px'] = ex
                            in_pos['tp1_exit_date'] = date.strftime('%Y-%m-%d')
                            in_pos['tp1_reason'] = 'rsi50'
                            in_pos['tp1_shares'] = shares_total
                            in_pos['tp1_pnl'] = round(pnl_full, 2)
                            in_pos['tp2_shares'] = 0
                            in_pos['tp2_pnl'] = 0.0
                            in_pos['tp2_reason'] = 'v2_full_exit_at_rsi50'
                            in_pos['total_pnl'] = round(pnl_full, 2)
                            in_pos['bars_held'] = i - in_pos['entry_idx']
                            trades.append(in_pos)
                            in_pos = None
                        else:
                            # V2.1: close 50%, mark, move stop to break-even, runner continues
                            tp1_shares = max(1, int(shares_total * TP1_PORTION))
                            pnl1 = (ex - entry) * tp1_shares
                            in_pos['tp1_hit'] = True
                            in_pos['tp1_idx'] = i
                            in_pos['tp1_exit_px'] = ex
                            in_pos['tp1_exit_date'] = date.strftime('%Y-%m-%d')
                            in_pos['tp1_reason'] = 'rsi50'
                            in_pos['tp1_shares'] = tp1_shares
                            in_pos['tp1_pnl'] = round(pnl1, 2)
                            in_pos['shares_remaining'] = shares_total - tp1_shares
                            in_pos['stop'] = entry  # move to break-even
                else:  # SHORT
                    if row['High'] >= in_pos['stop']:
                        ex = in_pos['stop']
                        pnl = (entry - ex) * shares_total
                        in_pos['tp1_exit_px'] = ex
                        in_pos['tp1_exit_date'] = date.strftime('%Y-%m-%d')
                        in_pos['tp1_reason'] = 'stop'
                        in_pos['tp1_shares'] = shares_total
                        in_pos['tp1_pnl'] = round(pnl, 2)
                        in_pos['tp2_shares'] = 0
                        in_pos['tp2_pnl'] = 0.0
                        in_pos['tp2_reason'] = 'stopped_before_tp1'
                        in_pos['total_pnl'] = round(pnl, 2)
                        in_pos['bars_held'] = i - in_pos['entry_idx']
                        trades.append(in_pos)
                        in_pos = None
                    elif rsi <= RSI_EXIT_TP1:
                        ex = row['Close']
                        if not in_pos.get('use_dynamic_tp', True):
                            # HYBRID: shorts always V2-style FULL close at RSI 50
                            pnl_full = (entry - ex) * shares_total
                            in_pos['tp1_exit_px'] = ex
                            in_pos['tp1_exit_date'] = date.strftime('%Y-%m-%d')
                            in_pos['tp1_reason'] = 'rsi50'
                            in_pos['tp1_shares'] = shares_total
                            in_pos['tp1_pnl'] = round(pnl_full, 2)
                            in_pos['tp2_shares'] = 0
                            in_pos['tp2_pnl'] = 0.0
                            in_pos['tp2_reason'] = 'v2_full_exit_at_rsi50'
                            in_pos['total_pnl'] = round(pnl_full, 2)
                            in_pos['bars_held'] = i - in_pos['entry_idx']
                            trades.append(in_pos)
                            in_pos = None
                        else:
                            tp1_shares = max(1, int(shares_total * TP1_PORTION))
                            pnl1 = (entry - ex) * tp1_shares
                            in_pos['tp1_hit'] = True
                            in_pos['tp1_idx'] = i
                            in_pos['tp1_exit_px'] = ex
                            in_pos['tp1_exit_date'] = date.strftime('%Y-%m-%d')
                            in_pos['tp1_reason'] = 'rsi50'
                            in_pos['tp1_shares'] = tp1_shares
                            in_pos['tp1_pnl'] = round(pnl1, 2)
                            in_pos['shares_remaining'] = shares_total - tp1_shares
                            in_pos['stop'] = entry  # break-even

            # Branch B: TP1 already hit, running on remainder with break-even stop.
            elif in_pos['tp1_hit']:
                tp2_shares = in_pos['shares_remaining']
                ma50  = row['SMA50']  if not pd.isna(row['SMA50'])  else None
                ma200 = row['SMA200'] if not pd.isna(row['SMA200']) else None
                bars_since_tp1 = i - in_pos['tp1_idx']

                tp2_close = False
                tp2_reason = None
                tp2_exit_px = None

                if side == 'LONG':
                    # Break-even stop on remaining 50%
                    if row['Low'] <= in_pos['stop']:
                        tp2_close = True; tp2_reason = 'breakeven_stop'; tp2_exit_px = in_pos['stop']
                    # 50d MA touched from above (price coming back down to it)
                    elif ma50 is not None and row['Low'] <= ma50 <= row['High']:
                        tp2_close = True; tp2_reason = 'sma50_touch';  tp2_exit_px = ma50
                    # 200d MA touched
                    elif ma200 is not None and row['Low'] <= ma200 <= row['High']:
                        tp2_close = True; tp2_reason = 'sma200_touch'; tp2_exit_px = ma200
                    # Time stop
                    elif bars_since_tp1 >= TP2_TIMEOUT_DAYS:
                        tp2_close = True; tp2_reason = 'timeout';      tp2_exit_px = row['Close']
                else:  # SHORT
                    if row['High'] >= in_pos['stop']:
                        tp2_close = True; tp2_reason = 'breakeven_stop'; tp2_exit_px = in_pos['stop']
                    elif ma50 is not None and row['Low'] <= ma50 <= row['High']:
                        tp2_close = True; tp2_reason = 'sma50_touch';  tp2_exit_px = ma50
                    elif ma200 is not None and row['Low'] <= ma200 <= row['High']:
                        tp2_close = True; tp2_reason = 'sma200_touch'; tp2_exit_px = ma200
                    elif bars_since_tp1 >= TP2_TIMEOUT_DAYS:
                        tp2_close = True; tp2_reason = 'timeout';      tp2_exit_px = row['Close']

                if tp2_close:
                    if side == 'LONG':
                        pnl2 = (tp2_exit_px - entry) * tp2_shares
                    else:
                        pnl2 = (entry - tp2_exit_px) * tp2_shares
                    in_pos['tp2_exit_px'] = tp2_exit_px
                    in_pos['tp2_exit_date'] = date.strftime('%Y-%m-%d')
                    in_pos['tp2_reason'] = tp2_reason
                    in_pos['tp2_shares'] = tp2_shares
                    in_pos['tp2_pnl'] = round(pnl2, 2)
                    in_pos['total_pnl'] = round(in_pos['tp1_pnl'] + pnl2, 2)
                    in_pos['bars_held'] = i - in_pos['entry_idx']
                    trades.append(in_pos)
                    in_pos = None

            if in_pos is not None:
                # Still open — fall through to next iteration
                prev_rsi, prev_macd, prev_signal = rsi, m, s
                continue

        # ── ARM (same as v2) ────────────────────────────────────────────────
        rsi3_ok_long  = not pd.isna(rsi3) and rsi3 < RSI_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > rsi_overbought
        wk_long  = bool(row['sma_long_ok'])
        wk_short = bool(row['sma_short_ok'])
        earn_block = in_pre_earnings_window(date, earnings_dates, EARNINGS_BLACKOUT)

        if arm_dir is None and in_pos is None and not earn_block:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and wk_long:
                arm_dir = 'LONG'
                arm_low = row['Low']; arm_high = row['High']
                days_since_arm = 0
            elif allow_shorts and rsi > rsi_overbought and rsi3_ok_short and wk_short:
                arm_dir = 'SHORT'
                arm_low = row['Low']; arm_high = row['High']
                days_since_arm = 0
        elif arm_dir is not None:
            days_since_arm += 1
            arm_low  = min(arm_low,  row['Low'])
            arm_high = max(arm_high, row['High'])
            if days_since_arm > TIMEOUT_DAYS_ARM or earn_block:
                arm_dir = None

        # ── TRIGGER (same as v2-weekly-or) ──────────────────────────────────
        wk_rsi_ok  = bool(row['wk_rsi_rising'])
        wk_macd_ok = bool(row['wk_macd_rising'])

        if arm_dir == 'LONG' and in_pos is None:
            nogo_ok = (not variant['use_nogo_zone']) or rsi < RSI_NOGO_LONG_HI
            weekly_ok = (wk_rsi_ok or wk_macd_ok) if variant['use_weekly_direction'] else True

            if rsi_rising and macd_rising and nogo_ok and weekly_ok:
                stop = math.floor(arm_low)
                ep = row['Close']
                if ep > stop:
                    rps = ep - stop
                    shares = max(2, int(RISK_PER_TRADE / rps))  # min 2 shares so we can split 50/50
                    is_lt_bullish = bool(row.get('is_lt_bullish', False))
                    # Hybrid routing: LONG on bullish ticker → V2.1 dynamic TP
                    #                 LONG on non-bullish → V2 single exit
                    #                 Non-hybrid runs → always V2.1 (preserves legacy behaviour)
                    use_dynamic = False if FORCE_V2 else ((not HYBRID_MODE) or is_lt_bullish)
                    in_pos = {
                        'ticker': ticker,
                        'side': 'LONG',
                        'entry_date':  date.strftime('%Y-%m-%d'),
                        'entry_idx':   i,
                        'entry_price': round(ep, 2),
                        'entry_rsi':   round(rsi, 2),
                        'stop':        stop,
                        'orig_stop':   stop,
                        'shares_total': shares,
                        'shares_remaining': shares,
                        'tp1_hit':     False,
                        'wk_rsi_rising_at_entry':  bool(wk_rsi_ok),
                        'wk_macd_rising_at_entry': bool(wk_macd_ok),
                        'is_lt_bullish_at_entry':  is_lt_bullish,
                        'use_dynamic_tp':          use_dynamic,
                        'exit_mode':               'v2.1' if use_dynamic else 'v2',
                    }
                    arm_dir = None
        elif arm_dir == 'SHORT' and in_pos is None:
            nogo_ok = (not variant['use_nogo_zone']) or rsi > RSI_NOGO_SHORT_LO
            weekly_ok = ((not wk_rsi_ok) or (not wk_macd_ok)) if variant['use_weekly_direction'] else True

            if rsi_falling and macd_falling and nogo_ok and weekly_ok:
                stop = math.ceil(arm_high)
                ep = row['Close']
                if stop > ep:
                    rps = stop - ep
                    shares = max(2, int(RISK_PER_TRADE / rps))
                    is_lt_bullish = bool(row.get('is_lt_bullish', False))
                    # Hybrid routing: shorts ALWAYS use V2 single-exit
                    # (a bullish-classified ticker shorted is by definition counter-
                    # trend and shouldn't carry a runner). Non-hybrid runs → V2.1.
                    use_dynamic = False if FORCE_V2 else (not HYBRID_MODE)
                    in_pos = {
                        'ticker': ticker,
                        'side': 'SHORT',
                        'entry_date':  date.strftime('%Y-%m-%d'),
                        'entry_idx':   i,
                        'entry_price': round(ep, 2),
                        'entry_rsi':   round(rsi, 2),
                        'stop':        stop,
                        'orig_stop':   stop,
                        'shares_total': shares,
                        'shares_remaining': shares,
                        'tp1_hit':     False,
                        'wk_rsi_rising_at_entry':  bool(wk_rsi_ok),
                        'wk_macd_rising_at_entry': bool(wk_macd_ok),
                        'is_lt_bullish_at_entry':  is_lt_bullish,
                        'use_dynamic_tp':          use_dynamic,
                        'exit_mode':               'v2.1' if use_dynamic else 'v2',
                    }
                    arm_dir = None

        prev_rsi, prev_macd, prev_signal = rsi, m, s

    return trades


# ─── Universe loader (same as v2) ──────────────────────────────────────────

def load_universe():
    wl = json.loads(WATCHLIST_PATH.read_text(encoding='utf-8'))
    sections = wl.get('sections', {})
    if UNIVERSE in ('tier1', 'tier1_80', '80', 'auto'):
        tickers = sections.get('v2_auto_approved_80', [])
    elif UNIVERSE in ('tier1_113', 'expanded', '113'):
        tickers = list(sections.get('v2_auto_approved_80', [])) + \
                  list(sections.get('v2_human_approval_33', []))
    elif UNIVERSE in ('tier2', 'human'):
        tickers = sections.get('v2_human_approval_33', [])
    elif UNIVERSE in ('favourites', 'main'):
        tickers = wl.get('tickers', [])
    else:
        tickers = wl.get('tickers', [])
    return sorted(set(tickers))


# ─── Main run loop ─────────────────────────────────────────────────────────

def main():
    universe = load_universe()
    print(f'V2.1 Dynamic-TP backtest — universe={UNIVERSE} ({len(universe)} tickers), years={BACKTEST_YEARS}')
    end_date = datetime.now().date()
    # BUGFIX (2026-05-18): V2.1 was downloading only BACKTEST_YEARS+60d of data,
    # which left the daily/weekly indicators under-warmed at the start of the
    # trade window. Result was ~4x fewer trades than backtest-sid-v2.py on the
    # IDENTICAL entry rules — many ARM/TRIGGER signals in years 1-3 of the trade
    # window were missed because Wilder RSI / weekly resamples hadn't settled.
    # Fix: download HISTORY_WARMUP_DAYS additional history (matching V2's main),
    # then filter resulting trades to entry_date >= trade_window_start.
    trade_window_start = end_date - timedelta(days=int(BACKTEST_YEARS * 365.25))
    download_start     = end_date - timedelta(days=HISTORY_WARMUP_DAYS + int(BACKTEST_YEARS * 365.25))
    trade_window_start_str = trade_window_start.strftime('%Y-%m-%d')
    print(f'Trade window : {trade_window_start} -> {end_date}')
    print(f'Data download: {download_start} -> {end_date}  (warmup = {HISTORY_WARMUP_DAYS}d)')
    earn_cache = load_earnings_cache()

    all_trades = []

    for idx, ticker in enumerate(universe, 1):
        try:
            df = yf.download(ticker, start=download_start, end=end_date + timedelta(days=1),
                             auto_adjust=False, progress=False)
            if df.empty or len(df) < 100:
                continue
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            earn_dates = fetch_earnings_dates(ticker, earn_cache)
            variant = VARIANTS[0]
            raw_trades = backtest_ticker_v2_1(ticker, df, variant, earn_dates)
            # Filter to actual trade window (everything before is indicator warmup)
            trades = [t for t in raw_trades if t['entry_date'] >= trade_window_start_str]
            all_trades.extend(trades)
            wr = (sum(1 for t in trades if t['tp1_reason'] == 'rsi50') / len(trades)) if trades else 0.0
            print(f'[{idx}/{len(universe)}] {ticker:8s} {len(trades)} trades  WR {wr*100:5.1f}%')
        except Exception as e:
            print(f'  {ticker}: ERROR — {e}')

    save_earnings_cache(earn_cache)

    if not all_trades:
        print('\nNo trades — check universe or window.')
        return

    df_t = pd.DataFrame(all_trades)
    df_t['win']  = df_t['tp1_reason'] == 'rsi50'  # TP1 hit = winning trade
    df_t['side_str'] = df_t['side']

    n = len(df_t)
    wins = int(df_t['win'].sum())
    wr   = wins / n
    total_pnl = df_t['total_pnl'].sum()
    avg_winner_pnl = df_t[df_t['win']]['total_pnl'].mean() if wins else 0.0
    avg_loser_pnl  = df_t[~df_t['win']]['total_pnl'].mean() if (n - wins) > 0 else 0.0
    pf = (df_t[df_t['win']]['total_pnl'].sum() /
          abs(df_t[~df_t['win']]['total_pnl'].sum())) if (n - wins) > 0 and (df_t[~df_t['win']]['total_pnl'].sum() != 0) else float('inf')

    # TP2 outcome breakdown (winners only)
    winners = df_t[df_t['win']]
    tp2_breakdown = winners['tp2_reason'].value_counts().to_dict() if len(winners) else {}

    # TP1 PnL alone (what v2 would have captured)
    tp1_only_pnl_winners = winners['tp1_pnl'].sum()
    full_winners_pnl     = winners['total_pnl'].sum()
    tp2_uplift           = full_winners_pnl - tp1_only_pnl_winners

    longs  = df_t[df_t['side'] == 'LONG']
    shorts = df_t[df_t['side'] == 'SHORT']

    print(f'\n━━ V2.1 AGGREGATE ━━\n')
    print(f'  Total trades:    {n}')
    print(f'  Wins (TP1 hit):  {wins}')
    print(f'  Win Rate:        {wr*100:.1f}%')
    print(f'  Profit Factor:   {pf:.2f}')
    print(f'  Avg winner $:    {avg_winner_pnl:+.2f}')
    print(f'  Avg loser  $:    {avg_loser_pnl:+.2f}')
    print(f'  Total P&L $:     {total_pnl:+.2f}')
    print(f'  Long:  n={len(longs)}  WR={(longs["win"].mean()*100 if len(longs) else 0):.1f}%  PnL=${longs["total_pnl"].sum():+.2f}')
    print(f'  Short: n={len(shorts)} WR={(shorts["win"].mean()*100 if len(shorts) else 0):.1f}%  PnL=${shorts["total_pnl"].sum():+.2f}')

    print(f'\n━━ TP2 BREAKDOWN (on TP1 winners only) ━━')
    for reason, count in sorted(tp2_breakdown.items(), key=lambda x: -x[1]):
        avg_tp2_pnl = winners[winners['tp2_reason'] == reason]['tp2_pnl'].mean()
        print(f'  {reason:25s}: {count:4d}  avg TP2 pnl ${avg_tp2_pnl:+.2f}')

    print(f'\n━━ TP1 vs TP1+TP2 (winners only) ━━')
    print(f'  Sum of TP1 partials (winning trades):   ${tp1_only_pnl_winners:+,.2f}')
    print(f'  Sum of TP1+TP2 totals (winning trades): ${full_winners_pnl:+,.2f}')
    print(f'  TP2 uplift (extra $ from holding 50%):  ${tp2_uplift:+,.2f}  ({tp2_uplift/tp1_only_pnl_winners*100:+.1f}% more)')

    # ── Hybrid-mode breakdown by exit_mode (v2 vs v2.1) ──────────────────────
    if HYBRID_MODE and 'exit_mode' in df_t.columns:
        print(f'\n━━ HYBRID ROUTING BREAKDOWN ━━')
        for mode in ['v2.1', 'v2']:
            sub = df_t[df_t['exit_mode'] == mode]
            if len(sub) == 0:
                continue
            sub_wr  = sub['win'].mean() * 100
            sub_pnl = sub['total_pnl'].sum()
            sub_long  = sub[sub['side'] == 'LONG']
            sub_short = sub[sub['side'] == 'SHORT']
            print(f'  {mode.upper():5s} | n={len(sub):3d}  WR={sub_wr:5.1f}%  PnL=${sub_pnl:+9.2f}  '
                  f'(L={len(sub_long)}/S={len(sub_short)})')
        bull_longs    = df_t[(df_t['side'] == 'LONG') & (df_t.get('is_lt_bullish_at_entry', False) == True)]
        nonbull_longs = df_t[(df_t['side'] == 'LONG') & (df_t.get('is_lt_bullish_at_entry', False) == False)]
        print(f'  Bullish longs  : n={len(bull_longs):3d}  WR={(bull_longs["win"].mean()*100 if len(bull_longs) else 0):5.1f}%  PnL=${bull_longs["total_pnl"].sum():+9.2f}')
        print(f'  Non-bull longs : n={len(nonbull_longs):3d}  WR={(nonbull_longs["win"].mean()*100 if len(nonbull_longs) else 0):5.1f}%  PnL=${nonbull_longs["total_pnl"].sum():+9.2f}')

    # Write report
    report = {
        'generated': datetime.now().isoformat(),
        'universe':  UNIVERSE,
        'years':     BACKTEST_YEARS,
        'n_trades':  n,
        'wins':      wins,
        'win_rate':  round(wr, 4),
        'profit_factor': round(pf, 2) if pf != float('inf') else None,
        'avg_winner_pnl': round(avg_winner_pnl, 2),
        'avg_loser_pnl':  round(avg_loser_pnl, 2),
        'total_pnl':      round(total_pnl, 2),
        'long_count':  len(longs),
        'long_wr':     round(longs['win'].mean(), 4) if len(longs) else 0.0,
        'short_count': len(shorts),
        'short_wr':    round(shorts['win'].mean(), 4) if len(shorts) else 0.0,
        'tp2_breakdown': tp2_breakdown,
        'tp1_only_pnl_winners': round(float(tp1_only_pnl_winners), 2),
        'tp1_plus_tp2_pnl_winners': round(float(full_winners_pnl), 2),
        'tp2_uplift': round(float(tp2_uplift), 2),
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2, default=str), encoding='utf-8')
    df_t.to_csv(REPORT_MD.with_suffix('.csv'), index=False)
    print(f'\nWrote {REPORT_JSON.name} and trade CSV.')


if __name__ == '__main__':
    main()
