"""
export-all-trades.py — generate every v1.5/v1.6 trade across the
expanded 80-ticker universe (refined 47 + tier1_expansion 32 +
all_monitor) over a 5-year window. Adds VIX-at-entry + VIX gate flag
for v1.7 evaluation.

Output: SID/all-trades.csv with one row per trade. Columns include
the proposed v1.7 VIX gate so the workbook can show both filtered
and unfiltered samples.

Rules match bot-sid.js v1.6+ (PPI filter OFF here for volume):
  - RSI(14) <30 / >75 to arm
  - RSI(3) rebound-zone confirmation
  - Weekly 50/200 SMA trend filter
  - 3-day sticky arm window
  - RSI + MACD direction-align at trigger
  - 14-day pre-earnings blackout (yfinance dates)
  - RSI(14) = 50 take profit, single full exit
  - $200 risk per trade ($10K account at 2%)

NEW v1.7 candidate filter (recorded per-trade, NOT applied):
  - vix_at_entry: VIX closing value on entry day
  - vix_gate: "pass" if VIX < 30 (would trade), "block" if VIX >= 30
"""

import yfinance as yf
import pandas as pd
import json, math, sys, io, csv
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Strategy params (v1.5 / v1.6 baseline, PPI OFF for volume)
RSI_PERIOD = 14
RSI_OVERSOLD = 30
RSI_OVERBOUGHT = 75
RSI_EXIT = 50
RSI3_PERIOD = 3
WEEKLY_FAST_SMA = 50
WEEKLY_SLOW_SMA = 200
TIMEOUT_DAYS = 3
RISK_PER_TRADE = 200.0
EARNINGS_BLACKOUT = 14
BACKTEST_YEARS = 5
HISTORY_WARMUP_DAYS = 365 * 5 + 30
ACCOUNT_SIZE = 10000.0

LONG_ONLY = {'XLC','QQQ','AMD','INTC','SPY','CAT','MSFT','TQQQ','XLK','GOLD','GS','IBM','JPM','XLB','XLE'}

WATCHLIST_PATH = Path(__file__).parent.parent / 'watchlist-sid.json'
EARNINGS_CACHE = Path(__file__).parent.parent / '.earnings-cache.json'
OUT_CSV = Path(__file__).parent.parent / 'all-trades.csv'

# v1.7 VIX gate parameters
VIX_THRESHOLD = 30.0

def wilder_rsi(closes, period=14):
    delta = closes.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)

def macd_line(closes, fast=12, slow=26):
    return closes.ewm(span=fast, adjust=False).mean() - closes.ewm(span=slow, adjust=False).mean()

