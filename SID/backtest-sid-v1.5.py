"""
backtest-sid-v1.5.py — Multi-variant comparison harness

Tests the v1.5 proposed rule changes against the v1.4 locked baseline in a
single pass over the same data. Every variant is evaluated bar-by-bar on
identical OHLCV so the comparison is apples-to-apples.

Changes being evaluated (vs v1.4 baseline):
  1. Weekly trend filter SWAP:
     v1.4 baseline           — weekly 50-SMA > 200-SMA
     v1.5-A (momentum)       — weekly RSI(14) > 50 for longs / < 50 for shorts
     v1.5-B (trajectory)     — weekly RSI(14) rising W-on-W for longs / falling for shorts
     v1.5-C (combined)       — both A and B must be true

  2. Earnings rule (pre-earnings ONLY, dynamic via yfinance):
     v1.4 baseline           — no earnings filter (yfinance historic earnings not used)
     v1.5 all variants       — block trades 14 days BEFORE earnings, allow day-after

  3. Window:
     v1.4 baseline           — 12 months
     v1.5 default            — 60 months (5 years) for statistical confidence

Output:
  backtest-v1.5-comparison.md   — side-by-side variant comparison
  backtest-v1.5-comparison.json — raw stats per variant per ticker

Usage:
  cd SID
  python backtest-sid-v1.5.py
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

# ─── Shared params ─────────────────────────────────────────────────────────
RSI_PERIOD         = 14
RSI_OVERSOLD       = 30
RSI_OVERBOUGHT     = 75
RSI_EXIT           = 50
RSI3_PERIOD        = 3
RSI3_OVERSOLD      = 30
RSI3_OVERBOUGHT    = 75
WEEKLY_RSI_PERIOD  = 14    # for v1.5 weekly RSI variants
WEEKLY_FAST_SMA    = 50    # for v1.4 baseline
WEEKLY_SLOW_SMA    = 200
MACD_FAST          = 12
MACD_SLOW          = 26
MACD_SIGNAL        = 9
TIMEOUT_DAYS       = 3
RISK_PER_TRADE     = 200.0           # 2% of $10k
EARNINGS_BLACKOUT  = 14              # days before earnings (pre only)
BACKTEST_YEARS     = int(os.environ.get('SID_BACKTEST_YEARS', '5'))
HISTORY_WARMUP_DAYS = 365 * 5 + 30   # 5y warmup for weekly 200-SMA

# Files
WATCHLIST_PATH = Path(__file__).parent / 'watchlist-sid.json'
REPORT_MD      = Path(__file__).parent / 'backtest-v1.5-comparison.md'
REPORT_JSON    = Path(__file__).parent / 'backtest-v1.5-comparison.json'
EARNINGS_CACHE = Path(__file__).parent / '.earnings-cache.json'

# Per-ticker direction restrictions (same as v1.4)
LONG_ONLY  = {'XLC', 'QQQ', 'AMD', 'INTC', 'SPY', 'CAT', 'MSFT', 'TQQQ', 'XLK', 'GOLD', 'GS', 'IBM', 'JPM', 'XLB', 'XLE'}
SHORT_ONLY = set()

# ─── Variant config (drives what filters apply) ────────────────────────────
# Each variant is a dict: { name, use_weekly_sma, use_weekly_rsi_momentum, use_weekly_rsi_trajectory, use_earnings_filter }

# Full variant grid used to validate the v1.5 ship decision (2026-05-12).
# Decision: ship v1.5-baseline-plus-earnings.
#   - WR  62.3% (vs baseline 60.9%) — +1.4pp
#   - PF  1.98  (vs baseline 1.85)  — +0.13
#   - PnL -$1,084 over 5 years (acceptable cost for better risk profile)
# Variants below kept in source as the validation evidence + ready-to-rerun
# harness for any future tweak. Trim VARIANTS to focus a specific test.
VARIANTS = [
    {
        'name': 'v1.4-baseline',
        'desc': 'Weekly 50/200 SMA at ARM, no earnings filter (locked baseline)',
        'phase': 'arm',
        'use_weekly_sma':           True,
        'use_weekly_rsi_momentum':  False,
        'use_weekly_rsi_trajectory':False,
        'use_earnings_filter':      False,
    },
    {
        'name': 'v1.5-shipped',
        'desc': '*** SHIPPED v1.5 — baseline + 14-day pre-only earnings blackout ***',
        'phase': 'arm',
        'use_weekly_sma':           True,
        'use_weekly_rsi_momentum':  False,
        'use_weekly_rsi_trajectory':False,
        'use_earnings_filter':      True,
    },
    {
        'name': 'rejected-A-trigger-momentum',
        'desc': 'REJECTED: Weekly RSI > 50 (long) / < 50 (short) at TRIGGER. Too restrictive — 3 trades only.',
        'phase': 'trigger',
        'use_weekly_sma':           False,
        'use_weekly_rsi_momentum':  True,
        'use_weekly_rsi_trajectory':False,
        'use_earnings_filter':      True,
    },
    {
        'name': 'rejected-B-trigger-trajectory',
        'desc': 'REJECTED: Weekly RSI rising/falling at TRIGGER. 31 trades, 58.1% WR — lost to baseline 60.9%.',
        'phase': 'trigger',
        'use_weekly_sma':           False,
        'use_weekly_rsi_momentum':  False,
        'use_weekly_rsi_trajectory':True,
        'use_earnings_filter':      True,
    },
    {
        'name': 'rejected-C-trigger-combined',
        'desc': 'REJECTED: Both momentum AND trajectory at TRIGGER. 0 trades fired — impossible setup.',
        'phase': 'trigger',
        'use_weekly_sma':           False,
        'use_weekly_rsi_momentum':  True,
        'use_weekly_rsi_trajectory':True,
        'use_earnings_filter':      True,
    },
]

# ─── Indicators ────────────────────────────────────────────────────────────

def wilder_rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    """Wilder-smoothed RSI matching TradingView default."""
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

# ─── Earnings cache ────────────────────────────────────────────────────────
# Fetching earnings dates from yfinance is slow and rate-limited. Cache them.

def load_earnings_cache():
    if EARNINGS_CACHE.exists():
        try:
            return json.loads(EARNINGS_CACHE.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {}

def save_earnings_cache(cache):
    EARNINGS_CACHE.write_text(json.dumps(cache, indent=2, default=str), encoding='utf-8')

def fetch_earnings_dates(ticker: str, cache: dict) -> list[str]:
    """Returns sorted list of ISO date strings for past + future earnings.
    Cached per ticker to keep the harness fast across runs."""
    if ticker in cache:
        return cache[ticker]
    try:
        tkr = yf.Ticker(ticker)
        # yfinance's earnings_dates includes both past and future
        df = tkr.earnings_dates
        if df is None or df.empty:
            dates = []
        else:
            dates = sorted({d.date().isoformat() for d in df.index})
    except Exception as e:
        print(f'    ⚠ earnings fetch failed for {ticker}: {e}')
        dates = []
    cache[ticker] = dates
    return dates

def is_in_pre_earnings_blackout(check_date: pd.Timestamp, earnings_dates: list[str], days: int) -> bool:
    """Returns True if the next earnings date is within `days` calendar days
    AFTER check_date (i.e., we're inside the pre-earnings blackout window).
    Allowing trading on or after earnings day is the entire point of the new rule."""
    check = check_date.date()
    for ed_str in earnings_dates:
        try:
            ed = datetime.fromisoformat(ed_str).date()
        except Exception:
            continue
        delta = (ed - check).days
        if 0 <= delta <= days:  # earnings is today or up to 14 days from now
            return True
    return False

# ─── Strategy simulation (variant-aware) ──────────────────────────────────

def backtest_ticker(ticker: str, df: pd.DataFrame, variant: dict,
                    earnings_dates: list[str], allow_longs=True, allow_shorts=True):
    """Walk daily bars. Apply `variant` filter config. Returns list of trade dicts."""
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], period=RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], period=RSI3_PERIOD)
    df['MACD'] = compute_macd(df['Close'])

    # ── Weekly trend filters (compute once, reindex to daily) ─────────────
    weekly_close = df['Close'].resample('W-FRI').last().dropna()

    # v1.4: weekly SMA cross
    if len(weekly_close) >= WEEKLY_SLOW_SMA:
        w_sma_fast = weekly_close.rolling(WEEKLY_FAST_SMA).mean()
        w_sma_slow = weekly_close.rolling(WEEKLY_SLOW_SMA).mean()
        weekly_uptrend_sma   = w_sma_fast > w_sma_slow
        weekly_downtrend_sma = w_sma_fast < w_sma_slow
    else:
        weekly_uptrend_sma   = pd.Series(True, index=weekly_close.index)
        weekly_downtrend_sma = pd.Series(True, index=weekly_close.index)

    # v1.5: weekly RSI
    weekly_rsi = wilder_rsi(weekly_close, period=WEEKLY_RSI_PERIOD)
    weekly_rsi_prev = weekly_rsi.shift(1)

    weekly_rsi_above_50  = weekly_rsi > 50
    weekly_rsi_below_50  = weekly_rsi < 50
    weekly_rsi_rising    = weekly_rsi > weekly_rsi_prev
    weekly_rsi_falling   = weekly_rsi < weekly_rsi_prev

    # Map all weekly series onto daily index (forward-fill)
    df['weekly_uptrend_sma']    = weekly_uptrend_sma.reindex(df.index, method='ffill').fillna(False)
    df['weekly_downtrend_sma']  = weekly_downtrend_sma.reindex(df.index, method='ffill').fillna(False)
    df['weekly_rsi_above_50']   = weekly_rsi_above_50.reindex(df.index, method='ffill').fillna(False)
    df['weekly_rsi_below_50']   = weekly_rsi_below_50.reindex(df.index, method='ffill').fillna(False)
    df['weekly_rsi_rising']     = weekly_rsi_rising.reindex(df.index, method='ffill').fillna(False)
    df['weekly_rsi_falling']    = weekly_rsi_falling.reindex(df.index, method='ffill').fillna(False)

    # ── Variant-specific filter resolution ────────────────────────────────
    def weekly_long_ok(row):
        ok = True
        if variant['use_weekly_sma']:
            ok = ok and bool(row['weekly_uptrend_sma'])
        if variant['use_weekly_rsi_momentum']:
            ok = ok and bool(row['weekly_rsi_above_50'])
        if variant['use_weekly_rsi_trajectory']:
            ok = ok and bool(row['weekly_rsi_rising'])
        return ok

    def weekly_short_ok(row):
        ok = True
        if variant['use_weekly_sma']:
            ok = ok and bool(row['weekly_downtrend_sma'])
        if variant['use_weekly_rsi_momentum']:
            ok = ok and bool(row['weekly_rsi_below_50'])
        if variant['use_weekly_rsi_trajectory']:
            ok = ok and bool(row['weekly_rsi_falling'])
        return ok

    trades = []
    arm_dir            = None
    arm_signal_low     = None
    arm_signal_high    = None
    days_since_arm     = 0
    in_position        = None
    prev_rsi  = None
    prev_macd = None

    for i, (date, row) in enumerate(df.iterrows()):
        rsi  = row['RSI']
        macd = row['MACD']

        if pd.isna(rsi) or pd.isna(macd) or prev_rsi is None or prev_macd is None:
            prev_rsi, prev_macd = rsi, macd
            continue

        rsi_rising   = rsi > prev_rsi
        rsi_falling  = rsi < prev_rsi
        macd_rising  = macd > prev_macd
        macd_falling = macd < prev_macd

        # ── EXIT first ─────────────────────────────────────────────────────
        if in_position is not None:
            exited = False
            if in_position['side'] == 'LONG':
                if row['Low'] <= in_position['stop']:
                    exit_price = in_position['stop']
                    reason = 'stop'
                    pnl = (exit_price - in_position['entry_price']) * in_position['shares']
                    pnl_pct = (exit_price - in_position['entry_price']) / in_position['entry_price'] * 100
                    exited = True
                elif rsi >= RSI_EXIT:
                    exit_price = row['Close']
                    reason = 'rsi50'
                    pnl = (exit_price - in_position['entry_price']) * in_position['shares']
                    pnl_pct = (exit_price - in_position['entry_price']) / in_position['entry_price'] * 100
                    exited = True
            else:  # SHORT
                if row['High'] >= in_position['stop']:
                    exit_price = in_position['stop']
                    reason = 'stop'
                    pnl = (in_position['entry_price'] - exit_price) * in_position['shares']
                    pnl_pct = (in_position['entry_price'] - exit_price) / in_position['entry_price'] * 100
                    exited = True
                elif rsi <= RSI_EXIT:
                    exit_price = row['Close']
                    reason = 'rsi50'
                    pnl = (in_position['entry_price'] - exit_price) * in_position['shares']
                    pnl_pct = (in_position['entry_price'] - exit_price) / in_position['entry_price'] * 100
                    exited = True
            if exited:
                trades.append({
                    'side'        : in_position['side'],
                    'entry_date'  : in_position['entry_date'],
                    'entry_price' : round(in_position['entry_price'], 2),
                    'exit_date'   : date.strftime('%Y-%m-%d'),
                    'exit_price'  : round(exit_price, 2),
                    'stop'        : round(in_position['stop'], 2),
                    'shares'      : in_position['shares'],
                    'pnl'         : round(pnl, 2),
                    'pnl_pct'     : round(pnl_pct, 2),
                    'exit_reason' : reason,
                    'bars_held'   : i - in_position['entry_idx'],
                })
                in_position = None
            else:
                prev_rsi, prev_macd = rsi, macd
                continue

        # ── ARM logic ──────────────────────────────────────────────────────
        rsi3 = row['RSI3']
        rsi3_ok_long  = not pd.isna(rsi3) and rsi3 < RSI3_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > RSI3_OVERBOUGHT

        wk_long  = weekly_long_ok(row)
        wk_short = weekly_short_ok(row)

        # Pre-earnings blackout — only applied to variants that opt in
        earn_block = (variant['use_earnings_filter']
                      and is_in_pre_earnings_blackout(date, earnings_dates, EARNINGS_BLACKOUT))

        # Phase-aware weekly checks — baseline applies at ARM, v1.5 at TRIGGER
        wk_long_arm     = wk_long     if variant.get('phase') == 'arm' else True
        wk_short_arm    = wk_short    if variant.get('phase') == 'arm' else True
        wk_long_trigger = wk_long     if variant.get('phase') == 'trigger' else True
        wk_short_trigger= wk_short    if variant.get('phase') == 'trigger' else True

        # ── ARM logic ──────────────────────────────────────────────────────
        if arm_dir is None and in_position is None and not earn_block:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and wk_long_arm:
                arm_dir         = 'LONG'
                arm_signal_low  = row['Low']
                arm_signal_high = row['High']
                days_since_arm  = 0
            elif allow_shorts and rsi > RSI_OVERBOUGHT and rsi3_ok_short and wk_short_arm:
                arm_dir         = 'SHORT'
                arm_signal_low  = row['Low']
                arm_signal_high = row['High']
                days_since_arm  = 0
        elif arm_dir is not None:
            days_since_arm   += 1
            arm_signal_low    = min(arm_signal_low,  row['Low'])
            arm_signal_high   = max(arm_signal_high, row['High'])

        # Invalidate on timeout
        if arm_dir is not None and days_since_arm >= TIMEOUT_DAYS:
            arm_dir = None; arm_signal_low = None; arm_signal_high = None; days_since_arm = 0

        # If we're armed but earnings appears in the window, cancel
        if arm_dir is not None and earn_block:
            arm_dir = None; arm_signal_low = None; arm_signal_high = None; days_since_arm = 0

        # ── ENTRY logic ────────────────────────────────────────────────────
        if arm_dir == 'LONG' and rsi_rising and macd_rising and wk_long_trigger and in_position is None:
            stop = math.floor(arm_signal_low)
            entry_price = row['Close']
            if entry_price > stop:
                risk_per_share = entry_price - stop
                shares = max(1, int(RISK_PER_TRADE / risk_per_share))
                in_position = {
                    'side'        : 'LONG',
                    'entry_date'  : date.strftime('%Y-%m-%d'),
                    'entry_idx'   : i,
                    'entry_price' : entry_price,
                    'stop'        : stop,
                    'shares'      : shares,
                }
                arm_dir = None; arm_signal_low = None; arm_signal_high = None; days_since_arm = 0
        elif arm_dir == 'SHORT' and rsi_falling and macd_falling and wk_short and in_position is None:
            stop = math.ceil(arm_signal_high)
            entry_price = row['Close']
            if stop > entry_price:
                risk_per_share = stop - entry_price
                shares = max(1, int(RISK_PER_TRADE / risk_per_share))
                in_position = {
                    'side'        : 'SHORT',
                    'entry_date'  : date.strftime('%Y-%m-%d'),
                    'entry_idx'   : i,
                    'entry_price' : entry_price,
                    'stop'        : stop,
                    'shares'      : shares,
                }
                arm_dir = None; arm_signal_low = None; arm_signal_high = None; days_since_arm = 0

        prev_rsi, prev_macd = rsi, macd

    return trades

# ─── Stats ─────────────────────────────────────────────────────────────────

def compute_stats(trades):
    if not trades:
        return {'total': 0, 'wins': 0, 'losses': 0, 'win_rate': 0.0,
                'profit_factor': 0.0, 'total_pnl': 0.0, 'avg_win': 0.0, 'avg_loss': 0.0,
                'stop_outs': 0, 'rsi50_exits': 0, 'avg_bars_held': 0}
    wins   = [t for t in trades if t['pnl'] > 0]
    losses = [t for t in trades if t['pnl'] <= 0]
    total_pnl = sum(t['pnl'] for t in trades)
    win_pnl  = sum(t['pnl'] for t in wins)
    loss_pnl = sum(t['pnl'] for t in losses)
    pf = abs(win_pnl / loss_pnl) if loss_pnl != 0 else (999.0 if win_pnl > 0 else 0.0)
    return {
        'total'         : len(trades),
        'wins'          : len(wins),
        'losses'        : len(losses),
        'win_rate'      : round(len(wins) / len(trades) * 100, 1),
        'profit_factor' : round(pf, 2),
        'total_pnl'     : round(total_pnl, 2),
        'avg_win'       : round(win_pnl / len(wins),     2) if wins   else 0.0,
        'avg_loss'      : round(loss_pnl / len(losses),  2) if losses else 0.0,
        'stop_outs'     : sum(1 for t in trades if t['exit_reason'] == 'stop'),
        'rsi50_exits'   : sum(1 for t in trades if t['exit_reason'] == 'rsi50'),
        'avg_bars_held' : round(sum(t['bars_held'] for t in trades) / len(trades), 1),
    }

# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    print(f'━━ SID v1.5 Variant Comparison — {BACKTEST_YEARS}-year window ━━\n')

    with open(WATCHLIST_PATH) as f:
        watchlist = json.load(f)
    tickers = watchlist['tickers']
    print(f'Watchlist: {len(tickers)} tickers')
    print(f'Variants:  {len(VARIANTS)}\n')
    for v in VARIANTS:
        print(f'  - {v["name"]:30}  {v["desc"]}')
    print()

    end_date         = datetime.now()
    backtest_start   = end_date - timedelta(days=365 * BACKTEST_YEARS)
    history_start    = end_date - timedelta(days=HISTORY_WARMUP_DAYS + 365 * BACKTEST_YEARS)
    start_date       = history_start
    print(f'Trade-counting window: {backtest_start.date()} → {end_date.date()}')
    print(f'Data fetch starts at:  {start_date.date()} (for weekly 200-SMA warmup)\n')

    earnings_cache = load_earnings_cache()

    # results[ticker] = { variant_name: { 'all': stats, 'longs': stats, 'shorts': stats, 'trades': [...] } }
    results = {}

    for idx, ticker in enumerate(tickers, 1):
        print(f'[{idx}/{len(tickers)}] {ticker:6}  ', end='', flush=True)

        # Fetch OHLCV once per ticker (shared across variants)
        try:
            df = yf.download(ticker,
                             start=start_date.strftime('%Y-%m-%d'),
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

        # Fetch earnings dates once per ticker (cached)
        earnings_dates = fetch_earnings_dates(ticker, earnings_cache)

        allow_longs  = ticker not in SHORT_ONLY
        allow_shorts = ticker not in LONG_ONLY

        backtest_start_str = backtest_start.strftime('%Y-%m-%d')

        results[ticker] = {}
        for variant in VARIANTS:
            all_trades = backtest_ticker(ticker, df, variant, earnings_dates,
                                         allow_longs=allow_longs, allow_shorts=allow_shorts)
            trades = [t for t in all_trades if t['entry_date'] >= backtest_start_str]
            results[ticker][variant['name']] = {
                'all'    : compute_stats(trades),
                'longs'  : compute_stats([t for t in trades if t['side'] == 'LONG']),
                'shorts' : compute_stats([t for t in trades if t['side'] == 'SHORT']),
                'trades' : trades,
            }

        # Print mini-summary line
        summary_bits = []
        for v in VARIANTS:
            s = results[ticker][v['name']]['all']
            summary_bits.append(f"{v['name'].split('-')[1] if '-' in v['name'] else v['name']}:{s['total']:>2}/{s['win_rate']:.0f}%")
        print(' | '.join(summary_bits))

        # Save earnings cache every 5 tickers in case run is interrupted
        if idx % 5 == 0:
            save_earnings_cache(earnings_cache)

    save_earnings_cache(earnings_cache)

    # ── Aggregate per-variant ─────────────────────────────────────────────
    print('\n━━ AGGREGATE RESULTS ━━\n')

    aggregates = {}
    for variant in VARIANTS:
        all_trades = []
        for ticker in results:
            all_trades.extend(results[ticker][variant['name']]['trades'])
        agg = compute_stats(all_trades)
        aggregates[variant['name']] = agg

        wr_color = '🟢' if agg['win_rate'] >= 65 else '🟡' if agg['win_rate'] >= 50 else '🔴'
        print(f"  {wr_color} {variant['name']:30}  {agg['total']:>4} trades  "
              f"WR {agg['win_rate']:>5.1f}%  PF {agg['profit_factor']:>5.2f}  "
              f"P&L ${agg['total_pnl']:>+9.2f}  "
              f"({agg['rsi50_exits']} TP / {agg['stop_outs']} SL)")

    # ── Write reports ─────────────────────────────────────────────────────
    report = {
        'generated':         datetime.now().isoformat(),
        'backtest_years':    BACKTEST_YEARS,
        'backtest_start':    backtest_start.date().isoformat(),
        'backtest_end':      end_date.date().isoformat(),
        'tickers_total':     len(tickers),
        'tickers_scanned':   len(results),
        'risk_per_trade':    RISK_PER_TRADE,
        'variants':          VARIANTS,
        'aggregates':        aggregates,
        'per_ticker':        {
            ticker: {
                v['name']: {
                    'all':    results[ticker][v['name']]['all'],
                    'longs':  results[ticker][v['name']]['longs'],
                    'shorts': results[ticker][v['name']]['shorts'],
                } for v in VARIANTS
            } for ticker in results
        },
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding='utf-8')
    REPORT_MD.write_text(render_markdown(report), encoding='utf-8')
    print(f'\n✓ Wrote {REPORT_MD.name} + {REPORT_JSON.name}')

# ─── Markdown report ───────────────────────────────────────────────────────

def render_markdown(report: dict) -> str:
    L = []
    L.append(f'# SID v1.5 — Variant Comparison Backtest')
    L.append('')
    L.append(f"**Generated:** {report['generated']}")
    L.append(f"**Window:** {report['backtest_start']} → {report['backtest_end']} ({report['backtest_years']} years)")
    L.append(f"**Tickers scanned:** {report['tickers_scanned']} / {report['tickers_total']}")
    L.append(f"**Risk per trade:** ${report['risk_per_trade']:.0f}")
    L.append('')

    L.append('## Variants tested')
    L.append('')
    L.append('| Variant | Description |')
    L.append('|---|---|')
    for v in report['variants']:
        L.append(f"| **{v['name']}** | {v['desc']} |")
    L.append('')

    L.append('## Aggregate results (all tickers combined)')
    L.append('')
    L.append('| Variant | Trades | WR | PF | Net P&L | TP exits | SL hits | Avg bars held |')
    L.append('|---|---:|---:|---:|---:|---:|---:|---:|')
    aggs = report['aggregates']
    for v in report['variants']:
        a = aggs[v['name']]
        pf = '∞' if a['profit_factor'] >= 999 else f"{a['profit_factor']:.2f}"
        L.append(f"| **{v['name']}** | {a['total']} | **{a['win_rate']:.1f}%** | {pf} | ${a['total_pnl']:+.2f} | {a['rsi50_exits']} | {a['stop_outs']} | {a['avg_bars_held']} |")
    L.append('')

    # Sort variants by win rate for verdict
    sorted_variants = sorted(report['variants'], key=lambda v: aggs[v['name']]['win_rate'], reverse=True)
    best = sorted_variants[0]
    baseline = next(v for v in report['variants'] if v['name'] == 'v1.4-baseline')

    L.append('## Verdict')
    L.append('')
    if best['name'] == 'v1.4-baseline':
        L.append(f"**v1.4 baseline is still the best variant** with WR {aggs[best['name']]['win_rate']}% and PF {aggs[best['name']]['profit_factor']}.")
        L.append('No proposed v1.5 change outperforms the locked baseline. Recommendation: **stay on v1.4**.')
    else:
        wr_delta = aggs[best['name']]['win_rate'] - aggs[baseline['name']]['win_rate']
        pnl_delta = aggs[best['name']]['total_pnl'] - aggs[baseline['name']]['total_pnl']
        L.append(f"**{best['name']}** edges out the v1.4 baseline:")
        L.append(f"- Win rate **+{wr_delta:.1f}pp** ({aggs[baseline['name']]['win_rate']}% → {aggs[best['name']]['win_rate']}%)")
        L.append(f"- Net P&L **${pnl_delta:+.2f}** vs baseline")
        L.append(f"- Profit factor **{aggs[best['name']]['profit_factor']:.2f}** vs baseline {aggs[baseline['name']]['profit_factor']:.2f}")
        L.append('')
        L.append('**Caveat:** delta must clear noise from a single backtest window. Re-run on a different window before shipping.')
    L.append('')

    L.append('## Per-ticker breakdown (win rate by variant)')
    L.append('')
    headers = ['Ticker'] + [v['name'] for v in report['variants']]
    L.append('| ' + ' | '.join(headers) + ' |')
    L.append('|' + '---|' * len(headers))
    for ticker, by_variant in report['per_ticker'].items():
        cells = [ticker]
        for v in report['variants']:
            stats = by_variant[v['name']]['all']
            if stats['total'] == 0:
                cells.append('—')
            else:
                cells.append(f"{stats['win_rate']:.0f}% ({stats['total']})")
        L.append('| ' + ' | '.join(cells) + ' |')
    L.append('')

    L.append('## How to read this report')
    L.append('')
    L.append('- **Aggregate WR** = wins ÷ total across the entire watchlist for each variant. The fairest single number.')
    L.append('- **PF (Profit Factor)** = total winning P&L ÷ total losing P&L. PF > 1.5 is good.')
    L.append('- **TP exits** = exits where daily RSI(14) reached 50 (target hit).')
    L.append('- **SL hits** = exits where the stop loss was triggered (loss).')
    L.append("- Trades are counted only when their *entry* date falls inside the trade window. The 5-year data fetch is needed for the weekly 200-SMA warmup.")
    L.append('')

    return '\n'.join(L)

if __name__ == '__main__':
    main()
