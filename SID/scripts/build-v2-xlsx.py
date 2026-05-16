"""
build-v2-xlsx.py — Build "SID V2 Method Back Testing.xlsx" from
backtest-v2-validation-report.json.

Sheets:
  1. All Trades (V2 method)        — every V2 trade with side / RSI / weekly direction flags
  2. Per-Ticker Summary            — per-ticker WR + P&L
  3. V1 vs V2 Comparison           — aggregate side-by-side
  4. Strategy Rules (V2)           — V2 method rule reference

Theme: matches V1 xlsx (dark navy headers) with cyan/magenta accents for the
LONG/SHORT side cells. Designed to drop into Trading Academy submission slot
or a personal report.
"""
import json
import sys
import io
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from datetime import datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

JSON_PATH = Path(__file__).parent.parent / 'backtest-v2-validation-report.json'
OUT_PATH  = Path(__file__).parent.parent / 'SID V2 Method Back Testing.xlsx'

if not JSON_PATH.exists():
    print(f'ERROR: {JSON_PATH} not found. Run backtest-sid-v2.py first.')
    sys.exit(1)

report = json.loads(JSON_PATH.read_text(encoding='utf-8'))

trades_by_variant = report['all_trades']
agg = report['aggregates']

# Headline V2 variant priority — the FIRST one with >=300 trades wins.
# v2-weekly-or wins by economic value ($88/trade vs $50/trade for v2-slope).
# v2-slope is the "cleaner alignment" alternative but cuts trade count by 66%.
V2_VARIANT_PRIORITY = ['v2-weekly-or', 'v2-slope', 'v2-method', 'v2-nogo-only']
headline_variant = None
for cand in V2_VARIANT_PRIORITY:
    if cand in trades_by_variant and len(trades_by_variant[cand]) >= 100:
        headline_variant = cand
        break
if headline_variant is None:
    non_v1 = {k: v for k, v in trades_by_variant.items() if k != 'v1.7-shipped'}
    if non_v1:
        headline_variant = max(non_v1, key=lambda k: len(non_v1[k]))
    else:
        headline_variant = 'v2-method'

v2_trades = trades_by_variant.get(headline_variant, [])
v1_trades = trades_by_variant.get('v1.7-shipped', [])
v2_agg_picked = agg.get(headline_variant, {})

print(f'Headline V2 variant: {headline_variant}  ({len(v2_trades)} trades)')
print(f'V1 baseline trades: {len(v1_trades)}')
for v_name in trades_by_variant:
    print(f'  {v_name}: {len(trades_by_variant[v_name])} trades')

# ─── Theme ──────────────────────────────────────────────────────────────
THEME = {
    'title_bg':       '1A365D',  # Dark navy
    'title_fg':       'FFFFFF',
    'header_bg':      '2C5282',  # Medium blue
    'header_fg':      'FFFFFF',
    'subheader_bg':   '4299E1',
    'subheader_fg':   'FFFFFF',
    'row_alt':        'EBF8FF',
    'row_white':      'FFFFFF',
    'win_bg':         'C6F6D5',
    'win_fg':         '22543D',
    'loss_bg':        'FED7D7',
    'loss_fg':        '742A2A',
    'subtotal_bg':    'FEF3C7',
    'subtotal_fg':    '744210',
    'border':         'CBD5E0',
    'long_bg':        'BEE3F8',
    'short_bg':       'FBB6CE',
    'cyan_bg':        'E6FFFA',  # V2 highlight
    'magenta_bg':     'FFE4F1',
}

THIN = Side(border_style='thin', color=THEME['border'])
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
ARIAL = 'Arial'

wb = Workbook()

# ============================================================================
# Sheet 1: All Trades (V2 method)
# ============================================================================
ws = wb.active
ws.title = 'All Trades (V2)'

# Title row
TITLE = f"SID V2 Method Back Testing — {report['backtest_years']}y, {len(report['tickers'])}-ticker universe"
ws.merge_cells('A1:R1')
ws['A1'] = TITLE
ws['A1'].font = Font(name=ARIAL, size=16, bold=True, color=THEME['title_fg'])
ws['A1'].fill = PatternFill('solid', fgColor=THEME['title_bg'])
ws['A1'].alignment = Alignment(horizontal='center', vertical='center')
ws.row_dimensions[1].height = 32

