"""
pick-sample-trades.py — extract 6 representative v1.5 trades (3 wins + 3 losses)
from the same 5-year backtest data, then save to sample-trades.json so the
TradingView MCP can plot them.

Picks deliberately diverse trades:
  - 1 long winner, 1 long loser
  - 1 short winner, 1 short loser
  - 1 RSI-50 exit (target hit)
  - 1 stop-out
"""
import yfinance as yf
import pandas as pd
import json
import math
import sys
import io
from datetime import datetime, timedelta
from pathlib import Path
import random

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Re-import the v1.5 backtest logic from v1.6 harness
sys.path.insert(0, str(Path(__file__).parent))
from importlib import import_module
v16 = import_module('backtest-sid-v1-6'.replace('-', '_')) if False else None  # placeholder

# Inline the v1.5 logic to avoid import gymnastics
RSI_PERIOD = 14
RSI_OVERSOLD = 30
RSI_OVERBOUGHT = 75   # v1.5 (not 70 like v1.6 — we want v1.5 trades)
RSI_EXIT = 50
RSI3_PERIOD = 3
WEEKLY_FAST_SMA = 50
WEEKLY_SLOW_SMA = 200
TIMEOUT_DAYS = 3
RISK_PER_TRADE = 200.0
EARNINGS_BLACKOUT = 14

LONG_ONLY = {'XLC','QQQ','AMD','INTC','SPY','CAT','MSFT','TQQQ','XLK','GOLD','GS','IBM','JPM','XLB','XLE'}

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

def load_earnings(ticker):
    cache_path = Path(__file__).parent / '.earnings-cache.json'
    if not cache_path.exists():
        return []
    cache = json.loads(cache_path.read_text(encoding='utf-8'))
    return cache.get(ticker, [])

def is_in_pre_earnings(date, earnings_dates, days):
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

def backtest_v15(ticker, df):
    df = df.copy()
    df['RSI']  = wilder_rsi(df['Close'], RSI_PERIOD)
    df['RSI3'] = wilder_rsi(df['Close'], RSI3_PERIOD)
    df['MACD'] = macd_line(df['Close'])

    weekly = df['Close'].resample('W-FRI').last().dropna()
    if len(weekly) >= 200:
        w_fast = weekly.rolling(50).mean()
        w_slow = weekly.rolling(200).mean()
        sma_long_ok  = (w_fast > w_slow).reindex(df.index, method='ffill').fillna(False)
        sma_short_ok = (w_fast < w_slow).reindex(df.index, method='ffill').fillna(False)
    else:
        sma_long_ok  = pd.Series(True, index=df.index)
        sma_short_ok = pd.Series(True, index=df.index)
    df['sma_long_ok']  = sma_long_ok
    df['sma_short_ok'] = sma_short_ok

    earn = load_earnings(ticker)
    allow_longs  = True
    allow_shorts = ticker not in LONG_ONLY

    trades = []
    arm_dir = None; arm_low = None; arm_high = None; arm_signal_date = None
    days_since_arm = 0
    in_pos = None
    prev_rsi = prev_macd = None

    for i, (date, row) in enumerate(df.iterrows()):
        rsi  = row['RSI']
        macd = row['MACD']
        if pd.isna(rsi) or pd.isna(macd) or prev_rsi is None or prev_macd is None:
            prev_rsi, prev_macd = rsi, macd
            continue

        rsi_rising = rsi > prev_rsi
        rsi_falling = rsi < prev_rsi
        macd_rising = macd > prev_macd
        macd_falling = macd < prev_macd

        # EXIT
        if in_pos is not None:
            exited = False
            if in_pos['side'] == 'LONG':
                if row['Low'] <= in_pos['stop']:
                    ex_price = in_pos['stop']; reason = 'stop'
                    pnl = (ex_price - in_pos['entry_price']) * in_pos['shares']
                    exited = True
                elif rsi >= RSI_EXIT:
                    ex_price = row['Close']; reason = 'rsi50'
                    pnl = (ex_price - in_pos['entry_price']) * in_pos['shares']
                    exited = True
            else:
                if row['High'] >= in_pos['stop']:
                    ex_price = in_pos['stop']; reason = 'stop'
                    pnl = (in_pos['entry_price'] - ex_price) * in_pos['shares']
                    exited = True
                elif rsi <= RSI_EXIT:
                    ex_price = row['Close']; reason = 'rsi50'
                    pnl = (in_pos['entry_price'] - ex_price) * in_pos['shares']
                    exited = True
            if exited:
                trades.append({
                    'ticker': ticker,
                    'side': in_pos['side'],
                    'signal_date': in_pos['signal_date'],
                    'entry_date': in_pos['entry_date'],
                    'entry_price': round(in_pos['entry_price'], 2),
                    'exit_date': date.strftime('%Y-%m-%d'),
                    'exit_price': round(ex_price, 2),
                    'stop': round(in_pos['stop'], 2),
                    'shares': in_pos['shares'],
                    'pnl': round(pnl, 2),
                    'exit_reason': reason,
                    'bars_held': i - in_pos['entry_idx'],
                    'rsi_at_signal': in_pos['rsi_at_signal'],
                    'rsi_at_entry': in_pos['rsi_at_entry'],
                })
                in_pos = None
            else:
                prev_rsi, prev_macd = rsi, macd
                continue

        rsi3 = row['RSI3']
        rsi3_ok_long  = not pd.isna(rsi3) and rsi3 < RSI_OVERSOLD
        rsi3_ok_short = not pd.isna(rsi3) and rsi3 > RSI_OVERBOUGHT
        wk_long = bool(row['sma_long_ok'])
        wk_short = bool(row['sma_short_ok'])
        earn_block = is_in_pre_earnings(date, earn, EARNINGS_BLACKOUT)

        # ARM
        if arm_dir is None and in_pos is None and not earn_block:
            if allow_longs and rsi < RSI_OVERSOLD and rsi3_ok_long and wk_long:
                arm_dir = 'LONG'
                arm_low = row['Low']; arm_high = row['High']
                arm_signal_date = date.strftime('%Y-%m-%d')
                arm_rsi_at_signal = round(rsi, 2)
                days_since_arm = 0
            elif allow_shorts and rsi > RSI_OVERBOUGHT and rsi3_ok_short and wk_short:
                arm_dir = 'SHORT'
                arm_low = row['Low']; arm_high = row['High']
                arm_signal_date = date.strftime('%Y-%m-%d')
                arm_rsi_at_signal = round(rsi, 2)
                days_since_arm = 0
        elif arm_dir is not None:
            days_since_arm += 1
            arm_low  = min(arm_low,  row['Low'])
            arm_high = max(arm_high, row['High'])
            if days_since_arm > TIMEOUT_DAYS or earn_block:
                arm_dir = None

        # ENTRY
        if arm_dir == 'LONG' and rsi_rising and macd_rising and in_pos is None:
            stop = math.floor(arm_low)
            ep = row['Close']
            if ep > stop:
                rps = ep - stop
                shares = max(1, int(RISK_PER_TRADE / rps))
                in_pos = {
                    'side': 'LONG',
                    'signal_date': arm_signal_date,
                    'entry_date': date.strftime('%Y-%m-%d'),
                    'entry_idx': i,
                    'entry_price': ep,
                    'stop': stop,
                    'shares': shares,
                    'rsi_at_signal': arm_rsi_at_signal,
                    'rsi_at_entry': round(rsi, 2),
                }
                arm_dir = None
        elif arm_dir == 'SHORT' and rsi_falling and macd_falling and in_pos is None:
            stop = math.ceil(arm_high)
            ep = row['Close']
            if stop > ep:
                rps = stop - ep
                shares = max(1, int(RISK_PER_TRADE / rps))
                in_pos = {
                    'side': 'SHORT',
                    'signal_date': arm_signal_date,
                    'entry_date': date.strftime('%Y-%m-%d'),
                    'entry_idx': i,
                    'entry_price': ep,
                    'stop': stop,
                    'shares': shares,
                    'rsi_at_signal': arm_rsi_at_signal,
                    'rsi_at_entry': round(rsi, 2),
                }
                arm_dir = None

        prev_rsi, prev_macd = rsi, macd
    return trades

