"""
backtest-sid-v1.7.py — MACD cross + RSI entry cap + PPI filter validation

Proposed v1.7 changes over v1.5:

  1. MACD CROSS instead of MACD direction
     v1.5: macd_line[t] > macd_line[t-1] (just pointing up)
     v1.7: macd_line[t] > signal_line[t] AND macd_line[t-1] <= signal_line[t-1]
           — a TRUE cross. Stronger, rarer.

  2. RSI entry cap
     v1.5: no cap on entry-day RSI value
     v1.7: long entry only if rsi < 40 (cap), short entry only if rsi > 60
           — keeps the reward window wide enough for viable RR.

  3. PPI macro blackout (was prepared but not tested)
     v1.7+PPI: adds the 14-day pre-PPI window to the existing earnings filter.

Variants:
  v1.5-shipped       : baseline (already known)
  v1.5-plus-PPI      : v1.5 + PPI blackout only
  v1.7-cross-cap     : MACD cross + RSI 40 cap (no PPI)
  v1.7-full          : v1.7-cross-cap + PPI blackout

Usage:
  cd SID
  python backtest-sid-v1.7.py
"""

import yfinance as yf
import pandas as pd
import numpy as np
import json, math, sys, io, os
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Strategy params
RSI_PERIOD         = 14
RSI_OVERSOLD       = 30
RSI_OVERBOUGHT     = 75
RSI_ENTRY_CAP_LONG  = 40   # v1.7 (revised): cap=35 was too tight (only 6 trades), back to 40
RSI_ENTRY_CAP_SHORT = 60   # mirror — don't enter short if RSI < 60 (symmetric 10pt from threshold)
RSI_EXIT           = 50
RSI3_PERIOD        = 3
WEEKLY_FAST_SMA    = 50
WEEKLY_SLOW_SMA    = 200
MACD_FAST          = 12
MACD_SLOW          = 26
MACD_SIGNAL        = 9
TIMEOUT_DAYS       = 3
RISK_PER_TRADE     = 200.0
EARNINGS_BLACKOUT  = 14
MACRO_BLACKOUT     = 14
BACKTEST_YEARS     = int(os.environ.get('SID_BACKTEST_YEARS', '5'))
HISTORY_WARMUP_DAYS = 365 * 5 + 30
UNIVERSE           = os.environ.get('SID_UNIVERSE', 'favourites').lower()

LONG_ONLY  = {'XLC','QQQ','AMD','INTC','SPY','CAT','MSFT','TQQQ','XLK','GOLD','GS','IBM','JPM','XLB','XLE'}
SHORT_ONLY = set()

WATCHLIST_PATH = Path(__file__).parent / 'watchlist-sid.json'
EVENT_DATES    = Path(__file__).parent / 'event-dates.json'
REPORT_MD      = Path(__file__).parent / 'backtest-v1.7-validation-report.md'
REPORT_JSON    = Path(__file__).parent / 'backtest-v1.7-validation-report.json'
EARNINGS_CACHE = Path(__file__).parent / '.earnings-cache.json'

