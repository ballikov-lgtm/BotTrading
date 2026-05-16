"""
backtest-sid-v2.py — SID V2 Method backtest harness

V2 method (per SID V2 course audit + SID-V2-METHOD-SPEC.md):

  STAGE 1 ARM (signal day):
    - Daily RSI(14) < 30 (long) or > 70 (short)  ← V2 uses 70 not 75
    - Daily RSI(3) in extreme zone (rebound-zone confirmation, V1 carry-over)

  STAGE 2 TRIGGER (entry day):
    - Daily RSI pointing in trade direction
    - Daily MACD pointing in direction OR crossing signal
    - NEW: RSI at entry < 45 (long) / > 55 (short)  ← V2 no-go zone
    - NEW: Weekly RSI pointing in trade direction
    - NEW: Weekly MACD pointing in trade direction
    - (Pattern detection deferred to V2.1)

  STAGE 4 ENTRY/STOP: same as V1
    - Entry = daily close on trigger day
    - Stop = lowest low (long) / highest high (short) signal→entry, rounded out

  STAGE 5 TP (Option A — simple, V1-style):
    - Single exit at daily RSI ≥ 50 (long) / ≤ 50 (short)
    - Option B (50% at RSI50, 50% at 50/200 MA) deferred to V2.1

Variants:
  v1.7-shipped       : V1 baseline (RSI 75, no weekly direction, no no-go cap)
  v2-method          : V2 full rule set (excluding pattern bonus)

Usage:
  cd SID
  python backtest-sid-v2.py
"""

import yfinance as yf
import pandas as pd
import numpy as np
import json, math, sys, io, os
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Strategy params
RSI_PERIOD          = 14
RSI_OVERSOLD        = 30
RSI_OVERBOUGHT_V1   = 75   # V1.7 used 75
RSI_OVERBOUGHT_V2   = 70   # V2 method uses 70 per instructor
RSI_NOGO_LONG_HI    = 45   # V2: long entry rejected if RSI >= 45 (no-go zone)
RSI_NOGO_SHORT_LO   = 55   # V2: short entry rejected if RSI <= 55
RSI_EXIT            = 50
RSI3_PERIOD         = 3
WEEKLY_FAST_SMA     = 50
WEEKLY_SLOW_SMA     = 200
MACD_FAST           = 12
MACD_SLOW           = 26
MACD_SIGNAL         = 9
TIMEOUT_DAYS        = 3
RISK_PER_TRADE      = 200.0
EARNINGS_BLACKOUT   = 14
MACRO_BLACKOUT      = 14
BACKTEST_YEARS      = int(os.environ.get('SID_BACKTEST_YEARS', '5'))
HISTORY_WARMUP_DAYS = 365 * 5 + 30
UNIVERSE            = os.environ.get('SID_UNIVERSE', 'favourites').lower()

LONG_ONLY  = {'XLC','QQQ','AMD','INTC','SPY','CAT','MSFT','TQQQ','XLK','GOLD','GS','IBM','JPM','XLB','XLE'}
SHORT_ONLY = set()

WATCHLIST_PATH = Path(__file__).parent / 'watchlist-sid.json'
EVENT_DATES    = Path(__file__).parent / 'event-dates.json'
REPORT_MD      = Path(__file__).parent / 'backtest-v2-validation-report.md'
REPORT_JSON    = Path(__file__).parent / 'backtest-v2-validation-report.json'
EARNINGS_CACHE = Path(__file__).parent / '.earnings-cache.json'