v2_agg = v2_agg_picked
v1_agg = agg['v1.7-shipped']
subtitle = (
    f"V2 method: {v2_agg['total']} trades  |  WR {v2_agg['win_rate']:.1f}%  |  "
    f"PF {v2_agg['profit_factor']:.2f}  |  Net P&L ${v2_agg['total_pnl']:+,.0f}  "
    f"|  L/S {v2_agg['longs']}/{v2_agg['shorts']}  "
    f"|  Window {report['backtest_start']} → {report['backtest_end']}  "
    f"|  Generated {datetime.now().strftime('%Y-%m-%d')}"
)
ws.merge_cells('A2:R2')
ws['A2'] = subtitle
ws['A2'].font = Font(name=ARIAL, size=11, color='2D3748', italic=True)
ws['A2'].fill = PatternFill('solid', fgColor='F7FAFC')
ws['A2'].alignment = Alignment(horizontal='center', vertical='center')
ws.row_dimensions[2].height = 22

# Header row
HEADER_ROW = 3
COLS = [
    ('Trade #',            'trade_no',        'int',     8),
    ('Ticker',             'ticker',          'text',    9),
    ('Side',               'side',            'side',    9),
    ('Entry Date',         'entry_date',      'date',    13),
    ('Entry Price ($)',    'entry_price',     'money',   14),
    ('RSI @ Entry',        'entry_rsi',       'rsi',     12),
    ('Wkly RSI rising',    'wk_rsi_rising_at_entry',  'flag', 13),
    ('Wkly MACD rising',   'wk_macd_rising_at_entry', 'flag', 13),
    ('Stop ($)',           'stop',            'money',   11),
    ('Shares',             'shares',          'int',     9),
    ('Risk ($)',           'risk_usd',        'money',   10),
    ('Exit Date',          'exit_date',       'date',    13),
    ('Exit Price ($)',     'exit_price',      'money',   13),
    ('Exit Reason',        'exit_reason',     'reason',  12),
    ('P&L ($)',            'pnl',             'pnl',     12),
    ('P&L (%)',            'pnl_pct',         'pct',     10),
    ('Bars Held',          'bars_held',       'int',     10),
    ('Outcome',            None,              'outcome', 11),
]

for col_idx, (label, _, _, width) in enumerate(COLS, 1):
    c = ws.cell(row=HEADER_ROW, column=col_idx, value=label)
    c.font = Font(name=ARIAL, size=11, bold=True, color=THEME['header_fg'])
    c.fill = PatternFill('solid', fgColor=THEME['header_bg'])
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    c.border = BORDER
    ws.column_dimensions[get_column_letter(col_idx)].width = width
ws.row_dimensions[HEADER_ROW].height = 34

# Sort trades by entry date
v2_sorted = sorted(v2_trades, key=lambda t: t['entry_date'])

