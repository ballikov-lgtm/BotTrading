"""
backtest-sid.py — Local backtest harness for SID Strategy v1.2

Simulates the instructor-aligned SID strategy across all watchlist tickers
over the past 12 months. Records every trade. Outputs per-ticker stats and
recommends a blacklist of stocks where the strategy underperforms.

v1.2 rules implemented (instructor's method):
  1. Arm:   daily RSI(14) drops below 30 (LONG) or rises above 70 (SHORT)
            Trade is STICKY — RSI does not need to stay in extreme zone
  2. Entry: on a later daily bar (within 3 trading days), enter when daily
            RSI direction AND daily MACD direction both align with trade
  3. Stop:  lowest low (LONG) / highest high (SHORT) between signal and entry,
            rounded DOWN / UP to whole dollar
  4. Exit:  daily RSI reaches 50, OR stop is hit
  5. Timeout: 3 trading days from arm to entry, else cancel

Earnings filter is NOT applied in this backtest (no reliable historical
earnings calendar data) — keeps it pure-strategy.

Usage:
  cd SID
  python backtest-sid.py
  → writes backtest-report.md and backtest-report.json
"""

import yfinance as yf
import pandas as pd
import numpy as np
import json
import math
import sys
import io
from datetime import datetime, timedelta
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Strategy params (v1.2 + 3-day RSI confirmation filter)
RSI_PERIOD         = 14
RSI_OVERSOLD       = 30
RSI_OVERBOUGHT     = 75
RSI_EXIT           = 50
RSI3_PERIOD        = 3           # short-term RSI for rebound-zone confirmation
RSI3_OVERSOLD      = 30          # 3-day RSI must also be oversold to confirm long signal
RSI3_OVERBOUGHT    = 75          # 3-day RSI must also be overbought to confirm short signal
USE_RSI3_FILTER    = True        # toggle for the new confirmation filter

WEEKLY_FAST_SMA    = 50          # weekly SMA periods for trend filter
WEEKLY_SLOW_SMA    = 200
USE_WEEKLY_TREND_FILTER = True   # only allow longs in weekly uptrend, shorts in weekly downtrend
MACD_FAST          = 12
MACD_SLOW          = 26
MACD_SIGNAL        = 9
TIMEOUT_DAYS       = 3
RISK_PER_TRADE     = 200.0       # 2% of $10,000 account

# Files
WATCHLIST_PATH = Path(__file__).parent / 'watchlist-sid.json'
REPORT_MD      = Path(__file__).parent / 'backtest-report.md'
REPORT_JSON    = Path(__file__).parent / 'backtest-report.json'

# Per-ticker direction restrictions
# Tickers in LONG_ONLY: shorts disabled (typically bullish trend assets that lose on shorts)
# Tickers in SHORT_ONLY: longs disabled (typically inverse ETFs or persistently bearish)
# Anything not listed: both directions enabled (default)
LONG_ONLY  = {'XLC', 'QQQ', 'AMD', 'INTC', 'SPY', 'CAT', 'MSFT', 'TQQQ', 'XLK', 'GOLD', 'GS', 'IBM', 'JPM', 'XLB', 'XLE'}
SHORT_ONLY = set()  # could include: 'TZA', 'XLY', 'SQQQ', 'HD', 'TGT' — not applied this run

# ─── Indicators ────────────────────────────────────────────────────────────

def wilder_rsi(closes: pd.Series, period: int = 14) -> pd.Series:
    """Wilder-smoothed RSI — matches TradingView's default RSI."""
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
    macd = ema_fast - ema_slow
    return macd

# ─── Strategy simulation ───────────────────────────────────────────────────