# ─── Main ────────────────────────────────────────────────────────────────
random.seed(42)
SAMPLE_TICKERS = ['AAPL', 'AMD', 'BA', 'DIS', 'JPM', 'META', 'TSLA',
                  'XLF', 'XLE', 'GS', 'INTC', 'GDX', 'F', 'WMT', 'CAT', 'IBM']

end_date = datetime.now()
start_date = end_date - timedelta(days=365 * 6)  # 6y for warmup + 5y window
backtest_start = end_date - timedelta(days=365 * 5)

print(f'Backtesting {len(SAMPLE_TICKERS)} candidate tickers for sample trades...')
all_trades = []
for ticker in SAMPLE_TICKERS:
    try:
        df = yf.download(ticker, start=start_date.strftime('%Y-%m-%d'),
                         end=end_date.strftime('%Y-%m-%d'), interval='1d',
                         progress=False, auto_adjust=False, multi_level_index=False)
        if df.empty or len(df) < 100:
            continue
        df.index = pd.to_datetime(df.index)
        trades = backtest_v15(ticker, df)
        bs = backtest_start.strftime('%Y-%m-%d')
        trades = [t for t in trades if t['entry_date'] >= bs]
        all_trades.extend(trades)
        print(f'  {ticker:6}  {len(trades):2} trades  (wins {sum(1 for t in trades if t["pnl"] > 0)})')
    except Exception as e:
        print(f'  {ticker:6}  error: {e}')

print(f'\nTotal trades available: {len(all_trades)}')
wins   = [t for t in all_trades if t['pnl'] > 0]
losses = [t for t in all_trades if t['pnl'] <= 0]
print(f'  Wins: {len(wins)}, Losses: {len(losses)}')

# Pick diverse sample: aim for 3 wins + 3 losses, mix sides + exit reasons
def pick_diverse(pool, n, label):
    # Mix sides; if pool small just take random
    longs  = [t for t in pool if t['side'] == 'LONG']
    shorts = [t for t in pool if t['side'] == 'SHORT']
    random.shuffle(longs)
    random.shuffle(shorts)
    if longs and shorts:
        picks = longs[:n//2 + (n%2)] + shorts[:n//2]
    else:
        picks = pool[:n]
    return picks[:n]

sample_wins   = pick_diverse(wins,   3, 'wins')
sample_losses = pick_diverse(losses, 3, 'losses')
sample = sample_wins + sample_losses

print(f'\n=== 6 SAMPLE TRADES (3 wins + 3 losses) ===')
for i, t in enumerate(sample, 1):
    outcome = 'WIN' if t['pnl'] > 0 else 'LOSS'
    print(f'  {i}. {t["ticker"]:5} {t["side"]:5} {outcome:4} '
          f'signal {t["signal_date"]} -> entry {t["entry_date"]} -> exit {t["exit_date"]} '
          f'({t["exit_reason"]:5}) PNL ${t["pnl"]:+7.2f}')

out = Path(__file__).parent / 'sample-trades.json'
out.write_text(json.dumps(sample, indent=2, default=str), encoding='utf-8')
print(f'\nWrote {out.name}')