DATA_START = HEADER_ROW + 1
for i, t in enumerate(v2_sorted):
    row = DATA_START + i
    is_win = float(t['pnl']) > 0
    side = t['side']
    # Derived fields
    risk_usd = (t['entry_price'] - t['stop']) * t['shares'] if side == 'LONG' else (t['stop'] - t['entry_price']) * t['shares']
    pnl_pct = (t['pnl'] / (t['entry_price'] * t['shares'])) * 100 if t['entry_price'] and t['shares'] else 0

    derived = {
        'trade_no': i + 1,
        'risk_usd': risk_usd,
        'pnl_pct':  pnl_pct,
    }

    for col_idx, (_, key, kind, _) in enumerate(COLS, 1):
        c = ws.cell(row=row, column=col_idx)
        # Pick value
        if key is None and kind == 'outcome':
            c.value = 'WIN' if is_win else 'LOSS'
        elif key in derived:
            val = derived[key]
            if kind == 'int':
                c.value = int(val); c.number_format = '0'
            elif kind == 'money':
                c.value = float(val); c.number_format = '$#,##0.00;[Red]-$#,##0.00'
            elif kind == 'pct':
                c.value = float(val) / 100; c.number_format = '0.00%;[Red]-0.00%'
            else:
                c.value = val
        elif kind == 'int':
            c.value = int(t.get(key) or 0); c.number_format = '0'
        elif kind == 'money':
            c.value = float(t.get(key) or 0); c.number_format = '$#,##0.00;[Red]-$#,##0.00'
        elif kind == 'pnl':
            c.value = float(t.get(key) or 0); c.number_format = '$#,##0.00;[Red]-$#,##0.00'
        elif kind == 'pct':
            c.value = float(t.get(key) or 0) / 100; c.number_format = '0.00%;[Red]-0.00%'
        elif kind == 'rsi':
            c.value = float(t.get(key) or 0); c.number_format = '0.0'
        elif kind == 'flag':
            v = t.get(key)
            c.value = 'YES' if v else 'NO' if v is False else '—'
        elif kind == 'date':
            c.value = t.get(key); c.number_format = '@'
        else:
            c.value = t.get(key)

        c.font = Font(name=ARIAL, size=10)
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = BORDER
        c.fill = PatternFill('solid', fgColor=(THEME['row_white'] if i % 2 == 0 else THEME['row_alt']))

        # Side cell colour
        if kind == 'side':
            if side == 'LONG':
                c.fill = PatternFill('solid', fgColor=THEME['long_bg'])
                c.font = Font(name=ARIAL, size=10, bold=True, color='2C5282')
            else:
                c.fill = PatternFill('solid', fgColor=THEME['short_bg'])
                c.font = Font(name=ARIAL, size=10, bold=True, color='9B2C2C')

        # Flag cells (YES = green, NO = grey)
        if kind == 'flag':
            v = t.get(key)
            if v is True:
                c.fill = PatternFill('solid', fgColor=THEME['win_bg'])
                c.font = Font(name=ARIAL, size=10, bold=True, color=THEME['win_fg'])
            elif v is False:
                c.fill = PatternFill('solid', fgColor='E2E8F0')
                c.font = Font(name=ARIAL, size=10, color='4A5568')

        # Outcome cell colour
        if kind == 'outcome':
            if is_win:
                c.fill = PatternFill('solid', fgColor=THEME['win_bg'])
                c.font = Font(name=ARIAL, size=10, bold=True, color=THEME['win_fg'])
            else:
                c.fill = PatternFill('solid', fgColor=THEME['loss_bg'])
                c.font = Font(name=ARIAL, size=10, bold=True, color=THEME['loss_fg'])

        # P&L cell colour
        if kind == 'pnl':
            if is_win:
                c.font = Font(name=ARIAL, size=10, bold=True, color='22543D')
            else:
                c.font = Font(name=ARIAL, size=10, bold=True, color='742A2A')

DATA_END = DATA_START + len(v2_sorted) - 1
ws.freeze_panes = 'D4'
if DATA_END >= DATA_START:
    ws.auto_filter.ref = f"A{HEADER_ROW}:R{DATA_END}"

# Subtotal row (filter-aware)
SUBTOTAL_ROW = max(DATA_END + 1, DATA_START)
def col_letter(idx): return get_column_letter(idx)
def add_subtotal(col_idx, fn, fmt=None, label=None):
    c = ws.cell(row=SUBTOTAL_ROW, column=col_idx)
    if label is not None:
        c.value = label
    else:
        rng = f"{col_letter(col_idx)}{DATA_START}:{col_letter(col_idx)}{DATA_END}"
        c.value = f"=SUBTOTAL({fn},{rng})"
    if fmt: c.number_format = fmt
    c.font = Font(name=ARIAL, size=11, bold=True, color=THEME['subtotal_fg'])
    c.fill = PatternFill('solid', fgColor=THEME['subtotal_bg'])
    c.alignment = Alignment(horizontal='center', vertical='center')
    c.border = BORDER
if DATA_END >= DATA_START:
    add_subtotal(1, 3, label='SUBTOTAL ▼')
    ws.cell(row=SUBTOTAL_ROW, column=2).value = f'=SUBTOTAL(3,B{DATA_START}:B{DATA_END})&" trades"'
    ws.cell(row=SUBTOTAL_ROW, column=2).font = Font(name=ARIAL, size=11, bold=True, color=THEME['subtotal_fg'])
    ws.cell(row=SUBTOTAL_ROW, column=2).fill = PatternFill('solid', fgColor=THEME['subtotal_bg'])
    ws.cell(row=SUBTOTAL_ROW, column=2).alignment = Alignment(horizontal='center', vertical='center')
    ws.cell(row=SUBTOTAL_ROW, column=2).border = BORDER
    for col in [3, 4]:
        add_subtotal(col, 3, label='')
    add_subtotal(5, 1, '$#,##0.00')
    add_subtotal(6, 1, '0.0')
    add_subtotal(7, 3, label='')
    add_subtotal(8, 3, label='')
    add_subtotal(9, 1, '$#,##0.00')
    add_subtotal(10, 9, '#,##0')
    add_subtotal(11, 9, '$#,##0.00')
    add_subtotal(12, 3, label='')
    add_subtotal(13, 1, '$#,##0.00')
    add_subtotal(14, 3, label='')
    add_subtotal(15, 9, '$#,##0.00;[Red]-$#,##0.00')
    add_subtotal(16, 1, '0.00%;[Red]-0.00%')
    add_subtotal(17, 1, '0.0')
    add_subtotal(18, 3, label='')