def backtest_ticker(ticker: str, df: pd.DataFrame, allow_longs=True, allow_shorts=True):
    """Walk through daily bars chronologically. Returns list of trade dicts."""
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], period=RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], period=RSI3_PERIOD)
    df['MACD'] = compute_macd(df['Close'])

    # Weekly trend filter — resample daily to weekly, compute 50/200 SMA, then
    # map weekly trend status back onto daily bars (forward-fill).
    if USE_WEEKLY_TREND_FILTER:
        weekly = df['Close'].resample('W-FRI').last().dropna()
        if len(weekly) >= WEEKLY_SLOW_SMA:
            w_sma_fast = weekly.rolling(WEEKLY_FAST_SMA).mean()
            w_sma_slow = weekly.rolling(WEEKLY_SLOW_SMA).mean()
            weekly_uptrend   = w_sma_fast > w_sma_slow
            weekly_downtrend = w_sma_fast < w_sma_slow
            df['weekly_uptrend']   = weekly_uptrend.reindex(df.index, method='ffill').fillna(False)
            df['weekly_downtrend'] = weekly_downtrend.reindex(df.index, method='ffill').fillna(False)
        else:
            # Not enough history for 200-week SMA — disable the filter for this ticker
            df['weekly_uptrend']   = True
            df['weekly_downtrend'] = True
    else:
        df['weekly_uptrend']   = True
        df['weekly_downtrend'] = True

    trades = []
    arm_dir            = None
    arm_signal_low     = None
    arm_signal_high    = None
    days_since_arm     = 0
    in_position        = None  # None or dict with 'side', 'entry_idx', 'entry_price', 'stop', 'shares', 'entry_date'

    prev_rsi  = None
    prev_macd = None

    for i, (date, row) in enumerate(df.iterrows()):
        rsi  = row['RSI']
        macd = row['MACD']

        if pd.isna(rsi) or pd.isna(macd) or prev_rsi is None or prev_macd is None:
            prev_rsi, prev_macd = rsi, macd
            continue

        rsi_rising  = rsi > prev_rsi
        rsi_falling = rsi < prev_rsi
        macd_rising  = macd > prev_macd
        macd_falling = macd < prev_macd

        # ── EXIT first (handled intra-bar before any new signal) ────────────
        if in_position is not None:
            exited = False
            if in_position['side'] == 'LONG':
                # Stop hit (bar low crosses below stop)
                if row['Low'] <= in_position['stop']:
                    exit_price = in_position['stop']
                    reason = 'stop'
                    pnl = (exit_price - in_position['entry_price']) * in_position['shares']
                    pnl_pct = (exit_price - in_position['entry_price']) / in_position['entry_price'] * 100
                    exited = True
                # RSI 50 reached
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

        # ── ARM logic (only when no current arm or position) ────────────────
        # v1.3 filter: RSI(3) must also be in extreme zone (rebound-zone confirm)
        rsi3 = row['RSI3']
        rsi3_ok_long  = (not USE_RSI3_FILTER) or (not pd.isna(rsi3) and rsi3 < RSI3_OVERSOLD)
        rsi3_ok_short = (not USE_RSI3_FILTER) or (not pd.isna(rsi3) and rsi3 > RSI3_OVERBOUGHT)

        # v1.4 filter: weekly trend must align with trade direction
        weekly_long_ok  = (not USE_WEEKLY_TREND_FILTER) or bool(row['weekly_uptrend'])
        weekly_short_ok = (not USE_WEEKLY_TREND_FILTER) or bool(row['weekly_downtrend'])

        if arm_dir is None and in_position is None:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and weekly_long_ok:
                arm_dir         = 'LONG'
                arm_signal_low  = row['Low']
                arm_signal_high = row['High']
                days_since_arm  = 0
            elif allow_shorts and rsi > RSI_OVERBOUGHT and rsi3_ok_short and weekly_short_ok:
                arm_dir         = 'SHORT'
                arm_signal_low  = row['Low']
                arm_signal_high = row['High']
                days_since_arm  = 0
        elif arm_dir is not None:
            # While armed, track extremes + increment day counter
            days_since_arm   += 1
            arm_signal_low    = min(arm_signal_low,  row['Low'])
            arm_signal_high   = max(arm_signal_high, row['High'])

        # ── Invalidate on timeout ───────────────────────────────────────────
        if arm_dir is not None and days_since_arm >= TIMEOUT_DAYS:
            arm_dir = None; arm_signal_low = None; arm_signal_high = None; days_since_arm = 0

        # ── ENTRY logic ─────────────────────────────────────────────────────
        if arm_dir == 'LONG' and rsi_rising and macd_rising and in_position is None:
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
        elif arm_dir == 'SHORT' and rsi_falling and macd_falling and in_position is None:
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

def compute_stats(trades, label):
    if not trades:
        return {
            'label': label, 'total': 0, 'wins': 0, 'losses': 0, 'win_rate': 0.0,
            'profit_factor': 0.0, 'total_pnl': 0.0, 'avg_win': 0.0, 'avg_loss': 0.0,
            'stop_outs': 0, 'rsi50_exits': 0, 'avg_bars_held': 0,
        }
    wins   = [t for t in trades if t['pnl'] > 0]
    losses = [t for t in trades if t['pnl'] <= 0]
    total_pnl = sum(t['pnl'] for t in trades)
    win_pnl  = sum(t['pnl'] for t in wins)
    loss_pnl = sum(t['pnl'] for t in losses)
    pf = abs(win_pnl / loss_pnl) if loss_pnl != 0 else (float('inf') if win_pnl > 0 else 0.0)
    return {
        'label'         : label,
        'total'         : len(trades),
        'wins'          : len(wins),
        'losses'        : len(losses),
        'win_rate'      : round(len(wins) / len(trades) * 100, 1),
        'profit_factor' : round(pf, 2) if pf != float('inf') else 999.0,
        'total_pnl'     : round(total_pnl, 2),
        'avg_win'       : round(win_pnl / len(wins),     2) if wins   else 0.0,
        'avg_loss'      : round(loss_pnl / len(losses),  2) if losses else 0.0,
        'stop_outs'     : sum(1 for t in trades if t['exit_reason'] == 'stop'),
        'rsi50_exits'   : sum(1 for t in trades if t['exit_reason'] == 'rsi50'),
        'avg_bars_held' : round(sum(t['bars_held'] for t in trades) / len(trades), 1),
    }

