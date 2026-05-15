"""
backtest-sid-v1.6.py — Instructor-aligned strategy validation

v1.6 implements the strict instructor rules per 2026-05-15 clarification:

  1. RSI thresholds reverted to 30 / 70 (was 30 / 75 in v1.3+)
  2. Strict arm window:
     - Armed while RSI in extreme zone, OR
     - Within 1 day of leaving extreme AND RSI still in 5-pt buffer
       (30-35 for long, 65-70 for short)
  3. Trigger = ALL THREE align: daily RSI direction + daily MACD direction +
     WEEKLY RSI direction (replaces v1.4/v1.5 weekly 50/200 SMA filter)
  4. Three event blackouts (14 days BEFORE event, day-after permitted):
     - Per-ticker earnings (yfinance)
     - US CPI release dates (hardcoded — event-dates.json)
     - US FOMC rate decisions (hardcoded — event-dates.json)
  5. Backtest universe: FAVOURITES section from watchlist-sid.json
     (community-curated 61-ticker subset with 2500+ historical trades and
     65-85% WR target band)

Compared to v1.5 baseline (locked at git tag sid-v1.4-baseline +
earnings pre-only fix), v1.6 changes:
  - RSI threshold tightened (75 -> 70) — more shorts qualify
  - Arm window tightened (3 days -> 1 day grace + buffer) — fewer stale setups
  - Weekly filter swap (SMA -> RSI direction) — more responsive to turns
  - Macro blackouts added — fewer trades during high-volatility windows

Usage:
  cd SID
  python backtest-sid-v1.6.py                          # FAVOURITES, 5y
  SID_BACKTEST_YEARS=3 python backtest-sid-v1.6.py     # shorter window
  SID_UNIVERSE=all python backtest-sid-v1.6.py         # monitor tier
"""

import yfinance as yf
import pandas as pd
import numpy as np
import json
import math
import sys
import io
import os
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ─── Strategy params ──────────────────────────────────────────────────────
RSI_PERIOD         = 14
RSI_OVERSOLD       = 30
RSI_OVERBOUGHT     = 70             # v1.6: REVERTED from 75 per instructor
RSI_LONG_BUFFER    = 35             # 30-35 = grace zone for longs
RSI_SHORT_BUFFER   = 65             # 65-70 = grace zone for shorts
RSI_EXIT           = 50
RSI3_PERIOD        = 3              # for rebound-zone confirmation
WEEKLY_RSI_PERIOD  = 14             # for weekly RSI direction filter
MACD_FAST          = 12
MACD_SLOW          = 26
MACD_SIGNAL        = 9
GRACE_DAYS         = 1              # v1.6: 1-day grace after RSI leaves extreme
EARNINGS_BLACKOUT  = 14
MACRO_BLACKOUT     = 14
RISK_PER_TRADE     = 200.0
BACKTEST_YEARS     = int(os.environ.get('SID_BACKTEST_YEARS', '5'))
HISTORY_WARMUP_DAYS = 365 * 5 + 30
UNIVERSE           = os.environ.get('SID_UNIVERSE', 'favourites').lower()  # favourites | all | both

# Per-ticker direction restrictions (carried over from v1.4 classification)
LONG_ONLY  = {'XLC', 'QQQ', 'AMD', 'INTC', 'SPY', 'CAT', 'MSFT', 'TQQQ', 'XLK',
              'GOLD', 'GS', 'IBM', 'JPM', 'XLB', 'XLE'}
SHORT_ONLY = set()

# Files
WATCHLIST_PATH  = Path(__file__).parent / 'watchlist-sid.json'
EVENT_DATES     = Path(__file__).parent / 'event-dates.json'
REPORT_MD       = Path(__file__).parent / 'backtest-v1.6-validation-report.md'
REPORT_JSON     = Path(__file__).parent / 'backtest-v1.6-validation-report.json'
EARNINGS_CACHE  = Path(__file__).parent / '.earnings-cache.json'