# ============================================================================
# Sheet 2: Per-Ticker Summary (V2)
# ============================================================================
ws2 = wb.create_sheet('Per-Ticker Summary')
ws2.merge_cells('A1:G1')
ws2['A1'] = 'V2 Method — Per-Ticker Performance'
ws2['A1'].font = Font(name=ARIAL, size=16, bold=True, color=THEME['title_fg'])
ws2['A1'].fill = PatternFill('solid', fgColor=THEME['title_bg'])
ws2['A1'].alignment = Alignment(horizontal='center', vertical='center')
ws2.row_dimensions[1].height = 32

by_ticker = {}
for t in v2_sorted:
    tk = t['ticker']
    by_ticker.setdefault(tk, []).append(t)

ticker_rows = []
for tk, ts in by_ticker.items():
    n = len(ts)
    w = sum(1 for t in ts if float(t['pnl']) > 0)
    pnl = sum(float(t['pnl']) for t in ts)
    avg_bars = sum(int(t['bars_held']) for t in ts) / n
    ticker_rows.append((tk, n, w, n - w, w / n * 100 if n else 0, pnl, avg_bars))
ticker_rows.sort(key=lambda r: -r[5])

T_HEADER_ROW = 3
T_HEADERS = [('Ticker',12),('Trades',10),('Wins',9),('Losses',10),('Win Rate (%)',14),('Net P&L ($)',14),('Avg Bars Held',14)]
for col_idx, (label, width) in enumerate(T_HEADERS, 1):
    c = ws2.cell(row=T_HEADER_ROW, column=col_idx, value=label)
    c.font = Font(name=ARIAL, size=11, bold=True, color=THEME['header_fg'])
    c.fill = PatternFill('solid', fgColor=THEME['header_bg'])
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    c.border = BORDER
    ws2.column_dimensions[get_column_letter(col_idx)].width = width
ws2.row_dimensions[T_HEADER_ROW].height = 32

T_DATA_START = T_HEADER_ROW + 1
for i, row in enumerate(ticker_rows):
    r = T_DATA_START + i
    tk, n, w, l, wr, pnl, avg_bars = row
    for col_idx, val in enumerate(row, 1):
        c = ws2.cell(row=r, column=col_idx, value=val)
        c.font = Font(name=ARIAL, size=10)
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = BORDER
        c.fill = PatternFill('solid', fgColor=(THEME['row_white'] if i % 2 == 0 else THEME['row_alt']))
    ws2.cell(row=r, column=2).number_format = '0'
    ws2.cell(row=r, column=3).number_format = '0'
    ws2.cell(row=r, column=4).number_format = '0'
    ws2.cell(row=r, column=5).number_format = '0.0'
    ws2.cell(row=r, column=6).number_format = '$#,##0.00;[Red]-$#,##0.00'
    ws2.cell(row=r, column=7).number_format = '0.0'

    c_pnl = ws2.cell(row=r, column=6)
    if pnl > 0:
        c_pnl.font = Font(name=ARIAL, size=10, bold=True, color='22543D')
    elif pnl < 0:
        c_pnl.font = Font(name=ARIAL, size=10, bold=True, color='742A2A')
    c_wr = ws2.cell(row=r, column=5)
    if wr >= 65:
        c_wr.fill = PatternFill('solid', fgColor=THEME['win_bg'])
        c_wr.font = Font(name=ARIAL, size=10, bold=True, color=THEME['win_fg'])
    elif wr < 40:
        c_wr.fill = PatternFill('solid', fgColor=THEME['loss_bg'])
        c_wr.font = Font(name=ARIAL, size=10, bold=True, color=THEME['loss_fg'])