# ─── Main ─────────────────────────────────────────────────────────────────

def main():
    print('━━ SID v1.2 Backtest — 12-month window ━━\n')

    with open(WATCHLIST_PATH) as f:
        watchlist = json.load(f)

    end_date         = datetime.now()
    backtest_start   = end_date - timedelta(days=365)         # 12-month trading window
    history_start    = end_date - timedelta(days=365 * 5 + 30) # ~5 years for weekly 200-SMA warmup
    start_date       = history_start
    print(f'Range: {start_date.date()} → {end_date.date()} (trades counted from {backtest_start.date()})')
    print(f'Watchlist: {len(watchlist["tickers"])} tickers\n')

    results = []
    skipped = []

    for ticker in watchlist['tickers']:
        try:
            df = yf.download(ticker,
                             start=start_date.strftime('%Y-%m-%d'),
                             end=end_date.strftime('%Y-%m-%d'),
                             interval='1d', progress=False,
                             auto_adjust=False, multi_level_index=False)
            if df.empty or len(df) < 50:
                skipped.append({'ticker': ticker, 'reason': f'insufficient data ({len(df)} bars)'})
                print(f'  {ticker:6}  skipped (insufficient data)')
                continue

            df.index = pd.to_datetime(df.index)
            allow_longs  = ticker not in SHORT_ONLY
            allow_shorts = ticker not in LONG_ONLY
            all_trades = backtest_ticker(ticker, df, allow_longs=allow_longs, allow_shorts=allow_shorts)
            # Only count trades whose ENTRY date is within the 12-month window
            backtest_start_str = backtest_start.strftime('%Y-%m-%d')
            trades = [t for t in all_trades if t['entry_date'] >= backtest_start_str]

            longs  = [t for t in trades if t['side'] == 'LONG']
            shorts = [t for t in trades if t['side'] == 'SHORT']

            row = {
                'ticker' : ticker,
                'all'    : compute_stats(trades, 'all'),
                'longs'  : compute_stats(longs,  'longs'),
                'shorts' : compute_stats(shorts, 'shorts'),
            }
            results.append(row)

            a = row['all']
            print(f'  {ticker:6}  {a["total"]:>3} trades  {a["win_rate"]:>5.1f}% WR  PF {a["profit_factor"]:>5.2f}  P&L ${a["total_pnl"]:>+8.2f}')
        except Exception as e:
            skipped.append({'ticker': ticker, 'reason': str(e)})
            print(f'  {ticker:6}  error: {e}')

    # Sort by win rate (with min trade threshold to deprioritize tiny samples)
    def sort_key(r):
        a = r['all']
        if a['total'] < 3:   # < 3 trades is statistically meaningless
            return (-1, a['win_rate'])
        return (0, a['win_rate'])
    results.sort(key=sort_key, reverse=True)

    # Build classification
    whitelist, watchlist_cat, blacklist = [], [], []
    for r in results:
        wr = r['all']['win_rate']; n = r['all']['total']; pf = r['all']['profit_factor']
        if n < 3:
            continue  # insufficient data
        if wr >= 65 and pf >= 1.5:
            whitelist.append(r['ticker'])
        elif wr >= 50:
            watchlist_cat.append(r['ticker'])
        else:
            blacklist.append(r['ticker'])

    report = {
        'generated'         : datetime.now().isoformat(),
        'strategy_version'  : '1.2',
        'risk_per_trade_usd': RISK_PER_TRADE,
        'lookback_days'     : 365,
        'start_date'        : start_date.date().isoformat(),
        'end_date'          : end_date.date().isoformat(),
        'tickers_total'     : len(watchlist['tickers']),
        'tickers_scanned'   : len(results),
        'tickers_skipped'   : len(skipped),
        'skipped'           : skipped,
        'classification'    : {
            'whitelist': whitelist,   # WR >= 65% AND PF >= 1.5
            'monitor'  : watchlist_cat,  # WR >= 50%
            'blacklist': blacklist,   # WR < 50%
        },
        'results'           : results,
    }

    REPORT_JSON.write_text(json.dumps(report, indent=2), encoding='utf-8')
    REPORT_MD.write_text(render_markdown(report), encoding='utf-8')
    print(f'\n✓ Wrote {REPORT_JSON.name} + {REPORT_MD.name}')
    print(f'\nClassification:')
    print(f'  WHITELIST (WR ≥ 65% AND PF ≥ 1.5): {len(whitelist)} tickers — {", ".join(whitelist) or "none"}')
    print(f'  MONITOR   (WR ≥ 50%):              {len(watchlist_cat)} tickers — {", ".join(watchlist_cat) or "none"}')
    print(f'  BLACKLIST (WR < 50%):              {len(blacklist)} tickers — {", ".join(blacklist) or "none"}')