# ─── Variants ─────────────────────────────────────────────────────────────
# v1.5-baseline = the just-shipped variant (weekly SMA + earnings blackout)
# v1.6-proposed = full instructor rule set
# v1.6-no-macro = v1.6 without CPI/FOMC blackouts (isolates macro impact)
# v1.6-no-buffer = v1.6 without the 1-day grace (strict in-extreme only)

VARIANTS = [
    {
        'name': 'v1.5-shipped',
        'desc': 'Just-shipped baseline: weekly 50/200 SMA at arm + earnings pre-only',
        'rsi_overbought':       75,
        'arm_window':           'sticky_3day',
        'weekly_filter':        'sma_50_200_arm',
        'weekly_rsi_mode':      None,
        'use_earnings_filter':  True,
        'use_macro_filter':     False,
    },
    {
        'name': 'v1.6-intra',
        'desc': '*** INTRA-WEEK *** Weekly RSI uses today close as partial-week close (direction matches discretionary chart-watching)',
        'rsi_overbought':       70,
        'arm_window':           'strict_buffer',
        'weekly_filter':        'rsi_direction_trigger',
        'weekly_rsi_mode':      'intra_week',
        'use_earnings_filter':  True,
        'use_macro_filter':     True,
    },
    {
        'name': 'v1.6-intra-no-macro',
        'desc': 'v1.6-intra without CPI/FOMC blackouts',
        'rsi_overbought':       70,
        'arm_window':           'strict_buffer',
        'weekly_filter':        'rsi_direction_trigger',
        'weekly_rsi_mode':      'intra_week',
        'use_earnings_filter':  True,
        'use_macro_filter':     False,
    },
    {
        'name': 'v1.6-SMA-fallback',
        'desc': 'FALLBACK: v1.6 rules (RSI 70 + strict arm) but keep v1.4 weekly SMA filter at arm',
        'rsi_overbought':       70,
        'arm_window':           'strict_buffer',
        'weekly_filter':        'sma_50_200_arm',
        'weekly_rsi_mode':      None,
        'use_earnings_filter':  True,
        'use_macro_filter':     True,
    },
]

# ─── Indicators ────────────────────────────────────────────────────────────

def wilder_rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    delta = closes.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)

def compute_macd(closes: pd.Series, fast=12, slow=26, signal=9):
    ema_fast = closes.ewm(span=fast, adjust=False).mean()
    ema_slow = closes.ewm(span=slow, adjust=False).mean()
    return ema_fast - ema_slow

def compute_intra_week_rsi_direction(df: pd.DataFrame, period: int = 14):
    """
    Returns two boolean Series indexed by daily bars:
        (intra_rising, intra_falling)
    where 'intra_rising' is True iff the running weekly RSI (using today's
    close as the partial close of the current incomplete week) is greater
    than the most recently completed weekly RSI.

    This matches how a discretionary trader watches the weekly chart in
    real time — the partial bar updates as today's price prints, so the
    "is the weekly RSI pointing up?" question gets a fresh answer every
    day, not stale Friday-to-Friday comparisons.
    """
    # Completed weekly closes (Fridays). Note: pandas resample includes the
    # last partial week in its output, so we drop the last value if it falls
    # after today's data — we only want COMPLETED weeks here.
    weekly_close = df['Close'].resample('W-FRI').last().dropna()

    # Wilder RSI on completed weekly closes, plus running avg_gain / avg_loss
    # so we can incrementally extend with today's running close.
    deltas = weekly_close.diff()
    gains  = deltas.where(deltas > 0, 0.0)
    losses = -deltas.where(deltas < 0, 0.0)
    avg_gain = gains.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = losses.ewm(alpha=1/period, adjust=False).mean()
    weekly_rsi = 100 - 100 / (1 + avg_gain / avg_loss)

    # For each daily bar, find the index of the most recent COMPLETED Friday.
    # searchsorted(side='right') gives insertion-point so subtracting 1 returns
    # the index of the latest Friday <= daily_bar_date.
    weekly_idx = weekly_close.index
    daily_idx  = df.index
    prior_friday_pos = weekly_idx.searchsorted(daily_idx, side='right') - 1

    intra_rising  = []
    intra_falling = []

    for i in range(len(df)):
        pf = prior_friday_pos[i]
        daily_date  = daily_idx[i]
        today_close = df['Close'].iloc[i]

        if pf < period or pd.isna(weekly_rsi.iloc[pf]):
            intra_rising.append(False)
            intra_falling.append(False)
            continue

        if daily_date in weekly_idx and weekly_idx[pf] == daily_date:
            # Today IS a Friday with a completed weekly bar — use the
            # completed-bar direction (this Friday vs prior Friday).
            cur  = weekly_rsi.iloc[pf]
            prev = weekly_rsi.iloc[pf - 1] if pf > 0 else float('nan')
        else:
            # Intra-week: simulate one more Wilder step using today's close
            # as the new "partial" weekly close.
            prev_close = weekly_close.iloc[pf]
            delta      = today_close - prev_close
            ag = (avg_gain.iloc[pf] * (period - 1) + max(delta, 0))  / period
            al = (avg_loss.iloc[pf] * (period - 1) + max(-delta, 0)) / period
            cur  = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
            prev = weekly_rsi.iloc[pf]

        if pd.isna(prev) or pd.isna(cur):
            intra_rising.append(False)
            intra_falling.append(False)
        else:
            intra_rising.append(cur > prev)
            intra_falling.append(cur < prev)

    return (pd.Series(intra_rising,  index=daily_idx),
            pd.Series(intra_falling, index=daily_idx))