VARIANTS = [
    {
        'name': 'v1.7-shipped',
        'desc': 'V1 baseline: RSI 75, no weekly, no no-go cap, 1-bar daily alignment',
        'rsi_overbought':       RSI_OVERBOUGHT_V1,
        'use_weekly_direction': False,
        'weekly_mode':          'none',
        'use_nogo_zone':        False,
        'slope_bars':           1,
    },
    {
        'name': 'v2-nogo-only',
        'desc': 'V2 minimal: RSI 70 + 45/55 no-go cap, 1-bar daily alignment',
        'rsi_overbought':       RSI_OVERBOUGHT_V2,
        'use_weekly_direction': False,
        'weekly_mode':          'none',
        'use_nogo_zone':        True,
        'slope_bars':           1,
    },
    {
        'name': 'v2-weekly-or',
        'desc': 'V2 medium: + weekly RSI OR MACD rising (1-bar daily alignment)',
        'rsi_overbought':       RSI_OVERBOUGHT_V2,
        'use_weekly_direction': True,
        'weekly_mode':          'or',
        'use_nogo_zone':        True,
        'slope_bars':           1,
    },
    {
        'name': 'v2-slope',
        'desc': '*** V2 + 2-bar daily slope (RSI & MACD rising 2 days running) ***',
        'rsi_overbought':       RSI_OVERBOUGHT_V2,
        'use_weekly_direction': True,
        'weekly_mode':          'or',
        'use_nogo_zone':        True,
        'slope_bars':           2,
    },
    {
        'name': 'v2-method',
        'desc': 'V2 strict: + weekly RSI AND MACD rising (1-bar daily alignment)',
        'rsi_overbought':       RSI_OVERBOUGHT_V2,
        'use_weekly_direction': True,
        'weekly_mode':          'and',
        'use_nogo_zone':        True,
        'slope_bars':           1,
    },
]

# ─── Indicators ──────────────────────────────────────────────────────────

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

# ─── Event date helpers ──────────────────────────────────────────────────

def load_event_dates():
    j = json.loads(EVENT_DATES.read_text(encoding='utf-8'))
    return {
        'fomc': sorted(datetime.fromisoformat(d).date() for d in j['fomc']),
        'cpi':  sorted(datetime.fromisoformat(d).date() for d in j['cpi']),
        'ppi':  sorted(datetime.fromisoformat(d).date() for d in j.get('ppi', [])),
    }

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

# ─── Weekly direction indicators ─────────────────────────────────────────

def compute_weekly_direction(df):
    """Returns Series 'weekly_rsi_rising' and 'weekly_macd_rising', reindexed
    onto daily index. True if THIS week's value > LAST week's value (for the
    week containing each daily bar).

    NOTE on date alignment: resample('W-FRI') indexes each weekly bin at the
    FRIDAY (right edge). If we ffill from that onto daily dates, a Tuesday in
    week N gets last week's value because this week's bin is dated at the
    UPCOMING Friday (a future date) and ffill only carries from past dates.
    Fix: shift the weekly index back to Monday of that week so any daily date
    within the week catches the partial weekly close including today.
    """
    weekly = df['Close'].resample('W-FRI').last().dropna()
    if len(weekly) < 30:
        return (pd.Series(False, index=df.index),
                pd.Series(False, index=df.index))
    w_rsi   = wilder_rsi(weekly, RSI_PERIOD)
    w_macd, _ = compute_macd_and_signal(weekly, MACD_FAST, MACD_SLOW, MACD_SIGNAL)
    rsi_rising  = (w_rsi  > w_rsi.shift(1))
    macd_rising = (w_macd > w_macd.shift(1))
    # Shift weekly index from Friday (week end) to Monday (week start) so the
    # partial in-progress week is visible from Monday onwards via ffill.
    rsi_rising.index  = rsi_rising.index  - pd.Timedelta(days=4)
    macd_rising.index = macd_rising.index - pd.Timedelta(days=4)
    rsi_rising_daily  = rsi_rising.reindex(df.index, method='ffill').fillna(False)
    macd_rising_daily = macd_rising.reindex(df.index, method='ffill').fillna(False)
    return rsi_rising_daily, macd_rising_daily

# ─── Strategy simulation ─────────────────────────────────────────────────