VARIANTS = [
    {
        'name': 'v1.5-shipped',
        'desc': 'v1.5 baseline (earnings only, no PPI/macro)',
        'trigger_mode':     'macd_direction',
        'rsi_entry_cap':    False,
        'use_macro_filter': False,
        'use_ppi_filter':   False,
    },
    {
        'name': 'v1.5+PPI',
        'desc': '*** v1.5 + 14-day pre-PPI blackout ***',
        'trigger_mode':     'macd_direction',
        'rsi_entry_cap':    False,
        'use_macro_filter': False,
        'use_ppi_filter':   True,
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
    """Returns (macd_line, signal_line) Series — both as pandas Series."""
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

def in_pre_event_window(check_date, event_dates, days):
    check = check_date.date()
    for ed in event_dates:
        delta = (ed - check).days
        if 0 <= delta <= days:
            return True
    return False

# ─── Earnings cache ──────────────────────────────────────────────────────

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

# ─── Strategy simulation ─────────────────────────────────────────────────

def backtest_ticker(ticker, df, variant, earnings_dates, fomc_dates, cpi_dates, ppi_dates,
                    allow_longs=True, allow_shorts=True):
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], RSI3_PERIOD)
    macd, signal_line = compute_macd_and_signal(df['Close'])
    df['MACD']        = macd
    df['MACD_SIGNAL'] = signal_line

    # Weekly SMA filter
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

    trades = []
    arm_dir = None; arm_low = None; arm_high = None; days_since_arm = 0
    in_pos = None
    prev_rsi  = None
    prev_macd = None
    prev_signal = None

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
                    'entry_date': in_pos['entry_date'],
                    'entry_price': round(in_pos['entry_price'], 2),
                    'entry_rsi':  round(in_pos['entry_rsi'], 2),
                    'exit_date': date.strftime('%Y-%m-%d'),
                    'exit_price': round(ex_price, 2),
                    'stop': round(in_pos['stop'], 2),
                    'shares': in_pos['shares'],
                    'pnl': round(pnl, 2),
                    'exit_reason': reason,
                    'bars_held': i - in_pos['entry_idx'],
                })
                in_pos = None
            else:
                prev_rsi, prev_macd, prev_signal = rsi, m, s
                continue

        rsi3_ok_long  = not pd.isna(rsi3) and rsi3 < RSI_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > RSI_OVERBOUGHT
        wk_long  = bool(row['sma_long_ok'])
        wk_short = bool(row['sma_short_ok'])

        earn_block  = in_pre_earnings_window(date, earnings_dates, EARNINGS_BLACKOUT)
        macro_block = variant['use_macro_filter'] and (
            in_pre_event_window(date, fomc_dates, MACRO_BLACKOUT) or
            in_pre_event_window(date, cpi_dates,  MACRO_BLACKOUT)
        )
        ppi_block   = variant['use_ppi_filter'] and in_pre_event_window(date, ppi_dates, MACRO_BLACKOUT)
        any_block   = earn_block or macro_block or ppi_block

        # ARM
        if arm_dir is None and in_pos is None and not any_block:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and wk_long:
                arm_dir = 'LONG'
                arm_low  = row['Low']; arm_high = row['High']
                days_since_arm = 0
            elif allow_shorts and rsi > RSI_OVERBOUGHT and rsi3_ok_short and wk_short:
                arm_dir = 'SHORT'
                arm_low  = row['Low']; arm_high = row['High']
                days_since_arm = 0
        elif arm_dir is not None:
            days_since_arm += 1
            arm_low  = min(arm_low,  row['Low'])
            arm_high = max(arm_high, row['High'])
            if days_since_arm > TIMEOUT_DAYS or any_block:
                arm_dir = None

        # ── TRIGGER ───────────────────────────────────────────────────────
        if arm_dir == 'LONG' and in_pos is None:
            # Direction or cross?
            macd_ok = macd_cross_up if variant['trigger_mode'] == 'macd_cross' else macd_rising
            # RSI cap?
            rsi_cap_ok = (not variant['rsi_entry_cap']) or rsi < RSI_ENTRY_CAP_LONG
            if rsi_rising and macd_ok and rsi_cap_ok:
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
                    }
                    arm_dir = None
        elif arm_dir == 'SHORT' and in_pos is None:
            macd_ok = macd_cross_down if variant['trigger_mode'] == 'macd_cross' else macd_falling
            rsi_cap_ok = (not variant['rsi_entry_cap']) or rsi > RSI_ENTRY_CAP_SHORT
            if rsi_falling and macd_ok and rsi_cap_ok:
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
                    }
                    arm_dir = None

        prev_rsi, prev_macd, prev_signal = rsi, m, s

    return trades

# ─── Stats ───────────────────────────────────────────────────────────────