if ticker_rows:
    T_TOTAL_ROW = T_DATA_START + len(ticker_rows)
    ws2.cell(row=T_TOTAL_ROW, column=1).value = 'TOTAL'
    ws2.cell(row=T_TOTAL_ROW, column=2).value = f'=SUM(B{T_DATA_START}:B{T_TOTAL_ROW-1})'
    ws2.cell(row=T_TOTAL_ROW, column=3).value = f'=SUM(C{T_DATA_START}:C{T_TOTAL_ROW-1})'
    ws2.cell(row=T_TOTAL_ROW, column=4).value = f'=SUM(D{T_DATA_START}:D{T_TOTAL_ROW-1})'
    ws2.cell(row=T_TOTAL_ROW, column=5).value = f'=C{T_TOTAL_ROW}/B{T_TOTAL_ROW}*100'
    ws2.cell(row=T_TOTAL_ROW, column=6).value = f'=SUM(F{T_DATA_START}:F{T_TOTAL_ROW-1})'
    ws2.cell(row=T_TOTAL_ROW, column=7).value = f'=AVERAGE(G{T_DATA_START}:G{T_TOTAL_ROW-1})'
    for col_idx in range(1, 8):
        c = ws2.cell(row=T_TOTAL_ROW, column=col_idx)
        c.font = Font(name=ARIAL, size=11, bold=True, color=THEME['subtotal_fg'])
        c.fill = PatternFill('solid', fgColor=THEME['subtotal_bg'])
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = BORDER
    ws2.cell(row=T_TOTAL_ROW, column=2).number_format = '0'
    ws2.cell(row=T_TOTAL_ROW, column=3).number_format = '0'
    ws2.cell(row=T_TOTAL_ROW, column=4).number_format = '0'
    ws2.cell(row=T_TOTAL_ROW, column=5).number_format = '0.0'
    ws2.cell(row=T_TOTAL_ROW, column=6).number_format = '$#,##0.00;[Red]-$#,##0.00'
    ws2.cell(row=T_TOTAL_ROW, column=7).number_format = '0.0'
    ws2.row_dimensions[T_TOTAL_ROW].height = 24

ws2.freeze_panes = 'A4'

# ============================================================================
# Sheet 3: V1 vs V2 Comparison
# ============================================================================
ws3 = wb.create_sheet('V1 vs V2 Comparison')
ws3.merge_cells('A1:F1')
ws3['A1'] = 'V1 Baseline vs V2 Method — Aggregate Comparison'
ws3['A1'].font = Font(name=ARIAL, size=16, bold=True, color=THEME['title_fg'])
ws3['A1'].fill = PatternFill('solid', fgColor=THEME['title_bg'])
ws3['A1'].alignment = Alignment(horizontal='center', vertical='center')
ws3.row_dimensions[1].height = 32

ws3.merge_cells('A2:F2')
ws3['A2'] = (f"Universe: {len(report['tickers'])} tickers  |  "
             f"Window: {report['backtest_start']} → {report['backtest_end']}  ({report['backtest_years']}y)")
ws3['A2'].font = Font(name=ARIAL, size=11, italic=True, color='2D3748')
ws3['A2'].alignment = Alignment(horizontal='center', vertical='center')
ws3['A2'].fill = PatternFill('solid', fgColor='F7FAFC')
ws3.row_dimensions[2].height = 22

# Comparison table
C_HEADER_ROW = 4
HEADERS = ['Metric', 'V1.7-shipped (baseline)', f'V2 ({headline_variant})', 'Delta', 'Notes', '']
for col_idx, label in enumerate(HEADERS, 1):
    c = ws3.cell(row=C_HEADER_ROW, column=col_idx, value=label)
    c.font = Font(name=ARIAL, size=11, bold=True, color=THEME['header_fg'])
    c.fill = PatternFill('solid', fgColor=THEME['header_bg'])
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    c.border = BORDER
ws3.row_dimensions[C_HEADER_ROW].height = 32

def fmt_delta(v1v, v2v, pct=False, money=False):
    d = v2v - v1v
    if pct: return f'{d:+.1f}pp'
    if money: return f'${d:+,.0f}'
    return f'{d:+}'