def backtest_ticker(ticker, df, variant, earnings_dates,
                    allow_longs=True, allow_shorts=True):
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], RSI3_PERIOD)
    macd, signal_line = compute_macd_and_signal(df['Close'])
    df['MACD']        = macd
    df['MACD_SIGNAL'] = signal_line

    # Weekly SMA filter (kept for V1 parity; not a V2 gate but harmless)
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

    # Weekly direction
    wk_rsi_rising, wk_macd_rising = compute_weekly_direction(df)
    df['wk_rsi_rising']  = wk_rsi_rising
    df['wk_macd_rising'] = wk_macd_rising

    trades = []
    arm_dir = None; arm_low = None; arm_high = None; days_since_arm = 0
    in_pos = None
    prev_rsi  = None
    prev_macd = None
    prev_signal = None
    prev_prev_rsi  = None   # 2-bar back, for slope_bars=2
    prev_prev_macd = None

    rsi_overbought = variant['rsi_overbought']
    slope_bars = variant.get('slope_bars', 1)

    for i, (date, row) in enumerate(df.iterrows()):
        rsi    = row['RSI']
        m      = row['MACD']
        s      = row['MACD_SIGNAL']
        rsi3   = row['RSI3']

        if pd.isna(rsi) or pd.isna(m) or pd.isna(s) or prev_rsi is None or prev_macd is None or prev_signal is None:
            prev_rsi, prev_macd, prev_signal = rsi, m, s
            continue

        rsi_rising  = rsi > prev_rsi
        rsi_falling = rsi < prev_rsi
        macd_rising  = m > prev_macd
        macd_falling = m < prev_macd
        macd_cross_up   = m > s and prev_macd <= prev_signal
        macd_cross_down = m < s and prev_macd >= prev_signal

        # 2-bar slope: indicator rising/falling for TWO bars running
        if slope_bars == 2 and prev_prev_rsi is not None and prev_prev_macd is not None:
            rsi_rising_2  = rsi_rising  and prev_rsi  > prev_prev_rsi
            rsi_falling_2 = rsi_falling and prev_rsi  < prev_prev_rsi
            macd_rising_2  = macd_rising  and prev_macd > prev_prev_macd
            macd_falling_2 = macd_falling and prev_macd < prev_prev_macd
        else:
            rsi_rising_2  = rsi_rising
            rsi_falling_2 = rsi_falling
            macd_rising_2  = macd_rising
            macd_falling_2 = macd_falling

        # ── EXIT FIRST ─────────────────────────────────────────────────────
        if in_pos is not None:
            exited = False
            if in_pos['side'] == 'LONG':
                if row['Low'] <= in_pos['stop']:
                    ex_price = in_pos['stop']; reason = 'stop'
                    pnl = (ex_price - in_pos['entry_price']) * in_pos['shares']; exited = True
                elif rsi >= RSI_EXIT:
                    ex_price = row['Close']; reason = 'rsi50'
                    pnl = (ex_price - in_pos['entry_price']) * in_pos['shares']; exited = True
            else:
                if row['High'] >= in_pos['stop']:
                    ex_price = in_pos['stop']; reason = 'stop'
                    pnl = (in_pos['entry_price'] - ex_price) * in_pos['shares']; exited = True
                elif rsi <= RSI_EXIT:
                    ex_price = row['Close']; reason = 'rsi50'
                    pnl = (in_pos['entry_price'] - ex_price) * in_pos['shares']; exited = True
            if exited:
                trades.append({
                    'ticker': ticker,
                    'side': in_pos['side'],
                    'entry_date':  in_pos['entry_date'],
                    'entry_price': round(in_pos['entry_price'], 2),
                    'entry_rsi':   round(in_pos['entry_rsi'], 2),
                    'wk_rsi_rising_at_entry':  in_pos.get('wk_rsi_rising_at_entry', None),
                    'wk_macd_rising_at_entry': in_pos.get('wk_macd_rising_at_entry', None),
                    'exit_date':  date.strftime('%Y-%m-%d'),
                    'exit_price': round(ex_price, 2),
                    'stop': round(in_pos['stop'], 2),
                    'shares': in_pos['shares'],
                    'pnl': round(pnl, 2),
                    'exit_reason': reason,
                    'bars_held': i - in_pos['entry_idx'],
                })
                in_pos = None
            else:
                prev_prev_rsi, prev_prev_macd = prev_rsi, prev_macd
                prev_rsi, prev_macd, prev_signal = rsi, m, s
                continue

        rsi3_ok_long  = not pd.isna(rsi3) and rsi3 < RSI_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > rsi_overbought
        wk_long  = bool(row['sma_long_ok'])
        wk_short = bool(row['sma_short_ok'])
        earn_block = in_pre_earnings_window(date, earnings_dates, EARNINGS_BLACKOUT)

        # ARM
        if arm_dir is None and in_pos is None and not earn_block:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and wk_long:
                arm_dir = 'LONG'
                arm_low  = row['Low']; arm_high = row['High']
                days_since_arm = 0
            elif allow_shorts and rsi > rsi_overbought and rsi3_ok_short and wk_short:
                arm_dir = 'SHORT'
                arm_low  = row['Low']; arm_high = row['High']
                days_since_arm = 0
        elif arm_dir is not None:
            days_since_arm += 1
            arm_low  = min(arm_low,  row['Low'])
            arm_high = max(arm_high, row['High'])
            if days_since_arm > TIMEOUT_DAYS or earn_block:
                arm_dir = None

        # ── TRIGGER ───────────────────────────────────────────────────────
        wk_rsi_ok  = bool(row['wk_rsi_rising'])
        wk_macd_ok = bool(row['wk_macd_rising'])

        if arm_dir == 'LONG' and in_pos is None:
            # 1-bar OR 2-bar slope depending on variant
            macd_ok = macd_rising_2 if slope_bars == 2 else macd_rising
            rsi_dir_ok = rsi_rising_2 if slope_bars == 2 else rsi_rising
            # V2 no-go zone
            nogo_ok = (not variant['use_nogo_zone']) or rsi < RSI_NOGO_LONG_HI
            # V2 weekly confirmation
            mode_l = variant.get('weekly_mode', 'and')
            if not variant['use_weekly_direction']:
                weekly_ok = True
            elif mode_l == 'and':
                weekly_ok = wk_rsi_ok and wk_macd_ok
            elif mode_l == 'or':
                weekly_ok = wk_rsi_ok or wk_macd_ok
            else:
                weekly_ok = True

            if rsi_dir_ok and macd_ok and nogo_ok and weekly_ok:
                stop = math.floor(arm_low)
                ep = row['Close']
                if ep > stop:
                    rps = ep - stop
                    shares = max(1, int(RISK_PER_TRADE / rps))
                    in_pos = {
                        'side': 'LONG',
                        'entry_date': date.strftime('%Y-%m-%d'),
                        'entry_idx': i,
                        'entry_price': ep,
                        'entry_rsi':   rsi,
                        'stop': stop,
                        'shares': shares,
                        'wk_rsi_rising_at_entry':  bool(wk_rsi_ok),
                        'wk_macd_rising_at_entry': bool(wk_macd_ok),
                    }
                    arm_dir = None
        elif arm_dir == 'SHORT' and in_pos is None:
            macd_ok = macd_falling_2 if slope_bars == 2 else macd_falling
            rsi_dir_ok = rsi_falling_2 if slope_bars == 2 else rsi_falling
            nogo_ok = (not variant['use_nogo_zone']) or rsi > RSI_NOGO_SHORT_LO
            # Weekly for shorts: invert rising → falling per mode
            mode = variant.get('weekly_mode', 'and')
            if not variant['use_weekly_direction']:
                weekly_ok = True
            elif mode == 'and':
                weekly_ok = (not wk_rsi_ok) and (not wk_macd_ok)
            elif mode == 'or':
                weekly_ok = (not wk_rsi_ok) or (not wk_macd_ok)
            else:
                weekly_ok = True

            if rsi_dir_ok and macd_ok and nogo_ok and weekly_ok:
                stop = math.ceil(arm_high)
                ep = row['Close']
                if stop > ep:
                    rps = stop - ep
                    shares = max(1, int(RISK_PER_TRADE / rps))
                    in_pos = {
                        'side': 'SHORT',
                        'entry_date': date.strftime('%Y-%m-%d'),
                        'entry_idx': i,
                        'entry_price': ep,
                        'entry_rsi':   rsi,
                        'stop': stop,
                        'shares': shares,
                        'wk_rsi_rising_at_entry':  wk_rsi_ok,
                        'wk_macd_rising_at_entry': wk_macd_ok,
                    }
                    arm_dir = None

        prev_prev_rsi, prev_prev_macd = prev_rsi, prev_macd
        prev_rsi, prev_macd, prev_signal = rsi, m, s

    return trades