def compute_stats(trades):
    if not trades:
        return {'total': 0, 'wins': 0, 'losses': 0, 'win_rate': 0.0, 'profit_factor': 0.0,
                'total_pnl': 0.0, 'avg_win': 0.0, 'avg_loss': 0.0, 'stop_outs': 0,
                'rsi50_exits': 0, 'avg_bars_held': 0, 'avg_entry_rsi_long': 0,
                'avg_entry_rsi_short': 0}
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
    }

# ─── Main ────────────────────────────────────────────────────────────────

def main():
    print(f'━━ SID v1.7 Validation — {BACKTEST_YEARS}y on {UNIVERSE.upper()} ━━\n')
    wl = json.loads(WATCHLIST_PATH.read_text(encoding='utf-8'))

    # Three universes for the "PPI + watchlist curation" test:
    OLD_50 = ['DIA','IWM','QQQ','SPY','AAPL','AMD','AMZN','BA','BAC','CAT',
              'COST','DIS','DKS','ETSY','FCX','FDX','GM','GOLD','GOOG','GS',
              'HD','IBM','INTC','JPM','MA','META','MCD','MSFT','PYPL','QYLD',
              'SLV','SQQQ','TGT','TNA','TQQQ','TSLA','TZA','VZ','WMT',
              'XLB','XLC','XLE','XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY']
    # REFINED 47 = FAVOURITES 61 minus 14 underperformers (12 drops + 2 marginals
    # AAL, COIN, CSCO, EXPE, HUM, HUT, KO, LUV, LVS, NEM, PG, ROKU, SLB, SMH)
    REFINED_47 = ['AAPL','AMD','AMZN','B','BA','CAT','COST','DIA','DIS','F',
                  'GDX','GOOG','GS','HD','IBM','INTC','IWM','JPM','KHC','MCD',
                  'META','NUGT','PYPL','QQQ','RIOT','SLV','SPY','SQQQ','TGT',
                  'TNA','TQQQ','TSLA','TZA','V','WFC','WMT','XHB','XLC','XLE',
                  'XLF','XLI','XLK','XLP','XLRE','XLU','XLV','XLY']

    if UNIVERSE == 'favourites':
        tickers = wl['sections']['favourites']
    elif UNIVERSE == 'all':
        tickers = wl['sections']['all']
    elif UNIVERSE == 'old50':
        tickers = OLD_50
    elif UNIVERSE == 'refined' or UNIVERSE == 'refined47':
        tickers = REFINED_47
    else:
        tickers = wl['sections']['favourites']
    print(f'Universe: {UNIVERSE} ({len(tickers)} tickers)\n')
    for v in VARIANTS:
        print(f'  - {v["name"]:18}  {v["desc"]}')
    print()

    events = load_event_dates()
    earnings_cache = load_earnings_cache()

    end_date = datetime.now()
    backtest_start = end_date - timedelta(days=365 * BACKTEST_YEARS)
    history_start = end_date - timedelta(days=HISTORY_WARMUP_DAYS + 365 * BACKTEST_YEARS)

    print(f'Trade window: {backtest_start.date()} -> {end_date.date()}\n')

    results = {}
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
                                          events['fomc'], events['cpi'], events['ppi'],
                                          allow_longs=allow_longs, allow_shorts=allow_shorts)
            trades = [t for t in trades_all if t['entry_date'] >= bs]
            results[ticker][v['name']] = {
                'stats': compute_stats(trades),
                'trades': trades,
            }
            s = results[ticker][v['name']]['stats']
            tag = v['name'].split('-')[0]
            bits.append(f"{tag}:{s['total']:>2}/{s['win_rate']:.0f}%")
        print(' | '.join(bits))
        if idx % 5 == 0:
            save_earnings_cache(earnings_cache)
    save_earnings_cache(earnings_cache)

    # Aggregate
    print('\n━━ AGGREGATE RESULTS ━━\n')
    aggregates = {}
    for v in VARIANTS:
        all_trades = []
        for ticker in results:
            all_trades.extend(results[ticker][v['name']]['trades'])
        agg = compute_stats(all_trades)
        aggregates[v['name']] = agg
        color = 'GREEN' if agg['win_rate'] >= 65 else 'YELLOW' if agg['win_rate'] >= 50 else 'RED'
        print(f"  [{color:6}] {v['name']:18}  {agg['total']:>4} trades  "
              f"WR {agg['win_rate']:>5.1f}%  PF {agg['profit_factor']:>5.2f}  "
              f"P&L ${agg['total_pnl']:>+9.2f}  "
              f"(avg RSI@entry: L={agg['avg_entry_rsi_long']:.1f} S={agg['avg_entry_rsi_short']:.1f})")

    # Verdict
    v15 = aggregates['v1.5-shipped']
    print()
    print('━━ VERDICT ━━')
    print(f"  v1.5 baseline:  {v15['total']} trades, {v15['win_rate']:.1f}% WR, PF {v15['profit_factor']:.2f}, P&L ${v15['total_pnl']:+.2f}")
    print()
    best_name = 'v1.5-shipped'; best_wr = v15['win_rate']
    for v in VARIANTS:
        if v['name'] == 'v1.5-shipped': continue
        a = aggregates[v['name']]
        d_wr  = a['win_rate']  - v15['win_rate']
        d_pnl = a['total_pnl'] - v15['total_pnl']
        d_n   = a['total']     - v15['total']
        in_band = 65 <= a['win_rate'] <= 85
        beats = a['win_rate'] > v15['win_rate'] and a['total_pnl'] > v15['total_pnl']
        flag = 'IN BAND - SHIP' if in_band else ('beats v1.5' if beats else 'rejected')
        if a['win_rate'] > best_wr:
            best_wr = a['win_rate']; best_name = v['name']
        print(f"  {v['name']:18}  {a['total']:>4} trades  {a['win_rate']:>5.1f}% WR  "
              f"(d{d_wr:+.1f}pp, d{d_n:+d}, ${d_pnl:+.2f})  [{flag}]")
    print()
    print(f"  Best variant: {best_name} at {best_wr:.1f}% WR")

    report = {
        'generated': datetime.now().isoformat(),
        'universe': UNIVERSE,
        'tickers': tickers,
        'backtest_years': BACKTEST_YEARS,
        'backtest_start': backtest_start.date().isoformat(),
        'backtest_end': end_date.date().isoformat(),
        'variants': VARIANTS,
        'aggregates': aggregates,
        'per_ticker': {tk: {v['name']: results[tk][v['name']]['stats']
                            for v in VARIANTS} for tk in results},
    }
    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding='utf-8')
    REPORT_MD.write_text(render_md(report), encoding='utf-8')
    print(f'\nWrote {REPORT_MD.name} + {REPORT_JSON.name}')