# ─── Event date helpers ────────────────────────────────────────────────────

def load_event_dates():
    j = json.loads(EVENT_DATES.read_text(encoding='utf-8'))
    return {
        'fomc': sorted(datetime.fromisoformat(d).date() for d in j['fomc']),
        'cpi':  sorted(datetime.fromisoformat(d).date() for d in j['cpi']),
    }

def is_in_pre_event_blackout(check_date: pd.Timestamp, event_dates: list, days: int) -> bool:
    check = check_date.date()
    for ed in event_dates:
        delta = (ed - check).days
        if 0 <= delta <= days:
            return True
    return False

# ─── Earnings cache (per-ticker) ──────────────────────────────────────────

def load_earnings_cache():
    if EARNINGS_CACHE.exists():
        try:
            return json.loads(EARNINGS_CACHE.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {}

def save_earnings_cache(cache):
    EARNINGS_CACHE.write_text(json.dumps(cache, indent=2, default=str), encoding='utf-8')

def fetch_earnings_dates(ticker: str, cache: dict) -> list:
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

def is_in_pre_earnings_blackout(check_date: pd.Timestamp, earnings_dates: list, days: int) -> bool:
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

# ─── Strategy simulation ──────────────────────────────────────────────────

def backtest_ticker(ticker, df, variant, earnings_dates, fomc_dates, cpi_dates,
                    allow_longs=True, allow_shorts=True):
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], period=RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], period=RSI3_PERIOD)
    df['MACD'] = compute_macd(df['Close'])

    rsi_overbought = variant['rsi_overbought']
    rsi_short_buffer = rsi_overbought - 5  # 5-pt buffer below threshold

    # ── Weekly filter resolution ──────────────────────────────────────────
    weekly_close = df['Close'].resample('W-FRI').last().dropna()

    # Mode A — completed-bar weekly RSI direction (W-on-W, stale by up to 5 days)
    weekly_rsi_completed = wilder_rsi(weekly_close, WEEKLY_RSI_PERIOD)
    completed_rsi_prev   = weekly_rsi_completed.shift(1)
    completed_rsi_rising  = (weekly_rsi_completed > completed_rsi_prev).reindex(df.index, method='ffill').fillna(False)
    completed_rsi_falling = (weekly_rsi_completed < completed_rsi_prev).reindex(df.index, method='ffill').fillna(False)

    # Mode B — intra-week running weekly RSI direction (today's close as partial-week close)
    if variant.get('weekly_rsi_mode') == 'intra_week':
        intra_rising, intra_falling = compute_intra_week_rsi_direction(df, WEEKLY_RSI_PERIOD)
        weekly_rsi_rising  = intra_rising
        weekly_rsi_falling = intra_falling
    else:
        weekly_rsi_rising  = completed_rsi_rising
        weekly_rsi_falling = completed_rsi_falling

    # SMA 50/200 weekly trend filter (v1.4 baseline behaviour)
    if len(weekly_close) >= 200:
        w_sma_fast = weekly_close.rolling(50).mean()
        w_sma_slow = weekly_close.rolling(200).mean()
        sma_long_ok  = (w_sma_fast > w_sma_slow).reindex(df.index, method='ffill').fillna(False)
        sma_short_ok = (w_sma_fast < w_sma_slow).reindex(df.index, method='ffill').fillna(False)
    else:
        sma_long_ok  = pd.Series(True, index=df.index)
        sma_short_ok = pd.Series(True, index=df.index)

    df['weekly_rsi_rising']  = weekly_rsi_rising
    df['weekly_rsi_falling'] = weekly_rsi_falling
    df['sma_long_ok']        = sma_long_ok
    df['sma_short_ok']       = sma_short_ok

    # ── Filter resolution ─────────────────────────────────────────────────
    wf = variant['weekly_filter']
    aw = variant['arm_window']

    trades = []
    arm_dir = None
    arm_signal_low = None
    arm_signal_high = None
    days_outside_extreme = 0      # v1.6
    days_since_arm = 0            # v1.5-style timeout

    in_position = None
    prev_rsi = None
    prev_macd = None

    for i, (date, row) in enumerate(df.iterrows()):
        rsi  = row['RSI']
        macd = row['MACD']
        rsi3 = row['RSI3']

        if pd.isna(rsi) or pd.isna(macd) or prev_rsi is None or prev_macd is None:
            prev_rsi, prev_macd = rsi, macd
            continue

        rsi_rising   = rsi > prev_rsi
        rsi_falling  = rsi < prev_rsi
        macd_rising  = macd > prev_macd
        macd_falling = macd < prev_macd

        # ── EXIT FIRST ────────────────────────────────────────────────────
        if in_position is not None:
            exited = False
            if in_position['side'] == 'LONG':
                if row['Low'] <= in_position['stop']:
                    exit_price = in_position['stop']; reason = 'stop'
                    pnl = (exit_price - in_position['entry_price']) * in_position['shares']
                    pnl_pct = (exit_price - in_position['entry_price']) / in_position['entry_price'] * 100
                    exited = True
                elif rsi >= RSI_EXIT:
                    exit_price = row['Close']; reason = 'rsi50'
                    pnl = (exit_price - in_position['entry_price']) * in_position['shares']
                    pnl_pct = (exit_price - in_position['entry_price']) / in_position['entry_price'] * 100
                    exited = True
            else:
                if row['High'] >= in_position['stop']:
                    exit_price = in_position['stop']; reason = 'stop'
                    pnl = (in_position['entry_price'] - exit_price) * in_position['shares']
                    pnl_pct = (in_position['entry_price'] - exit_price) / in_position['entry_price'] * 100
                    exited = True
                elif rsi <= RSI_EXIT:
                    exit_price = row['Close']; reason = 'rsi50'
                    pnl = (in_position['entry_price'] - exit_price) * in_position['shares']
                    pnl_pct = (in_position['entry_price'] - exit_price) / in_position['entry_price'] * 100
                    exited = True
            if exited:
                trades.append({
                    'side': in_position['side'],
                    'entry_date': in_position['entry_date'],
                    'entry_price': round(in_position['entry_price'], 2),
                    'exit_date': date.strftime('%Y-%m-%d'),
                    'exit_price': round(exit_price, 2),
                    'stop': round(in_position['stop'], 2),
                    'shares': in_position['shares'],
                    'pnl': round(pnl, 2),
                    'pnl_pct': round(pnl_pct, 2),
                    'exit_reason': reason,
                    'bars_held': i - in_position['entry_idx'],
                })
                in_position = None
            else:
                prev_rsi, prev_macd = rsi, macd
                continue

        # ── Compute zone flags ────────────────────────────────────────────
        in_extreme_long  = rsi < RSI_OVERSOLD
        in_extreme_short = rsi > rsi_overbought
        in_buffer_long   = RSI_OVERSOLD <= rsi < RSI_LONG_BUFFER     # 30-35
        in_buffer_short  = rsi_short_buffer < rsi <= rsi_overbought  # 65-70

        # ── Event blackouts ───────────────────────────────────────────────
        earn_block  = variant['use_earnings_filter'] and is_in_pre_earnings_blackout(date, earnings_dates, EARNINGS_BLACKOUT)
        macro_block = variant['use_macro_filter'] and (
            is_in_pre_event_blackout(date, fomc_dates, MACRO_BLACKOUT) or
            is_in_pre_event_blackout(date, cpi_dates,  MACRO_BLACKOUT)
        )
        any_block = earn_block or macro_block

        # ── RSI(3) confirmation (rebound-zone, mirrors instructor's note) ─
        rsi3_ok_long  = not pd.isna(rsi3) and rsi3 < RSI_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > rsi_overbought

        # ── ARM ──────────────────────────────────────────────────────────
        if arm_dir is None and in_position is None and not any_block:
            if allow_longs and in_extreme_long and rsi3_ok_long:
                arm_dir = 'LONG'
                arm_signal_low  = row['Low']
                arm_signal_high = row['High']
                days_outside_extreme = 0
                days_since_arm = 0
            elif allow_shorts and in_extreme_short and rsi3_ok_short:
                arm_dir = 'SHORT'
                arm_signal_low  = row['Low']
                arm_signal_high = row['High']
                days_outside_extreme = 0
                days_since_arm = 0
        elif arm_dir is not None:
            days_since_arm += 1
            arm_signal_low  = min(arm_signal_low,  row['Low'])
            arm_signal_high = max(arm_signal_high, row['High'])
            if arm_dir == 'LONG':
                days_outside_extreme = 0 if in_extreme_long else days_outside_extreme + 1
            else:
                days_outside_extreme = 0 if in_extreme_short else days_outside_extreme + 1

        # ── Arm validity check (per variant's arm_window) ────────────────
        if arm_dir is not None:
            if aw == 'strict_buffer':
                if arm_dir == 'LONG':
                    valid = in_extreme_long or (days_outside_extreme <= GRACE_DAYS and in_buffer_long)
                else:
                    valid = in_extreme_short or (days_outside_extreme <= GRACE_DAYS and in_buffer_short)
                if not valid:
                    arm_dir = None
            elif aw == 'strict_in_extreme_only':
                if arm_dir == 'LONG':
                    valid = in_extreme_long
                else:
                    valid = in_extreme_short
                if not valid:
                    arm_dir = None
            elif aw == 'sticky_3day':
                if days_since_arm > 3:
                    arm_dir = None
            # cancel on event blackout
            if any_block:
                arm_dir = None

        if arm_dir is None:
            arm_signal_low = None
            arm_signal_high = None
            days_outside_extreme = 0
            days_since_arm = 0

        # ── Weekly filter resolution at trigger ──────────────────────────
        if wf == 'rsi_direction_trigger':
            wk_long_trigger  = bool(row['weekly_rsi_rising'])
            wk_short_trigger = bool(row['weekly_rsi_falling'])
            wk_long_arm  = True
            wk_short_arm = True
        elif wf == 'sma_50_200_arm':
            wk_long_arm  = bool(row['sma_long_ok'])
            wk_short_arm = bool(row['sma_short_ok'])
            wk_long_trigger  = True
            wk_short_trigger = True
        else:
            wk_long_arm = wk_short_arm = wk_long_trigger = wk_short_trigger = True

        # For sma_50_200_arm variant only: re-check arm condition at arm time
        # (we always armed above without weekly check, so for sticky_3day variant
        # we need to honor the SMA at arm. Apply retroactively by re-cancelling
        # if SMA filter would have blocked the arm.)
        if arm_dir == 'LONG' and not wk_long_arm and wf == 'sma_50_200_arm':
            arm_dir = None
        elif arm_dir == 'SHORT' and not wk_short_arm and wf == 'sma_50_200_arm':
            arm_dir = None

        # ── TRIGGER (entry) ──────────────────────────────────────────────
        if arm_dir == 'LONG' and rsi_rising and macd_rising and wk_long_trigger and in_position is None:
            stop = math.floor(arm_signal_low)
            entry_price = row['Close']
            if entry_price > stop:
                risk_per_share = entry_price - stop
                shares = max(1, int(RISK_PER_TRADE / risk_per_share))
                in_position = {
                    'side': 'LONG',
                    'entry_date': date.strftime('%Y-%m-%d'),
                    'entry_idx': i,
                    'entry_price': entry_price,
                    'stop': stop,
                    'shares': shares,
                }
                arm_dir = None
                arm_signal_low = None
                arm_signal_high = None
                days_outside_extreme = 0
                days_since_arm = 0
        elif arm_dir == 'SHORT' and rsi_falling and macd_falling and wk_short_trigger and in_position is None:
            stop = math.ceil(arm_signal_high)
            entry_price = row['Close']
            if stop > entry_price:
                risk_per_share = stop - entry_price
                shares = max(1, int(RISK_PER_TRADE / risk_per_share))
                in_position = {
                    'side': 'SHORT',
                    'entry_date': date.strftime('%Y-%m-%d'),
                    'entry_idx': i,
                    'entry_price': entry_price,
                    'stop': stop,
                    'shares': shares,
                }
                arm_dir = None
                arm_signal_low = None
                arm_signal_high = None
                days_outside_extreme = 0
                days_since_arm = 0

        prev_rsi, prev_macd = rsi, macd

    return trades