rows = [
    ('Total trades',     v1_agg['total'],                 v2_agg['total'],                 fmt_delta(v1_agg['total'], v2_agg['total']), 'V2 = stricter, fewer trades'),
    ('Wins',             v1_agg['wins'],                  v2_agg['wins'],                  fmt_delta(v1_agg['wins'], v2_agg['wins']), ''),
    ('Losses',           v1_agg['losses'],                v2_agg['losses'],                fmt_delta(v1_agg['losses'], v2_agg['losses']), ''),
    ('Win Rate (%)',     v1_agg['win_rate'],              v2_agg['win_rate'],              fmt_delta(v1_agg['win_rate'], v2_agg['win_rate'], pct=True), 'Target: 65-75% (community claim)'),
    ('Profit Factor',    v1_agg['profit_factor'],         v2_agg['profit_factor'],         f"{v2_agg['profit_factor']-v1_agg['profit_factor']:+.2f}", 'Higher = wins outweigh losses more'),
    ('Net P&L ($)',      v1_agg['total_pnl'],             v2_agg['total_pnl'],             fmt_delta(v1_agg['total_pnl'], v2_agg['total_pnl'], money=True), ''),
    ('Avg win ($)',      v1_agg['avg_win'],               v2_agg['avg_win'],               fmt_delta(v1_agg['avg_win'], v2_agg['avg_win'], money=True), ''),
    ('Avg loss ($)',     v1_agg['avg_loss'],              v2_agg['avg_loss'],              fmt_delta(v1_agg['avg_loss'], v2_agg['avg_loss'], money=True), ''),
    ('Stop-out exits',   v1_agg['stop_outs'],             v2_agg['stop_outs'],             fmt_delta(v1_agg['stop_outs'], v2_agg['stop_outs']), ''),
    ('RSI50 exits',      v1_agg['rsi50_exits'],           v2_agg['rsi50_exits'],           fmt_delta(v1_agg['rsi50_exits'], v2_agg['rsi50_exits']), ''),
    ('Avg bars held',    v1_agg['avg_bars_held'],         v2_agg['avg_bars_held'],         f"{v2_agg['avg_bars_held']-v1_agg['avg_bars_held']:+.1f}", ''),
    ('Longs',            v1_agg.get('longs', 0),          v2_agg.get('longs', 0),          fmt_delta(v1_agg.get('longs', 0), v2_agg.get('longs', 0)), ''),
    ('Shorts',           v1_agg.get('shorts', 0),         v2_agg.get('shorts', 0),         fmt_delta(v1_agg.get('shorts', 0), v2_agg.get('shorts', 0)), ''),
    ('Avg RSI@entry L',  v1_agg['avg_entry_rsi_long'],    v2_agg['avg_entry_rsi_long'],    f"{v2_agg['avg_entry_rsi_long']-v1_agg['avg_entry_rsi_long']:+.1f}", 'V2 no-go = no entries above 45'),
    ('Avg RSI@entry S',  v1_agg['avg_entry_rsi_short'],   v2_agg['avg_entry_rsi_short'],   f"{v2_agg['avg_entry_rsi_short']-v1_agg['avg_entry_rsi_short']:+.1f}", 'V2 no-go = no entries below 55'),
]
C_DATA_START = C_HEADER_ROW + 1
for i, r_data in enumerate(rows):
    r = C_DATA_START + i
    for col_idx, val in enumerate(r_data, 1):
        c = ws3.cell(row=r, column=col_idx, value=val)
        c.font = Font(name=ARIAL, size=10)
        c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        c.border = BORDER
        c.fill = PatternFill('solid', fgColor=(THEME['row_white'] if i % 2 == 0 else THEME['row_alt']))
    ws3.cell(row=r, column=1).alignment = Alignment(horizontal='left', vertical='center')
    ws3.cell(row=r, column=1).font = Font(name=ARIAL, size=10, bold=True, color='2D3748')

    # Highlight win rate row
    if r_data[0] == 'Win Rate (%)':
        v1_wr = r_data[1]; v2_wr = r_data[2]
        ws3.cell(row=r, column=2).number_format = '0.0'
        ws3.cell(row=r, column=3).number_format = '0.0'
        if v2_wr > v1_wr:
            ws3.cell(row=r, column=3).fill = PatternFill('solid', fgColor=THEME['win_bg'])
            ws3.cell(row=r, column=3).font = Font(name=ARIAL, size=10, bold=True, color=THEME['win_fg'])
        elif v2_wr < v1_wr:
            ws3.cell(row=r, column=3).fill = PatternFill('solid', fgColor=THEME['loss_bg'])
            ws3.cell(row=r, column=3).font = Font(name=ARIAL, size=10, bold=True, color=THEME['loss_fg'])
    if r_data[0] in ('Net P&L ($)', 'Avg win ($)', 'Avg loss ($)'):
        ws3.cell(row=r, column=2).number_format = '$#,##0.00'
        ws3.cell(row=r, column=3).number_format = '$#,##0.00'
    if r_data[0] == 'Profit Factor':
        ws3.cell(row=r, column=2).number_format = '0.00'
        ws3.cell(row=r, column=3).number_format = '0.00'
    if r_data[0] == 'Avg bars held':
        ws3.cell(row=r, column=2).number_format = '0.0'
        ws3.cell(row=r, column=3).number_format = '0.0'
    if r_data[0].startswith('Avg RSI'):
        ws3.cell(row=r, column=2).number_format = '0.0'
        ws3.cell(row=r, column=3).number_format = '0.0'