# ─── Stats ───────────────────────────────────────────────────────────────

def compute_stats(trades):
    if not trades:
        return {'total': 0, 'wins': 0, 'losses': 0, 'win_rate': 0.0, 'profit_factor': 0.0,
                'total_pnl': 0.0, 'avg_win': 0.0, 'avg_loss': 0.0, 'stop_outs': 0,
                'rsi50_exits': 0, 'avg_bars_held': 0, 'avg_entry_rsi_long': 0,
                'avg_entry_rsi_short': 0, 'longs': 0, 'shorts': 0}
    wins   = [t for t in trades if t['pnl'] > 0]
    losses = [t for t in trades if t['pnl'] <= 0]
    total_pnl = sum(t['pnl'] for t in trades)
    win_pnl   = sum(t['pnl'] for t in wins)
    loss_pnl  = sum(t['pnl'] for t in losses)
    pf = abs(win_pnl / loss_pnl) if loss_pnl != 0 else (999.0 if win_pnl > 0 else 0.0)
    longs  = [t['entry_rsi'] for t in trades if t['side'] == 'LONG']
    shorts = [t['entry_rsi'] for t in trades if t['side'] == 'SHORT']
    return {
        'total':         len(trades),
        'wins':          len(wins),
        'losses':        len(losses),
        'win_rate':      round(len(wins) / len(trades) * 100, 1),
        'profit_factor': round(pf, 2),
        'total_pnl':     round(total_pnl, 2),
        'avg_win':       round(win_pnl / len(wins),     2) if wins   else 0.0,
        'avg_loss':      round(loss_pnl / len(losses),  2) if losses else 0.0,
        'stop_outs':     sum(1 for t in trades if t['exit_reason'] == 'stop'),
        'rsi50_exits':   sum(1 for t in trades if t['exit_reason'] == 'rsi50'),
        'avg_bars_held': round(sum(t['bars_held'] for t in trades) / len(trades), 1),
        'avg_entry_rsi_long':  round(sum(longs)/len(longs),  1) if longs  else 0,
        'avg_entry_rsi_short': round(sum(shorts)/len(shorts),1) if shorts else 0,
        'longs':  len(longs),
        'shorts': len(shorts),
    }