def load_earnings_cache():
    if EARNINGS_CACHE.exists():
        try:
            return json.loads(EARNINGS_CACHE.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {}

def save_earnings_cache(c):
    EARNINGS_CACHE.write_text(json.dumps(c, indent=2, default=str), encoding='utf-8')

def fetch_earnings(ticker, cache):
    if ticker in cache:
        return cache[ticker]
    try:
        df = yf.Ticker(ticker).earnings_dates
        dates = sorted({d.date().isoformat() for d in df.index}) if df is not None and not df.empty else []
    except Exception:
        dates = []
    cache[ticker] = dates
    return dates

def in_pre_earnings(date, earnings_dates, days):
    check = date.date()
    for ed_str in earnings_dates:
        try:
            ed = datetime.fromisoformat(ed_str).date()
        except Exception:
            continue
        delta = (ed - check).days
        if 0 <= delta <= days:
            return True
    return False

def vix_at(date, vix_df):
    """Return VIX close on the most recent trading day <= date, or None."""
    try:
        d = pd.to_datetime(date)
        slc = vix_df[vix_df.index <= d].tail(1)
        if slc.empty:
            return None
        return float(slc['Close'].iloc[-1])
    except Exception:
        return None

def backtest_one(ticker, df, earnings_dates, allow_longs, allow_shorts):
    df = df.copy()
    df['RSI'] = wilder_rsi(df['Close'], RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], RSI3_PERIOD)
    df['MACD'] = macd_line(df['Close'])

    weekly = df['Close'].resample('W-FRI').last().dropna()
    if len(weekly) >= 200:
        wfast = weekly.rolling(50).mean()
        wslow = weekly.rolling(200).mean()
        sma_long = (wfast > wslow).reindex(df.index, method='ffill').fillna(False)
        sma_short = (wfast < wslow).reindex(df.index, method='ffill').fillna(False)
    else:
        sma_long = pd.Series(True, index=df.index)
        sma_short = pd.Series(True, index=df.index)

    trades = []
    arm_dir = None; arm_low = None; arm_high = None
    arm_signal_date = None; arm_rsi_signal = None
    days_since_arm = 0
    in_pos = None
    prev_rsi = prev_macd = None

    for i, (date, row) in enumerate(df.iterrows()):
        rsi, m = row['RSI'], row['MACD']
        rsi3 = row['RSI3']
        if pd.isna(rsi) or pd.isna(m) or prev_rsi is None or prev_macd is None:
            prev_rsi, prev_macd = rsi, m
            continue

        rsi_up = rsi > prev_rsi
        rsi_dn = rsi < prev_rsi
        macd_up = m > prev_macd
        macd_dn = m < prev_macd

        # EXIT
        if in_pos is not None:
            exited = False
            if in_pos['side'] == 'LONG':
                if row['Low'] <= in_pos['stop']:
                    ex_price = in_pos['stop']; reason = 'stop'
                    pnl = (ex_price - in_pos['entry_price']) * in_pos['shares']
                    pnl_pct = (ex_price - in_pos['entry_price']) / in_pos['entry_price'] * 100
                    exited = True
                elif rsi >= RSI_EXIT:
                    ex_price = row['Close']; reason = 'rsi50'
                    pnl = (ex_price - in_pos['entry_price']) * in_pos['shares']
                    pnl_pct = (ex_price - in_pos['entry_price']) / in_pos['entry_price'] * 100
                    exited = True
            else:
                if row['High'] >= in_pos['stop']:
                    ex_price = in_pos['stop']; reason = 'stop'
                    pnl = (in_pos['entry_price'] - ex_price) * in_pos['shares']
                    pnl_pct = (in_pos['entry_price'] - ex_price) / in_pos['entry_price'] * 100
                    exited = True
                elif rsi <= RSI_EXIT:
                    ex_price = row['Close']; reason = 'rsi50'
                    pnl = (in_pos['entry_price'] - ex_price) * in_pos['shares']
                    pnl_pct = (in_pos['entry_price'] - ex_price) / in_pos['entry_price'] * 100
                    exited = True
            if exited:
                trades.append({
                    'ticker': ticker,
                    'side': in_pos['side'],
                    'signal_date': in_pos['signal_date'],
                    'entry_date': in_pos['entry_date'],
                    'entry_price': round(in_pos['entry_price'], 4),
                    'stop_loss': round(in_pos['stop'], 2),
                    'shares': in_pos['shares'],
                    'position_value': round(in_pos['entry_price'] * in_pos['shares'], 2),
                    'risk_usd': round(abs(in_pos['entry_price'] - in_pos['stop']) * in_pos['shares'], 2),
                    'exit_date': date.strftime('%Y-%m-%d'),
                    'exit_price': round(ex_price, 4),
                    'exit_reason': reason,
                    'pnl': round(pnl, 2),
                    'pnl_pct': round(pnl_pct, 2),
                    'bars_held': i - in_pos['entry_idx'],
                    'rsi_at_signal': round(in_pos['rsi_at_signal'], 2),
                    'rsi_at_entry': round(in_pos['rsi_at_entry'], 2),
                })
                in_pos = None
            else:
                prev_rsi, prev_macd = rsi, m
                continue

        rsi3_ok_long = not pd.isna(rsi3) and rsi3 < RSI_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > RSI_OVERBOUGHT
        wk_long = bool(sma_long.iloc[i])
        wk_short = bool(sma_short.iloc[i])
        earn_block = in_pre_earnings(date, earnings_dates, EARNINGS_BLACKOUT)

        # ARM
        if arm_dir is None and in_pos is None and not earn_block:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and wk_long:
                arm_dir = 'LONG'
                arm_low = row['Low']; arm_high = row['High']
                arm_signal_date = date.strftime('%Y-%m-%d')
                arm_rsi_signal = rsi
                days_since_arm = 0
            elif allow_shorts and rsi > RSI_OVERBOUGHT and rsi3_ok_short and wk_short:
                arm_dir = 'SHORT'
                arm_low = row['Low']; arm_high = row['High']
                arm_signal_date = date.strftime('%Y-%m-%d')
                arm_rsi_signal = rsi
                days_since_arm = 0
        elif arm_dir is not None:
            days_since_arm += 1
            arm_low = min(arm_low, row['Low'])
            arm_high = max(arm_high, row['High'])
            if days_since_arm > TIMEOUT_DAYS or earn_block:
                arm_dir = None

        # ENTRY
        if arm_dir == 'LONG' and rsi_up and macd_up and in_pos is None:
            stop = math.floor(arm_low)
            ep = row['Close']
            if ep > stop:
                rps = ep - stop
                shares = max(1, int(RISK_PER_TRADE / rps))
                in_pos = {
                    'side': 'LONG', 'signal_date': arm_signal_date,
                    'entry_date': date.strftime('%Y-%m-%d'),
                    'entry_idx': i, 'entry_price': ep, 'stop': stop,
                    'shares': shares, 'rsi_at_signal': arm_rsi_signal,
                    'rsi_at_entry': rsi,
                }
                arm_dir = None
        elif arm_dir == 'SHORT' and rsi_dn and macd_dn and in_pos is None:
            stop = math.ceil(arm_high)
            ep = row['Close']
            if stop > ep:
                rps = stop - ep
                shares = max(1, int(RISK_PER_TRADE / rps))
                in_pos = {
                    'side': 'SHORT', 'signal_date': arm_signal_date,
                    'entry_date': date.strftime('%Y-%m-%d'),
                    'entry_idx': i, 'entry_price': ep, 'stop': stop,
                    'shares': shares, 'rsi_at_signal': arm_rsi_signal,
                    'rsi_at_entry': rsi,
                }
                arm_dir = None

        prev_rsi, prev_macd = rsi, m

    return trades