# ─── Stats ─────────────────────────────────────────────────────────────────

def compute_stats(trades):
    if not trades:
        return {'total': 0, 'wins': 0, 'losses': 0, 'win_rate': 0.0,
                'profit_factor': 0.0, 'total_pnl': 0.0, 'avg_win': 0.0,
                'avg_loss': 0.0, 'stop_outs': 0, 'rsi50_exits': 0,
                'avg_bars_held': 0}
    wins   = [t for t in trades if t['pnl'] > 0]
    losses = [t for t in trades if t['pnl'] <= 0]
    total_pnl = sum(t['pnl'] for t in trades)
    win_pnl  = sum(t['pnl'] for t in wins)
    loss_pnl = sum(t['pnl'] for t in losses)
    pf = abs(win_pnl / loss_pnl) if loss_pnl != 0 else (999.0 if win_pnl > 0 else 0.0)
    return {
        'total': len(trades),
        'wins': len(wins),
        'losses': len(losses),
        'win_rate': round(len(wins) / len(trades) * 100, 1),
        'profit_factor': round(pf, 2),
        'total_pnl': round(total_pnl, 2),
        'avg_win': round(win_pnl / len(wins), 2) if wins else 0.0,
        'avg_loss': round(loss_pnl / len(losses), 2) if losses else 0.0,
        'stop_outs': sum(1 for t in trades if t['exit_reason'] == 'stop'),
        'rsi50_exits': sum(1 for t in trades if t['exit_reason'] == 'rsi50'),
        'avg_bars_held': round(sum(t['bars_held'] for t in trades) / len(trades), 1),
    }

# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    print(f'━━ SID v1.6 Validation — {BACKTEST_YEARS}y window on {UNIVERSE.upper()} ━━\n')

    wl = json.loads(WATCHLIST_PATH.read_text(encoding='utf-8'))
    if UNIVERSE == 'favourites':
        tickers = wl['sections']['favourites']
    elif UNIVERSE == 'all':
        tickers = wl['sections']['all']
    else:
        tickers = wl['sections']['favourites'] + wl['sections']['all']

    print(f'Universe: {UNIVERSE} — {len(tickers)} tickers')
    print(f'Variants tested:')
    for v in VARIANTS:
        print(f'  - {v["name"]:18}  {v["desc"]}')
    print()

    events = load_event_dates()
    fomc_dates, cpi_dates = events['fomc'], events['cpi']
    print(f'Event calendar: {len(fomc_dates)} FOMC dates, {len(cpi_dates)} CPI dates')

    end_date       = datetime.now()
    backtest_start = end_date - timedelta(days=365 * BACKTEST_YEARS)
    history_start  = end_date - timedelta(days=HISTORY_WARMUP_DAYS + 365 * BACKTEST_YEARS)
    print(f'Trade window:  {backtest_start.date()} -> {end_date.date()}')
    print(f'Data starts:   {history_start.date()}\n')

    earnings_cache = load_earnings_cache()
    results = {}

    for idx, ticker in enumerate(tickers, 1):
        print(f'[{idx}/{len(tickers)}] {ticker:6}  ', end='', flush=True)
        try:
            df = yf.download(ticker, start=history_start.strftime('%Y-%m-%d'),
                             end=end_date.strftime('%Y-%m-%d'),
                             interval='1d', progress=False,
                             auto_adjust=False, multi_level_index=False)
            if df.empty or len(df) < 50:
                print(f'skipped (insufficient data, {len(df)} bars)')
                continue
            df.index = pd.to_datetime(df.index)
        except Exception as e:
            print(f'fetch error: {e}')
            continue

        earnings_dates = fetch_earnings_dates(ticker, earnings_cache)
        allow_longs  = ticker not in SHORT_ONLY
        allow_shorts = ticker not in LONG_ONLY

        backtest_start_str = backtest_start.strftime('%Y-%m-%d')
        results[ticker] = {}
        for variant in VARIANTS:
            all_trades = backtest_ticker(ticker, df, variant, earnings_dates,
                                         fomc_dates, cpi_dates,
                                         allow_longs=allow_longs,
                                         allow_shorts=allow_shorts)
            trades = [t for t in all_trades if t['entry_date'] >= backtest_start_str]
            results[ticker][variant['name']] = {
                'all'    : compute_stats(trades),
                'longs'  : compute_stats([t for t in trades if t['side'] == 'LONG']),
                'shorts' : compute_stats([t for t in trades if t['side'] == 'SHORT']),
                'trades' : trades,
            }

        bits = []
        for v in VARIANTS:
            s = results[ticker][v['name']]['all']
            tag = v['name'].replace('v1.', '').replace('-', '')[:6]
            bits.append(f"{tag}:{s['total']:>2}/{s['win_rate']:.0f}%")
        print(' | '.join(bits))

        if idx % 5 == 0:
            save_earnings_cache(earnings_cache)
    save_earnings_cache(earnings_cache)

    # ── Aggregate ─────────────────────────────────────────────────────────
    print('\n━━ AGGREGATE RESULTS ━━\n')
    aggregates = {}
    for variant in VARIANTS:
        all_trades = []
        for ticker in results:
            all_trades.extend(results[ticker][variant['name']]['trades'])
        agg = compute_stats(all_trades)
        aggregates[variant['name']] = agg
        color = 'GREEN' if agg['win_rate'] >= 65 else 'YELLOW' if agg['win_rate'] >= 50 else 'RED'
        print(f"  [{color:6}] {variant['name']:18}  {agg['total']:>4} trades  "
              f"WR {agg['win_rate']:>5.1f}%  PF {agg['profit_factor']:>5.2f}  "
              f"P&L ${agg['total_pnl']:>+9.2f}  "
              f"({agg['rsi50_exits']} TP / {agg['stop_outs']} SL)")

    # ── Verdict ──────────────────────────────────────────────────────────
    v15 = aggregates['v1.5-shipped']
    print()
    print('━━ VERDICT ━━')
    print(f"  v1.5 baseline:  {v15['total']} trades, {v15['win_rate']:.1f}% WR, PF {v15['profit_factor']:.2f}, P&L ${v15['total_pnl']:+.2f}")
    print(f"  Target band:    65-85% WR (community 2500-trade range)")
    print()

    # Compare each non-baseline variant
    best_name = 'v1.5-shipped'
    best_wr   = v15['win_rate']
    for v in VARIANTS:
        if v['name'] == 'v1.5-shipped':
            continue
        agg = aggregates[v['name']]
        delta_wr   = agg['win_rate']  - v15['win_rate']
        delta_pnl  = agg['total_pnl'] - v15['total_pnl']
        delta_n    = agg['total']     - v15['total']
        in_band    = 65 <= agg['win_rate'] <= 85
        beats_v15  = agg['win_rate'] > v15['win_rate'] and agg['total_pnl'] > v15['total_pnl']
        if agg['win_rate'] > best_wr:
            best_wr   = agg['win_rate']
            best_name = v['name']
        flag = 'IN BAND - SHIP CANDIDATE' if in_band else ('beats v1.5' if beats_v15 else 'rejected')
        print(f"  {v['name']:25}  {agg['total']:>4} trades  {agg['win_rate']:>5.1f}% WR  "
              f"(d {delta_wr:+.1f}pp, d{delta_n:+d} trades, ${delta_pnl:+.2f})  [{flag}]")
    print()
    print(f"  Best variant: {best_name} at {best_wr:.1f}% WR")
    if best_name == 'v1.5-shipped':
        print(f"  -> All v1.6 variants underperform. Recommendation: STAY ON v1.5.")
    elif 65 <= best_wr <= 85:
        print(f"  -> {best_name} clears the target band. Recommendation: SHIP {best_name}.")
    else:
        print(f"  -> {best_name} beats v1.5 but misses target band. Recommendation: investigate or stay.")

    # ── Save reports ──────────────────────────────────────────────────────
    report = {
        'generated':     datetime.now().isoformat(),
        'universe':      UNIVERSE,
        'tickers':       tickers,
        'backtest_years': BACKTEST_YEARS,
        'backtest_start': backtest_start.date().isoformat(),
        'backtest_end':   end_date.date().isoformat(),
        'risk_per_trade': RISK_PER_TRADE,
        'variants':       VARIANTS,
        'aggregates':     aggregates,
        'per_ticker':     {ticker: {v['name']: {k: results[ticker][v['name']][k]
                                                for k in ['all', 'longs', 'shorts']}
                                    for v in VARIANTS}
                           for ticker in results},
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding='utf-8')
    REPORT_MD.write_text(render_markdown(report), encoding='utf-8')
    print(f'\nWrote {REPORT_MD.name} + {REPORT_JSON.name}')

