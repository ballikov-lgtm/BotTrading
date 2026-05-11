"""
classify-assets.py — Three-tier asset classifier for SID v1.2/v1.3

Reads the most recent backtest report and assigns each ticker to one of:
  - AUTO_TRADE: proven consistent positive — bot executes signals automatically
  - MONITOR:    high-risk or marginal — bot flags signals, requires sentiment/
                news/manual review before any trade. NEVER auto-executes.
  - EXCLUDED:   clearly losing on this strategy — dropped from active watchlist
  - INSUFFICIENT_DATA: < 2 trades — re-evaluate in 3 months

Also preserves per-ticker direction restriction (long-only / short-only / both)
from prior analysis.

Output:
  - asset-classification.json — machine-readable, consumed by scanner/bot
  - asset-classification.md   — human-readable report
"""
import json
import sys
import io
from pathlib import Path
from datetime import datetime

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = Path(__file__).parent
BACKTEST_JSON = HERE / 'backtest-report_rsi75_lo_rsi3_weekly.json'   # v1.4 — all filters
OUT_JSON      = HERE / 'asset-classification.json'
OUT_MD        = HERE / 'asset-classification.md'

# Direction restrictions discovered in prior analysis (RSI 75 backtest):
LONG_ONLY  = {'XLC', 'QQQ', 'AMD', 'INTC', 'SPY', 'CAT', 'MSFT', 'TQQQ', 'XLK',
              'GOLD', 'GS', 'IBM', 'JPM', 'XLB', 'XLE'}
SHORT_ONLY = {'TZA', 'XLY', 'SQQQ', 'HD', 'TGT'}

# Classification thresholds
AUTO_TRADE_RULES = {
    'min_trades'        : 3,
    'min_net_pnl'       : 50.0,
    'min_profit_factor' : 1.5,
    'min_win_rate'      : 40.0,
}
MONITOR_RULES = {
    'min_trades'             : 2,
    'min_profit_factor'      : 0.8,   # close to break-even or better
    'min_win_rate'           : 25.0,
    'max_net_loss'           : 75.0,  # not bleeding badly
}
# Anything else with >= 2 trades → EXCLUDED
# < 2 trades → INSUFFICIENT_DATA

def classify_ticker(stats: dict) -> tuple[str, str]:
    """Returns (tier, reason)."""
    n  = stats['total']
    wr = stats['win_rate']
    pf = stats['profit_factor']
    pnl = stats['total_pnl']

    if n < AUTO_TRADE_RULES['min_trades'] and n < MONITOR_RULES['min_trades']:
        return 'INSUFFICIENT_DATA', f'only {n} trade(s) in 12 months'

    # AUTO_TRADE — strict criteria
    if (n >= AUTO_TRADE_RULES['min_trades']
        and pnl >= AUTO_TRADE_RULES['min_net_pnl']
        and pf >= AUTO_TRADE_RULES['min_profit_factor']
        and wr >= AUTO_TRADE_RULES['min_win_rate']):
        return 'AUTO_TRADE', f'WR={wr:.0f}% PF={pf:.2f} P&L=${pnl:+.0f} over {n} trades — consistent'

    # MONITOR — marginal/high-risk
    if (n >= MONITOR_RULES['min_trades']
        and pf >= MONITOR_RULES['min_profit_factor']
        and wr >= MONITOR_RULES['min_win_rate']
        and pnl >= -MONITOR_RULES['max_net_loss']):
        return 'MONITOR', f'WR={wr:.0f}% PF={pf:.2f} P&L=${pnl:+.0f} over {n} trades — borderline, needs sentiment check'

    # Otherwise EXCLUDED
    return 'EXCLUDED', f'WR={wr:.0f}% PF={pf:.2f} P&L=${pnl:+.0f} over {n} trades — net negative without edge'

def direction_for(ticker: str) -> str:
    if ticker in LONG_ONLY:  return 'long-only'
    if ticker in SHORT_ONLY: return 'short-only'
    return 'both'