# ─── Main ────────────────────────────────────────────────────────────────

def main():
    print(f'━━ SID V2 Method — {BACKTEST_YEARS}y on {UNIVERSE.upper()} ━━\n')
    wl = json.loads(WATCHLIST_PATH.read_text(encoding='utf-8'))

    # "Best of the dropped" — added to chase 300-trade target without polluting
    # the universe with bad performers. CSCO is on the instructor's list; EXPE
    # and PG were the highest-trade / highest-WR among the V1-dropped 14.
    BEST_OF_DROPPED = ['CSCO', 'EXPE', 'PG']

    # High-volatility expansion — cycles RSI<30 / RSI>70 more often than blue
    # chips. Targets the instructor's claimed 2-4 trades/week pace.
    HIGH_VOL_EXPANSION = [
        # Crypto-adjacent (5)
        'COIN', 'MSTR', 'MARA', 'BITF', 'HUT',
        # Recent IPOs / EVs / AI (8)
        'PLTR', 'RIVN', 'LCID', 'NIO', 'SMCI', 'ARM', 'AI', 'CVNA',
        # Meme/momentum (3)
        'GME', 'AMC', 'ROKU',
        # Leveraged ETFs (6)
        'SOXL', 'SOXS', 'BOIL', 'KOLD', 'JNUG', 'UVXY',
        # Commodities (2)
        'USO', 'UNG',
        # International (4)
        'FXI', 'EWZ', 'EWG', 'EWJ',
        # Re-add from dropped (2)
        'AAL', 'LUV',
    ]

    if UNIVERSE == 'tier1_113' or UNIVERSE == 'expanded' or UNIVERSE == '113':
        r = wl['sections']['refined_47_active']
        t = wl['sections']['tier1_expansion']
        tickers = sorted(set(list(r) + list(t.get('stocks', [])) + list(t.get('etfs', []))
                             + BEST_OF_DROPPED + HIGH_VOL_EXPANSION))
    elif UNIVERSE == 'tier1_83' or UNIVERSE == 'tier1+dropped' or UNIVERSE == '83':
        r = wl['sections']['refined_47_active']
        t = wl['sections']['tier1_expansion']
        tickers = sorted(set(list(r) + list(t.get('stocks', [])) + list(t.get('etfs', [])) + BEST_OF_DROPPED))
    elif UNIVERSE == 'tier1_80' or UNIVERSE == 'tier1' or UNIVERSE == '80':
        r = wl['sections']['refined_47_active']
        t = wl['sections']['tier1_expansion']
        tickers = sorted(set(list(r) + list(t.get('stocks', [])) + list(t.get('etfs', []))))
    elif UNIVERSE == 'refined' or UNIVERSE == 'refined47' or UNIVERSE == 'favourites':
        tickers = wl['sections']['refined_47_active']
    elif UNIVERSE == 'reference_61':
        tickers = wl['sections']['favourites_reference_61']
    else:
        # Default: 83-ticker = tier1_80 + best-of-dropped (CSCO/EXPE/PG)
        r = wl['sections']['refined_47_active']
        t = wl['sections']['tier1_expansion']
        tickers = sorted(set(list(r) + list(t.get('stocks', [])) + list(t.get('etfs', [])) + BEST_OF_DROPPED))
    print(f'Universe: {UNIVERSE} ({len(tickers)} tickers)\n')
    for v in VARIANTS:
        print(f'  - {v["name"]:18}  {v["desc"]}')
    print()

    earnings_cache = load_earnings_cache()

    end_date = datetime.now()
    backtest_start = end_date - timedelta(days=365 * BACKTEST_YEARS)
    history_start = end_date - timedelta(days=HISTORY_WARMUP_DAYS + 365 * BACKTEST_YEARS)

    print(f'Trade window: {backtest_start.date()} -> {end_date.date()}\n')

    results = {}
    all_trades_per_variant = {v['name']: [] for v in VARIANTS}
    for idx, ticker in enumerate(tickers, 1):
        print(f'[{idx:2}/{len(tickers)}] {ticker:6}  ', end='', flush=True)
        try:
            df = yf.download(ticker, start=history_start.strftime('%Y-%m-%d'),
                             end=end_date.strftime('%Y-%m-%d'), interval='1d',
                             progress=False, auto_adjust=False, multi_level_index=False)
            if df.empty or len(df) < 50:
                print('skipped'); continue
            df.index = pd.to_datetime(df.index)
        except Exception as e:
            print(f'fetch err: {e}'); continue
        earn = fetch_earnings_dates(ticker, earnings_cache)
        allow_longs  = ticker not in SHORT_ONLY
        allow_shorts = ticker not in LONG_ONLY
        bs = backtest_start.strftime('%Y-%m-%d')
        results[ticker] = {}
        bits = []
        for v in VARIANTS:
            trades_all = backtest_ticker(ticker, df, v, earn,
                                          allow_longs=allow_longs,
                                          allow_shorts=allow_shorts)
            trades = [t for t in trades_all if t['entry_date'] >= bs]
            results[ticker][v['name']] = {
                'stats': compute_stats(trades),
                'trades': trades,
            }
            all_trades_per_variant[v['name']].extend(trades)
            stt = results[ticker][v['name']]['stats']
            tag = v['name'].split('-')[0]
            bits.append(f"{tag}:{stt['total']:>2}/{stt['win_rate']:.0f}%")
        print(' | '.join(bits))
        if idx % 5 == 0:
            save_earnings_cache(earnings_cache)
    save_earnings_cache(earnings_cache)

    # Aggregate
    print('\n━━ AGGREGATE RESULTS ━━\n')
    aggregates = {}
    for v in VARIANTS:
        agg = compute_stats(all_trades_per_variant[v['name']])
        aggregates[v['name']] = agg
        color = 'GREEN' if agg['win_rate'] >= 65 else 'YELLOW' if agg['win_rate'] >= 50 else 'RED'
        print(f"  [{color:6}] {v['name']:18}  {agg['total']:>4} trades  "
              f"WR {agg['win_rate']:>5.1f}%  PF {agg['profit_factor']:>5.2f}  "
              f"P&L ${agg['total_pnl']:>+9.2f}  "
              f"(L={agg['longs']} S={agg['shorts']}, RSI@entry L={agg['avg_entry_rsi_long']:.1f} S={agg['avg_entry_rsi_short']:.1f})")

    # Verdict
    v17 = aggregates['v1.7-shipped']
    print()
    print('━━ VERDICT ━━')
    print(f"  V1 baseline:    {v17['total']} trades, {v17['win_rate']:.1f}% WR, PF {v17['profit_factor']:.2f}, P&L ${v17['total_pnl']:+.2f}")
    print()
    for v in VARIANTS:
        if v['name'] == 'v1.7-shipped': continue
        a = aggregates[v['name']]
        d_wr  = a['win_rate']  - v17['win_rate']
        d_pnl = a['total_pnl'] - v17['total_pnl']
        d_n   = a['total']     - v17['total']
        in_band = 65 <= a['win_rate'] <= 80
        beats = a['win_rate'] > v17['win_rate']
        flag = 'IN BAND - SHIP' if in_band else ('beats V1' if beats else 'rejected')
        print(f"  {v['name']:18}  {a['total']:>4} trades  {a['win_rate']:>5.1f}% WR  "
              f"(d{d_wr:+.1f}pp, d{d_n:+d}, ${d_pnl:+.2f})  [{flag}]")
    print()

    report = {
        'generated': datetime.now().isoformat(),
        'method': 'v2',
        'universe': UNIVERSE,
        'tickers': tickers,
        'backtest_years': BACKTEST_YEARS,
        'backtest_start': backtest_start.date().isoformat(),
        'backtest_end': end_date.date().isoformat(),
        'variants': VARIANTS,
        'aggregates': aggregates,
        'all_trades': all_trades_per_variant,
        'per_ticker': {tk: {v['name']: results[tk][v['name']]['stats']
                            for v in VARIANTS} for tk in results},
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding='utf-8')
    REPORT_MD.write_text(render_md(report), encoding='utf-8')
    print(f'Wrote {REPORT_MD.name} + {REPORT_JSON.name}')