# ─── Markdown ──────────────────────────────────────────────────────────────

def render_markdown(report):
    L = []
    L.append('# SID v1.6 — Instructor-Aligned Validation')
    L.append('')
    L.append(f"**Generated:** {report['generated']}")
    L.append(f"**Universe:** {report['universe']} ({len(report['tickers'])} tickers)")
    L.append(f"**Window:** {report['backtest_start']} -> {report['backtest_end']} ({report['backtest_years']} years)")
    L.append(f"**Risk per trade:** ${report['risk_per_trade']:.0f}")
    L.append('')
    L.append('## Variants tested')
    L.append('')
    L.append('| Variant | Description |')
    L.append('|---|---|')
    for v in report['variants']:
        L.append(f"| **{v['name']}** | {v['desc']} |")
    L.append('')
    L.append('## Aggregate results')
    L.append('')
    L.append('| Variant | Trades | WR | PF | Net P&L | TP exits | SL hits |')
    L.append('|---|---:|---:|---:|---:|---:|---:|')
    aggs = report['aggregates']
    for v in report['variants']:
        a = aggs[v['name']]
        pf = '∞' if a['profit_factor'] >= 999 else f"{a['profit_factor']:.2f}"
        L.append(f"| **{v['name']}** | {a['total']} | **{a['win_rate']:.1f}%** | {pf} | ${a['total_pnl']:+.2f} | {a['rsi50_exits']} | {a['stop_outs']} |")
    L.append('')
    L.append('## Per-ticker WR by variant')
    L.append('')
    headers = ['Ticker'] + [v['name'] for v in report['variants']]
    L.append('| ' + ' | '.join(headers) + ' |')
    L.append('|' + '---|' * len(headers))
    for ticker in report['per_ticker']:
        row = [ticker]
        for v in report['variants']:
            s = report['per_ticker'][ticker][v['name']]['all']
            row.append(f"{s['win_rate']:.0f}% ({s['total']})" if s['total'] else '—')
        L.append('| ' + ' | '.join(row) + ' |')
    L.append('')
    return '\n'.join(L)

if __name__ == '__main__':
    main()