def main():
    if not BACKTEST_JSON.exists():
        print(f'Cannot find {BACKTEST_JSON}. Run backtest-sid.py first.')
        sys.exit(1)

    report = json.loads(BACKTEST_JSON.read_text(encoding='utf-8'))

    classifications = []
    for r in report['results']:
        t = r['ticker']
        tier, reason = classify_ticker(r['all'])
        classifications.append({
            'symbol'       : t,
            'tier'         : tier,
            'direction'    : direction_for(t),
            'win_rate'     : r['all']['win_rate'],
            'profit_factor': r['all']['profit_factor'],
            'net_pnl'      : r['all']['total_pnl'],
            'trade_count'  : r['all']['total'],
            'reason'       : reason,
        })

    # Sort within each tier by net P&L desc
    classifications.sort(key=lambda c: (-c['net_pnl'], c['symbol']))

    # Group
    groups = {}
    for c in classifications:
        groups.setdefault(c['tier'], []).append(c)

    # Order tiers for output
    tier_order = ['AUTO_TRADE', 'MONITOR', 'EXCLUDED', 'INSUFFICIENT_DATA']

    out = {
        'generated'        : datetime.now().isoformat(),
        'strategy_version' : '1.2',
        'data_source'      : BACKTEST_JSON.name,
        'rules' : {
            'auto_trade': AUTO_TRADE_RULES,
            'monitor'   : MONITOR_RULES,
        },
        'summary' : {tier: len(groups.get(tier, [])) for tier in tier_order},
        'tickers' : classifications,
    }
    OUT_JSON.write_text(json.dumps(out, indent=2), encoding='utf-8')

    # Markdown report
    lines = []
    lines.append('# SID Asset Classification')
    lines.append('')
    lines.append(f'**Strategy version:** v{out["strategy_version"]}')
    lines.append(f'**Generated:** {out["generated"]}')
    lines.append(f'**Source:** `{out["data_source"]}`')
    lines.append('')

    lines.append('## Summary')
    lines.append('')
    lines.append(f"| Tier | Count | Behaviour |")
    lines.append(f"|---|---:|---|")
    lines.append(f"| 🟢 **AUTO_TRADE** | {out['summary']['AUTO_TRADE']} | Bot executes signals automatically. Proven consistent edge. |")
    lines.append(f"| 🟡 **MONITOR** | {out['summary']['MONITOR']} | Bot flags signals + alerts user. **Manual review required** (sentiment, news, weekly trend). Never auto-trade. |")
    lines.append(f"| 🔴 **EXCLUDED** | {out['summary']['EXCLUDED']} | Dropped from active watchlist — strategy has no edge on these. |")
    lines.append(f"| ⚪ **INSUFFICIENT_DATA** | {out['summary']['INSUFFICIENT_DATA']} | < 2 trades in 12 months. Re-evaluate quarterly. |")
    lines.append('')

    tier_emoji = {
        'AUTO_TRADE'       : '🟢',
        'MONITOR'          : '🟡',
        'EXCLUDED'         : '🔴',
        'INSUFFICIENT_DATA': '⚪',
    }
    tier_title = {
        'AUTO_TRADE'       : 'AUTO_TRADE — bot executes',
        'MONITOR'          : 'MONITOR — flag only, manual review with sentiment',
        'EXCLUDED'         : 'EXCLUDED — drop from active watchlist',
        'INSUFFICIENT_DATA': 'INSUFFICIENT_DATA — re-evaluate quarterly',
    }

    rules_for_tier = {
        'AUTO_TRADE': f'≥ {AUTO_TRADE_RULES["min_trades"]} trades, ≥ ${AUTO_TRADE_RULES["min_net_pnl"]:.0f} net P&L, ≥ {AUTO_TRADE_RULES["min_profit_factor"]:.1f} profit factor, ≥ {AUTO_TRADE_RULES["min_win_rate"]:.0f}% win rate',
        'MONITOR'   : f'≥ {MONITOR_RULES["min_trades"]} trades, ≥ {MONITOR_RULES["min_profit_factor"]:.1f} profit factor, ≥ {MONITOR_RULES["min_win_rate"]:.0f}% win rate, ≤ ${MONITOR_RULES["max_net_loss"]:.0f} max net loss',
        'EXCLUDED'  : 'fails MONITOR criteria — net losing without sufficient edge',
        'INSUFFICIENT_DATA': '< 2 trades in 12 months',
    }

    for tier in tier_order:
        lines.append(f"## {tier_emoji[tier]} {tier_title[tier]}")
        lines.append('')
        lines.append(f"*Criteria: {rules_for_tier[tier]}*")
        lines.append('')
        tickers_in_tier = groups.get(tier, [])
        if not tickers_in_tier:
            lines.append('_(none)_')
            lines.append('')
            continue
        lines.append('| # | Ticker | Direction | WR | PF | Net P&L | Trades | Reason |')
        lines.append('|---:|---|---|---:|---:|---:|---:|---|')
        for i, c in enumerate(tickers_in_tier, 1):
            pf_str = '∞' if c['profit_factor'] >= 999 else f"{c['profit_factor']:.2f}"
            lines.append(f"| {i} | **{c['symbol']}** | {c['direction']} | {c['win_rate']:.0f}% | {pf_str} | ${c['net_pnl']:+.0f} | {c['trade_count']} | {c['reason']} |")
        lines.append('')

    lines.append('## How MONITOR works')
    lines.append('')
    lines.append('When a MONITOR-tier ticker fires a SID signal (arm or entry-ready), the bot will:')
    lines.append('')
    lines.append('1. **Add it to the dashboard** scanner panel with a 🟡 indicator')
    lines.append('2. **Send a Telegram alert** with current sentiment + recent news context (from the planned Perplexity research tool)')
    lines.append('3. **NOT execute the trade automatically** — wait for explicit user approval')
    lines.append('4. **Expire the alert** after the standard 3-day timeout')
    lines.append('')
    lines.append('AUTO_TRADE tickers fire signals into the order pipeline without manual review (subject to the standard pre-flight checks).')
    lines.append('')
    lines.append('EXCLUDED tickers are removed from `watchlist-sid.json` entirely (or stay marked `tier: "excluded"` for transparency).')
    lines.append('')

    lines.append('## How to apply')
    lines.append('')
    lines.append('Either:')
    lines.append('- **A)** Update `watchlist-sid.json` to include `direction` and `tier` per ticker (richer object format), then update the scanner + bot to honour them')
    lines.append('- **B)** Keep `watchlist-sid.json` as a flat list and consume `asset-classification.json` as a side-car')
    lines.append('')
    lines.append('Option A is cleaner long-term but requires touching the scanner. Option B is faster and reversible.')

    OUT_MD.write_text('\n'.join(lines), encoding='utf-8')

    print(f"=== Asset Classification ===")
    for tier in tier_order:
        items = groups.get(tier, [])
        tickers = ', '.join(c['symbol'] for c in items) or 'none'
        print(f"  {tier_emoji[tier]} {tier:18} ({len(items):>2}): {tickers}")
    print()
    print(f"Wrote: {OUT_JSON.name} + {OUT_MD.name}")

if __name__ == '__main__':
    main()