def main():
    wl = json.loads(WATCHLIST_PATH.read_text(encoding='utf-8'))
    # New universe: active tickers (refined + tier1_expansion) + community favourites + all_monitor
    # so the backtest covers EVERY ticker we've considered.
    active = wl.get('tickers', [])
    favs = wl['sections'].get('favourites_reference_61') or wl['sections'].get('favourites', [])
    all_section = wl['sections'].get('all_monitor_only') or wl['sections'].get('all', [])
    universe = sorted(set(active) | set(favs) | set(all_section))
    print(f'Universe: {len(universe)} tickers (active + favs + all_monitor)')

    # Fetch VIX history once — used per-trade to record vix_at_entry + gate flag
    end = datetime.now()
    bstart = end - timedelta(days=365 * BACKTEST_YEARS)
    hstart = end - timedelta(days=HISTORY_WARMUP_DAYS + 365 * BACKTEST_YEARS)
    print(f'Window: {bstart.date()} -> {end.date()}\n')
    print(f'Fetching VIX history...')
    vix_df = yf.download('^VIX', start=hstart.strftime('%Y-%m-%d'),
                         end=end.strftime('%Y-%m-%d'), interval='1d',
                         progress=False, auto_adjust=False, multi_level_index=False)
    vix_df.index = pd.to_datetime(vix_df.index)
    print(f'  VIX bars: {len(vix_df)}\n')

    cache = load_earnings_cache()
    all_trades = []

    for i, ticker in enumerate(universe, 1):
        print(f'[{i:2}/{len(universe)}] {ticker:6}  ', end='', flush=True)
        try:
            df = yf.download(ticker, start=hstart.strftime('%Y-%m-%d'),
                             end=end.strftime('%Y-%m-%d'), interval='1d',
                             progress=False, auto_adjust=False, multi_level_index=False)
            if df.empty or len(df) < 100:
                print(f'skipped ({len(df)} bars)')
                continue
            df.index = pd.to_datetime(df.index)
        except Exception as e:
            print(f'fetch err: {e}')
            continue
        earn = fetch_earnings(ticker, cache)
        allow_l = True
        allow_s = ticker not in LONG_ONLY
        trades = backtest_one(ticker, df, earn, allow_l, allow_s)
        bs = bstart.strftime('%Y-%m-%d')
        trades = [t for t in trades if t['entry_date'] >= bs]
        all_trades.extend(trades)
        wins = sum(1 for t in trades if t['pnl'] > 0)
        print(f'{len(trades):>2} trades ({wins} wins)')
        if i % 5 == 0:
            save_earnings_cache(cache)
    save_earnings_cache(cache)

    all_trades.sort(key=lambda t: t['entry_date'])
    for idx, t in enumerate(all_trades, 1):
        t['trade_no'] = idx
        # v1.7 VIX annotation — record VIX on entry day + gate flag
        vix_val = vix_at(t['entry_date'], vix_df)
        t['vix_at_entry'] = round(vix_val, 2) if vix_val is not None else ''
        if vix_val is None:
            t['vix_gate'] = 'unknown'
        else:
            t['vix_gate'] = 'block' if vix_val >= VIX_THRESHOLD else 'pass'

    # Write CSV
    cols = ['trade_no','ticker','side','signal_date','entry_date','entry_price',
            'stop_loss','shares','position_value','risk_usd','exit_date','exit_price',
            'exit_reason','pnl','pnl_pct','bars_held','rsi_at_signal','rsi_at_entry',
            'vix_at_entry','vix_gate']
    with open(OUT_CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for t in all_trades:
            w.writerow({c: t[c] for c in cols})

    # Summary stats
    wins = sum(1 for t in all_trades if t['pnl'] > 0)
    losses = sum(1 for t in all_trades if t['pnl'] <= 0)
    total_pnl = sum(t['pnl'] for t in all_trades)

    passed = [t for t in all_trades if t['vix_gate'] == 'pass']
    pwins = sum(1 for t in passed if t['pnl'] > 0)
    ppnl = sum(t['pnl'] for t in passed)
    blocked = [t for t in all_trades if t['vix_gate'] == 'block']
    bpnl = sum(t['pnl'] for t in blocked)

    print(f'\n━━ TOTALS (raw, all trades) ━━')
    print(f'  Trades: {len(all_trades)}')
    print(f'  Wins: {wins} ({wins/len(all_trades)*100:.1f}%)')
    print(f'  Losses: {losses}')
    print(f'  Net P&L: ${total_pnl:+.2f}')

    print(f'\n━━ TOTALS (v1.7 VIX >= 30 filtered) ━━')
    print(f'  Passed (VIX < 30): {len(passed)} trades')
    print(f'  Win rate: {pwins/len(passed)*100:.1f}%' if passed else '  Win rate: n/a')
    print(f'  Net P&L: ${ppnl:+.2f}')
    print(f'  Blocked (VIX >= 30): {len(blocked)} trades, ${bpnl:+.2f} P&L removed')

    print(f'\nWrote {OUT_CSV.name}')

if __name__ == '__main__':
    main()