def render_md(report):
    L = []
    L.append('# SID v1.7 — MACD Cross + RSI Cap + PPI Validation')
    L.append('')
    L.append(f"**Generated:** {report['generated']}")
    L.append(f"**Universe:** {report['universe']} ({len(report['tickers'])} tickers)")
    L.append(f"**Window:** {report['backtest_start']} -> {report['backtest_end']}")
    L.append('')
    L.append('## Variants')
    L.append('| Variant | Description |')
    L.append('|---|---|')
    for v in report['variants']:
        L.append(f"| **{v['name']}** | {v['desc']} |")
    L.append('')
    L.append('## Aggregate results')
    L.append('| Variant | Trades | WR | PF | Net P&L | Avg RSI@entry (L/S) |')
    L.append('|---|---:|---:|---:|---:|---|')
    for v in report['variants']:
        a = report['aggregates'][v['name']]
        pf = '∞' if a['profit_factor'] >= 999 else f"{a['profit_factor']:.2f}"
        L.append(f"| **{v['name']}** | {a['total']} | **{a['win_rate']:.1f}%** | {pf} | ${a['total_pnl']:+.2f} | {a['avg_entry_rsi_long']:.1f} / {a['avg_entry_rsi_short']:.1f} |")
    return '\n'.join(L)

if __name__ == '__main__':
    main()