# ─── Markdown report ───────────────────────────────────────────────────────

def render_markdown(report: dict) -> str:
    lines = []
    lines.append(f"# SID Strategy v{report['strategy_version']} — 12-Month Backtest Report")
    lines.append('')
    lines.append(f"**Generated:** {report['generated']}")
    lines.append(f"**Backtest range:** {report['start_date']} → {report['end_date']}")
    lines.append(f"**Risk per trade:** ${report['risk_per_trade_usd']:.0f}")
    lines.append(f"**Tickers scanned:** {report['tickers_scanned']} / {report['tickers_total']}")
    lines.append('')

    c = report['classification']
    lines.append('## Recommended classification')
    lines.append('')
    lines.append(f"| Class | Criteria | Count | Tickers |")
    lines.append(f"|---|---|---|---|")
    lines.append(f"| 🟢 **Whitelist** | Win rate ≥ 65% AND Profit factor ≥ 1.5 | {len(c['whitelist'])} | {', '.join(c['whitelist']) or '—'} |")
    lines.append(f"| 🟡 **Monitor**   | Win rate ≥ 50% | {len(c['monitor'])} | {', '.join(c['monitor']) or '—'} |")
    lines.append(f"| 🔴 **Blacklist** | Win rate < 50% | {len(c['blacklist'])} | {', '.join(c['blacklist']) or '—'} |")
    lines.append('')

    # Per-ticker table (sorted by win rate desc)
    lines.append('## Per-ticker results (sorted by win rate)')
    lines.append('')
    lines.append('| Ticker | Total | Wins | WR | Profit Factor | Net P&L | Longs WR | Shorts WR | Avg Win | Avg Loss | Stop Outs | RSI50 Exits |')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for r in report['results']:
        a, l, s = r['all'], r['longs'], r['shorts']
        if a['total'] == 0:
            lines.append(f"| {r['ticker']} | 0 | — | — | — | — | — | — | — | — | — | — |")
            continue
        wr_l = f"{l['win_rate']:.0f}% ({l['total']})" if l['total'] else '—'
        wr_s = f"{s['win_rate']:.0f}% ({s['total']})" if s['total'] else '—'
        pf = '∞' if a['profit_factor'] >= 999 else f"{a['profit_factor']:.2f}"
        lines.append(f"| **{r['ticker']}** | {a['total']} | {a['wins']} | **{a['win_rate']:.1f}%** | {pf} | ${a['total_pnl']:+.2f} | {wr_l} | {wr_s} | ${a['avg_win']:.2f} | ${a['avg_loss']:.2f} | {a['stop_outs']} | {a['rsi50_exits']} |")
    lines.append('')

    lines.append('## How to read this')
    lines.append('')
    lines.append('- **Win rate (WR)** = wins / total trades. Instructor target: 70%+. Whitelist threshold: 65%.')
    lines.append('- **Profit factor (PF)** = total winning P&L / total losing P&L. PF > 1 means profitable. PF ≥ 1.5 is good.')
    lines.append('- **Longs WR / Shorts WR** = win rate broken down by direction. A bullish stock often shows high longs WR + poor shorts WR. Consider disabling shorts on those (future v1.3 feature).')
    lines.append('- **Stop Outs** vs **RSI50 Exits** = how trades ended. RSI50 exits = full mean-reversion completed. Stop outs = trade failed.')
    lines.append('')
    lines.append('## Caveats')
    lines.append('')
    lines.append('- Earnings filter is NOT applied in this backtest (no reliable historical earnings calendar in yfinance).')
    lines.append('- 15-min intraday entry confirmation (the v1.1 optional tweak) is NOT applied — this is the pure instructor method.')
    lines.append('- All trades use $50 risk-per-trade for apples-to-apples comparison; position sizes vary by stop distance.')
    lines.append('- Hard 3-day timeout on armed signals.')
    lines.append('- Backtest is on adjusted-close daily bars from Yahoo Finance.')
    lines.append('')

    if report['skipped']:
        lines.append('## Skipped tickers')
        lines.append('')
        for s in report['skipped']:
            lines.append(f"- **{s['ticker']}**: {s['reason']}")
        lines.append('')

    return '\n'.join(lines)

if __name__ == '__main__':
    main()