ws3.column_dimensions['A'].width = 22
ws3.column_dimensions['B'].width = 24
ws3.column_dimensions['C'].width = 18
ws3.column_dimensions['D'].width = 14
ws3.column_dimensions['E'].width = 42
ws3.column_dimensions['F'].width = 6

# ─── All 4 Variants Grid ─────────────────────────────────────────────────
ALL_VAR_HEADER = C_DATA_START + len(rows) + 2
c = ws3.cell(row=ALL_VAR_HEADER, column=1, value='All variants side-by-side')
c.font = Font(name=ARIAL, size=13, bold=True, color=THEME['title_fg'])
c.fill = PatternFill('solid', fgColor=THEME['title_bg'])
c.alignment = Alignment(horizontal='left', vertical='center')
ws3.merge_cells(start_row=ALL_VAR_HEADER, start_column=1, end_row=ALL_VAR_HEADER, end_column=6)
ws3.row_dimensions[ALL_VAR_HEADER].height = 28

GRID_HEADER = ALL_VAR_HEADER + 1
grid_cols = ['Variant', 'Trades', 'L/S', 'Win Rate', 'PF', 'Net P&L']
for col_idx, label in enumerate(grid_cols, 1):
    c = ws3.cell(row=GRID_HEADER, column=col_idx, value=label)
    c.font = Font(name=ARIAL, size=11, bold=True, color=THEME['header_fg'])
    c.fill = PatternFill('solid', fgColor=THEME['header_bg'])
    c.alignment = Alignment(horizontal='center', vertical='center')
    c.border = BORDER
ws3.row_dimensions[GRID_HEADER].height = 28

GRID_DATA = GRID_HEADER + 1
variant_order = ['v1.7-shipped', 'v2-nogo-only', 'v2-weekly-or', 'v2-slope', 'v2-method']
for i, vname in enumerate(variant_order):
    if vname not in agg:
        continue
    a = agg[vname]
    r = GRID_DATA + i
    is_headline = (vname == headline_variant)
    pf_text = '∞' if a.get('profit_factor', 0) >= 999 else f"{a.get('profit_factor', 0):.2f}"
    cells = [
        (vname + (' ★' if is_headline else ''),),
        (a.get('total', 0),),
        (f"{a.get('longs', 0)}/{a.get('shorts', 0)}",),
        (a.get('win_rate', 0) / 100,),
        (pf_text,),
        (a.get('total_pnl', 0),),
    ]
    for col_idx, val_tuple in enumerate(cells, 1):
        c = ws3.cell(row=r, column=col_idx, value=val_tuple[0])
        c.font = Font(name=ARIAL, size=10, bold=is_headline)
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = BORDER
        if is_headline:
            c.fill = PatternFill('solid', fgColor=THEME['win_bg'])
        else:
            c.fill = PatternFill('solid', fgColor=(THEME['row_white'] if i % 2 == 0 else THEME['row_alt']))
    ws3.cell(row=r, column=2).number_format = '0'
    ws3.cell(row=r, column=4).number_format = '0.0%'
    ws3.cell(row=r, column=6).number_format = '$#,##0.00;[Red]-$#,##0.00'

# ============================================================================
# Sheet 4: Strategy Rules (V2)
# ============================================================================
ws4 = wb.create_sheet('Strategy Rules (V2)')
ws4.merge_cells('A1:C1')
ws4['A1'] = 'SID V2 Method — Rule Reference'
ws4['A1'].font = Font(name=ARIAL, size=16, bold=True, color=THEME['title_fg'])
ws4['A1'].fill = PatternFill('solid', fgColor=THEME['title_bg'])
ws4['A1'].alignment = Alignment(horizontal='center', vertical='center')
ws4.row_dimensions[1].height = 32