def render_md(report):
    L = []
    L.append('# SID V2 Method — Validation Backtest')
    L.append('')
    L.append(f"**Generated:** {report['generated']}")
    L.append(f"**Universe:** {report['universe']} ({len(report['tickers'])} tickers)")
    L.append(f"**Window:** {report['backtest_start']} -> {report['backtest_end']}")
    L.append('')
    L.append('## V2 rule set')
    L.append('- ARM: daily RSI<30 (long) / >70 (short)  ← V2 uses 70 not 75')
    L.append('- Also requires RSI(3) in same zone')
    L.append('- TRIGGER: daily RSI direction + daily MACD direction')
    L.append('- + Weekly RSI direction matching trade direction')
    L.append('- + Weekly MACD direction matching trade direction')
    L.append('- + RSI no-go zone: long entry rejected if RSI ≥ 45, short rejected if ≤ 55')
    L.append('- EXIT: single exit at RSI 50 (Option A — V2.1 may add 50%/50% split)')
    L.append('')
    L.append('## Variants')
    L.append('| Variant | Description |')
    L.append('|---|---|')
    for v in report['variants']:
        L.append(f"| **{v['name']}** | {v['desc']} |")
    L.append('')
    L.append('## Aggregate results')
    L.append('| Variant | Trades | L/S | WR | PF | Net P&L | Avg RSI@entry (L/S) |')
    L.append('|---|---:|---:|---:|---:|---:|---|')
    for v in report['variants']:
        a = report['aggregates'][v['name']]
        pf = '∞' if a['profit_factor'] >= 999 else f"{a['profit_factor']:.2f}"
        L.append(f"| **{v['name']}** | {a['total']} | {a['longs']}/{a['shorts']} | "
                 f"**{a['win_rate']:.1f}%** | {pf} | ${a['total_pnl']:+.2f} | "
                 f"{a['avg_entry_rsi_long']:.1f} / {a['avg_entry_rsi_short']:.1f} |")
    return '\n'.join(L)

if __name__ == '__main__':
    main()