rules = [
    ('Stage 1 — ARM (signal day)', '', ''),
    ('Daily RSI(14) oversold (long)',    '< 30',                    'Triggers long arm'),
    ('Daily RSI(14) overbought (short)', '> 70 (V2 uses 70 not 75)','Triggers short arm. V1 used 75.'),
    ('Daily RSI(3) confirmation',        'Must be in extreme zone', 'Rebound-zone confirmation, carried from V1'),
    ('Weekly trend filter (50/200 SMA)', 'Long: 50SMA>200SMA; Short: 50SMA<200SMA', 'Retained from V1 for safety'),
    ('Earnings blackout',                '14 days pre-earnings',    'Skip new arms inside this window'),

    ('Stage 2 — TRIGGER (entry day)', '', ''),
    ('Daily RSI direction',              'Pointing in trade direction', 'Long: rising. Short: falling.'),
    ('Daily MACD direction',             'Pointing in trade direction', 'Long: rising. Short: falling.'),
    ('** Weekly RSI direction **',       'Same direction as trade',  'NEW IN V2 — biggest single confirmation'),
    ('** Weekly MACD direction **',      'Same direction as trade',  'NEW IN V2 — biggest single confirmation'),
    ('** No-go zone (long) **',          'Entry RSI must be < 45',   'NEW IN V2 — keeps reward window viable'),
    ('** No-go zone (short) **',         'Entry RSI must be > 55',   'NEW IN V2 — keeps reward window viable'),
    ('Pattern bonus (W/M/H&S)',          'Bonus, NOT required',      'Deferred to V2.1 — see Pine divergence indicator'),
    ('Sticky arm window',                '3 trading days',           'If trigger not met within 3 days, arm cancels'),

    ('Stage 3 — EXIT', '', ''),
    ('Take profit (Option A)',           'Daily RSI(14) reaches 50', 'Single full exit. V1-compatible.'),
    ('Take profit (Option B — V2.1)',    '50% at RSI50, 50% at 50/200 MA', 'Future: dual-target system'),
    ('Stop loss (long)',                 'Lowest low signal→entry, FLOOR to whole $', 'Hard stop, never moved'),
    ('Stop loss (short)',                'Highest high signal→entry, CEIL to whole $','Hard stop, never moved'),

    ('Sizing', '', ''),
    ('Account size assumption',          '$10,000',                  ''),
    ('Risk per trade',                   '$200 fixed (2%)',          'Trades that fail RR check are skipped'),

    ('Architecture', '', ''),
    ('SID_METHOD env var',               "Default 'v1'; set 'v2' to enable", 'Bot toggles between methods'),
    ('V1 baseline tag',                  'sid-v1-method-baseline (commit bdef9be)', 'Instant revert if V2 underperforms'),
]

start_row = 3
for r_off, (param, val, note) in enumerate(rules):
    r = start_row + r_off
    is_section = val == '' and note == ''
    is_new = '**' in param
    a = ws4.cell(row=r, column=1, value=param.replace('**', '').strip())
    b = ws4.cell(row=r, column=2, value=val)
    c = ws4.cell(row=r, column=3, value=note)
    for cell in (a, b, c):
        cell.alignment = Alignment(vertical='center', wrap_text=True)
        cell.border = BORDER
        if is_section:
            cell.font = Font(name=ARIAL, size=11, bold=True, color=THEME['subheader_fg'])
            cell.fill = PatternFill('solid', fgColor=THEME['subheader_bg'])
        elif is_new:
            cell.font = Font(name=ARIAL, size=10, bold=True, color='6B46C1')  # purple = V2 new
            cell.fill = PatternFill('solid', fgColor=THEME['cyan_bg'])
        else:
            cell.font = Font(name=ARIAL, size=10, color='2D3748')
            cell.fill = PatternFill('solid', fgColor=(THEME['row_alt'] if r_off % 2 == 1 else THEME['row_white']))
    if is_section:
        a.alignment = Alignment(vertical='center', horizontal='left')
    ws4.row_dimensions[r].height = 22 if is_section else 28

ws4.column_dimensions['A'].width = 38
ws4.column_dimensions['B'].width = 42
ws4.column_dimensions['C'].width = 55

# Save
wb.save(OUT_PATH)
print(f'\nWrote {OUT_PATH.name}')
print(f'  Sheet 1: All Trades (V2) — {len(v2_sorted)} rows')
print(f'  Sheet 2: Per-Ticker Summary — {len(ticker_rows)} tickers')
print(f'  Sheet 3: V1 vs V2 Comparison')
print(f'  Sheet 4: Strategy Rules (V2) — {len(rules)} rows')
