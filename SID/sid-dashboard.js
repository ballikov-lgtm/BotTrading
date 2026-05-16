/**
 * sid-dashboard.js — Private SID-only dashboard generator
 *
 * Reads SID data files and writes a self-contained, futuristic-themed HTML
 * dashboard to docs/sid/index.html. Independent of the Ironclad/Perplexity
 * pipeline. Designed to be hosted on GitHub Pages (or anywhere static).
 *
 * Inputs (all optional — gracefully degrades if missing):
 *   SID/scanner-sid.json           — live watchlist + signals
 *   SID/closed-positions-sid.json  — historical trades
 *   SID/open-positions-sid.json    — currently open positions
 *   SID/asset-classification.json  — AUTO_TRADE / MONITOR tiers
 *   SID/backtest-report_rsi75_lo_rsi3_weekly.json — v1.4 backtest results
 *
 * Output:
 *   docs/sid/index.html (single file, inline CSS+JS, no external deps)
 *
 * Run:
 *   node SID/sid-dashboard.js
 *
 * Theme: cyberpunk neon — cyan + magenta + electric green on pure black.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'docs', 'sid', 'index.html');

const STRATEGY_VERSION = '2.0';
// v2.0 launched 2026-05-16 — V2 method on 113-ticker universe (5y).
// Position-sized at 1% risk (instructor S3_Ep4 default).
// Backtest: $10K → $43,328 (+333%), CAGR 34.7%, max DD 7.95%, 64.9% WR.
// Currently PAPER TRADING — switching to live once Alpaca account confirmed.
const HEADLINE_BACKTEST_WR = 64.9;
const HEADLINE_BACKTEST_PNL = 29755;  // 5y net P&L at fixed $200 risk
const HEADLINE_BACKTEST_CAGR = 34.7;  // Compounded annual @ 1% risk position sizing
const HEADLINE_MAX_DD = 7.95;
const PAPER_TRADING_MODE = true;       // Banner flag — flip to false after Alpaca live

// ── Data loading (all optional) ──────────────────────────────────────────
function loadJSON(relPath, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8')); }
  catch { return fallback; }
}

const scanner        = loadJSON('SID/scanner-sid.json', null);
const closed         = loadJSON('SID/closed-positions-sid.json', []);
const open           = loadJSON('SID/open-positions-sid.json', []);
const classification = loadJSON('SID/asset-classification.json', null);
const backtest       = loadJSON('SID/backtest-report_rsi75_lo_rsi3_weekly.json', null);

// Normalize closed positions — sometimes array, sometimes object
const closedArr = Array.isArray(closed) ? closed : (Array.isArray(closed.positions) ? closed.positions : []);

// ── Aggregations ─────────────────────────────────────────────────────────
function aggClosed(rows) {
  const wins = rows.filter(r => (r.realizedPnl ?? r.pnl ?? 0) > 0);
  const losses = rows.filter(r => (r.realizedPnl ?? r.pnl ?? 0) <= 0);
  const totalPnl = rows.reduce((s, r) => s + (r.realizedPnl ?? r.pnl ?? 0), 0);
  return {
    total: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: rows.length ? (wins.length / rows.length * 100) : 0,
    netPnl: totalPnl,
  };
}

const liveStats = aggClosed(closedArr);

// Classification breakdown
const byTier = classification?.tickers
  ? classification.tickers.reduce((acc, t) => {
      acc[t.tier] = acc[t.tier] || [];
      acc[t.tier].push(t);
      return acc;
    }, {})
  : { AUTO_TRADE: [], MONITOR: [], EXCLUDED: [], INSUFFICIENT_DATA: [] };

// Scanner signals
const liveSignals = scanner?.tickers
  ? scanner.tickers.filter(t =>
      t.status === 'SIGNAL_LONG' || t.status === 'SIGNAL_SHORT' ||
      t.status === 'OVERSOLD_WAIT_MACD' || t.status === 'OVERBOUGHT_WAIT_MACD'
    )
  : [];
const approaching = scanner?.tickers
  ? scanner.tickers.filter(t => t.status === 'APPROACHING_LONG' || t.status === 'APPROACHING_SHORT')
  : [];

// ── Helpers ──────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtUSD = n => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
const fmtPct = n => n.toFixed(1) + '%';

// ── SVG donut chart ──────────────────────────────────────────────────────
function donutChart(segments, size = 220) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.4;
  const inner = r * 0.62;
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let offset = -Math.PI / 2;
  const arcs = segments.map(seg => {
    const angle = (seg.value / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(offset);
    const y1 = cy + r * Math.sin(offset);
    const x2 = cx + r * Math.cos(offset + angle);
    const y2 = cy + r * Math.sin(offset + angle);
    const x3 = cx + inner * Math.cos(offset + angle);
    const y3 = cy + inner * Math.sin(offset + angle);
    const x4 = cx + inner * Math.cos(offset);
    const y4 = cy + inner * Math.sin(offset);
    const large = angle > Math.PI ? 1 : 0;
    const d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
    offset += angle;
    return `<path d="${d}" fill="${seg.color}" stroke="#000" stroke-width="1.5" style="filter: drop-shadow(0 0 6px ${seg.color})"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    ${arcs}
    <circle cx="${cx}" cy="${cy}" r="${inner - 2}" fill="#000"/>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#00ffff" font-family="Orbitron, monospace" font-size="20" font-weight="700" style="filter: drop-shadow(0 0 4px #00ffff)">${fmtPct(liveStats.winRate || HEADLINE_BACKTEST_WR)}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#888" font-family="Share Tech Mono, monospace" font-size="9">WIN RATE</text>
  </svg>`;
}

// ── Render: live signals table ───────────────────────────────────────────
function renderSignalsTable(signals, title, emptyMsg) {
  if (!signals.length) {
    return `<div class="hud-empty">${emptyMsg}</div>`;
  }
  const rows = signals.slice(0, 12).map(t => {
    const isLong = (t.status || '').includes('LONG') || (t.direction || '').toUpperCase() === 'LONG';
    const isShort = (t.status || '').includes('SHORT') || (t.direction || '').toUpperCase() === 'SHORT';
    const color = isLong ? '#39ff14' : isShort ? '#ff1493' : '#00ffff';
    const arrow = isLong ? '▲' : isShort ? '▼' : '◆';
    const stateLabel = ({
      SIGNAL_LONG: 'SIGNAL LONG',
      SIGNAL_SHORT: 'SIGNAL SHORT',
      OVERSOLD_WAIT_MACD: 'OVERSOLD · WAITING MACD',
      OVERBOUGHT_WAIT_MACD: 'OVERBOUGHT · WAITING MACD',
      APPROACHING_LONG: 'APPROACHING LONG',
      APPROACHING_SHORT: 'APPROACHING SHORT',
    })[t.status] || t.status || 'UNKNOWN';
    const tierBadge = classification?.tickers?.find(c => c.symbol === t.symbol)?.tier;
    const tierColor = ({AUTO_TRADE: '#39ff14', MONITOR: '#ffaa00', EXCLUDED: '#666'})[tierBadge] || '#888';
    const tierLabel = tierBadge === 'AUTO_TRADE' ? 'AUTO' : tierBadge === 'MONITOR' ? 'MONITOR' : tierBadge === 'EXCLUDED' ? '—' : '·';
    return `<tr class="signal-row">
      <td class="sig-arrow" style="color:${color};text-shadow:0 0 8px ${color}">${arrow}</td>
      <td class="sig-symbol">${esc(t.symbol)}</td>
      <td class="sig-state" style="color:${color}">${stateLabel}</td>
      <td class="sig-rsi">${t.rsi != null ? t.rsi.toFixed(1) : '—'}</td>
      <td class="sig-price">$${t.lastClose != null ? t.lastClose.toFixed(2) : '—'}</td>
      <td class="sig-tier" style="color:${tierColor}">${tierLabel}</td>
    </tr>`;
  }).join('');
  return `<table class="signals-table">
    <thead><tr><th></th><th>SYMBOL</th><th>STATE</th><th>RSI</th><th>PRICE</th><th>TIER</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Render: open positions as cards with mini-chart ───────────────────
function renderOpenPositionsCards(rows) {
  if (!rows.length) {
    return `<div class="hud-empty">// NO OPEN POSITIONS // STANDING BY //</div>`;
  }
  const todayMs = Date.now();
  // Map of current prices from scanner data (if available)
  const scanPriceBySymbol = {};
  if (scanner?.tickers) {
    for (const t of scanner.tickers) {
      if (t.symbol && t.lastClose != null) scanPriceBySymbol[t.symbol] = t.lastClose;
    }
  }

  const cards = rows.map(r => {
    const isLong = (r.side || '').toLowerCase() === 'long';
    const sideColor = isLong ? '#39ff14' : '#ff1493';
    const sideArrow = isLong ? '▲' : '▼';
    const entry = r.entry ?? r.entryPrice ?? 0;
    const stop  = r.stopLoss ?? r.stop ?? 0;
    const current = scanPriceBySymbol[r.symbol] ?? entry;  // fallback to entry if no live price
    let daysOpen = '—';
    if (r.openDate) {
      const opened = new Date(r.openDate + 'T00:00:00Z').getTime();
      if (!Number.isNaN(opened)) daysOpen = String(Math.max(0, Math.floor((todayMs - opened) / (1000*60*60*24))));
    }

    // P&L % since entry
    const pnlPct = isLong
      ? ((current - entry) / entry) * 100
      : ((entry - current) / entry) * 100;
    const inProfit = pnlPct > 0;
    const pnlColor = inProfit ? '#39ff14' : (pnlPct < 0 ? '#ff0044' : '#888');

    // Distance to stop %
    const stopDistPct = isLong
      ? ((current - stop) / current) * 100
      : ((stop - current) / current) * 100;

    // Mini chart SVG showing entry · current · stop on a horizontal price band
    // For LONG: stop (left) → entry → upside (right)
    // For SHORT: stop (right, above) ← entry ← downside (left)
    // We normalize so the chart shows: 1.5R risk band centered around entry
    const risk = Math.abs(entry - stop);
    const target = isLong ? entry + risk * 3 : entry - risk * 3;  // 3R upside reference
    const minPrice = isLong ? stop : target;
    const maxPrice = isLong ? target : stop;
    const range = Math.max(maxPrice - minPrice, 0.001);
    const W = 280, H = 56;
    const padL = 12, padR = 12;
    const innerW = W - padL - padR;
    const xAt = (p) => padL + ((p - minPrice) / range) * innerW;
    const cy = H / 2;

    const xStop    = xAt(stop);
    const xEntry   = xAt(entry);
    const xCurrent = xAt(Math.max(minPrice, Math.min(maxPrice, current)));
    const xTarget  = xAt(target);

    const profitGrad = isLong
      ? `linear-gradient(90deg, rgba(255,0,68,0.4) 0%, rgba(255,0,68,0.4) ${(xEntry-padL)/innerW*100}%, rgba(57,255,20,0.3) ${(xEntry-padL)/innerW*100}%, rgba(57,255,20,0.05) 100%)`
      : `linear-gradient(90deg, rgba(57,255,20,0.05) 0%, rgba(57,255,20,0.3) ${(xEntry-padL)/innerW*100}%, rgba(255,0,68,0.4) ${(xEntry-padL)/innerW*100}%, rgba(255,0,68,0.4) 100%)`;

    const chartSvg = `
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="position-chart">
        <defs>
          <linearGradient id="grad-${esc(r.id)}" x1="0" y1="0" x2="1" y2="0">
            ${isLong
              ? `<stop offset="0%" stop-color="#ff0044" stop-opacity="0.45"/><stop offset="${(xEntry-padL)/innerW*100}%" stop-color="#ff0044" stop-opacity="0.45"/><stop offset="${(xEntry-padL)/innerW*100}%" stop-color="#39ff14" stop-opacity="0.3"/><stop offset="100%" stop-color="#39ff14" stop-opacity="0.05"/>`
              : `<stop offset="0%" stop-color="#39ff14" stop-opacity="0.05"/><stop offset="${(xEntry-padL)/innerW*100}%" stop-color="#39ff14" stop-opacity="0.3"/><stop offset="${(xEntry-padL)/innerW*100}%" stop-color="#ff0044" stop-opacity="0.45"/><stop offset="100%" stop-color="#ff0044" stop-opacity="0.45"/>`}
          </linearGradient>
        </defs>
        <!-- background band showing profit / loss zones -->
        <rect x="${padL}" y="${cy-6}" width="${innerW}" height="12" fill="url(#grad-${esc(r.id)})" rx="2"/>
        <!-- baseline -->
        <line x1="${padL}" y1="${cy}" x2="${W-padR}" y2="${cy}" stroke="#1a4040" stroke-width="0.5"/>
        <!-- stop marker -->
        <line x1="${xStop}" y1="${cy-10}" x2="${xStop}" y2="${cy+10}" stroke="#ff0044" stroke-width="2" stroke-dasharray="2,2" style="filter: drop-shadow(0 0 4px #ff0044)"/>
        <text x="${xStop}" y="${H-2}" text-anchor="middle" font-size="8" fill="#ff0044" font-family="Share Tech Mono, monospace">STOP</text>
        <!-- entry marker -->
        <line x1="${xEntry}" y1="${cy-12}" x2="${xEntry}" y2="${cy+12}" stroke="#00ffff" stroke-width="1.5" style="filter: drop-shadow(0 0 4px #00ffff)"/>
        <text x="${xEntry}" y="${H-2}" text-anchor="middle" font-size="8" fill="#00ffff" font-family="Share Tech Mono, monospace">ENTRY</text>
        <!-- current price pulsing dot -->
        <circle cx="${xCurrent}" cy="${cy}" r="5" fill="${pnlColor}" style="filter: drop-shadow(0 0 6px ${pnlColor})">
          <animate attributeName="r" values="5;6.5;5" dur="1.6s" repeatCount="indefinite"/>
        </circle>
        <text x="${xCurrent}" y="${cy-10}" text-anchor="middle" font-size="9" fill="${pnlColor}" font-family="Share Tech Mono, monospace" font-weight="700" style="filter: drop-shadow(0 0 4px ${pnlColor})">$${current.toFixed(2)}</text>
      </svg>`;

    return `<div class="position-card">
      <div class="pos-head">
        <div>
          <span class="pos-symbol">${esc(r.symbol || '—')}</span>
          <span class="pos-side" style="color:${sideColor};text-shadow:0 0 6px ${sideColor}">${sideArrow} ${(r.side || '?').toUpperCase()}</span>
        </div>
        <div class="pos-pnl" style="color:${pnlColor};text-shadow:0 0 8px ${pnlColor}">${inProfit ? '+' : ''}${pnlPct.toFixed(2)}%</div>
      </div>
      ${chartSvg}
      <div class="pos-meta">
        <span>QTY <strong>${r.shares ?? '—'}</strong></span>
        <span>RISK <strong>$${(r.riskUsd ?? 0).toFixed(2)}</strong></span>
        <span>TO STOP <strong>${stopDistPct.toFixed(1)}%</strong></span>
        <span>DAYS <strong>${daysOpen}</strong></span>
        <span>OPEN <strong>${esc(r.openDate || '—')}</strong></span>
      </div>
    </div>`;
  }).join('');

  return `<div class="position-grid">${cards}</div>`;
}

// ── Render: history rows ─────────────────────────────────────────────────
function renderHistoryTable(rows) {
  if (!rows.length) {
    return `<div class="hud-empty">// NO CLOSED TRADES YET // PAPER TRADING NOT INITIATED //</div>`;
  }
  const sorted = [...rows].sort((a, b) => new Date(b.closeDate || b.exitDate || 0) - new Date(a.closeDate || a.exitDate || 0));
  const body = sorted.slice(0, 50).map(r => {
    const pnl = r.realizedPnl ?? r.pnl ?? 0;
    const win = pnl > 0;
    const sideColor = (r.side === 'long' || r.side === 'LONG') ? '#39ff14' : '#ff1493';
    const pnlColor = win ? '#00ffff' : '#ff0044';
    return `<tr>
      <td>${esc(r.closeDate || r.exitDate || '—')}</td>
      <td class="sig-symbol">${esc(r.symbol || '—')}</td>
      <td style="color:${sideColor}">${(r.side || '?').toUpperCase()}</td>
      <td>$${(r.entryPrice ?? r.entry ?? 0).toFixed(2)}</td>
      <td>$${(r.exitPrice ?? r.exit ?? 0).toFixed(2)}</td>
      <td style="color:${pnlColor};text-shadow:0 0 6px ${pnlColor}">${fmtUSD(pnl)}</td>
      <td>${esc(r.exitReason || r.exit_reason || '—')}</td>
    </tr>`;
  }).join('');
  return `<table class="history-table">
    <thead><tr><th>DATE</th><th>SYMBOL</th><th>SIDE</th><th>ENTRY</th><th>EXIT</th><th>P&amp;L</th><th>REASON</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

// ── Render: heatmap (recycled SVG style from earlier) ────────────────────
function renderHeatmap() {
  if (!scanner?.tickers?.length) {
    return `<div class="hud-empty">// SCANNER OFFLINE // RUN scan-sid.js TO REFRESH //</div>`;
  }
  // Render ALL tickers but tag EXCLUDED ones — CSS hides them by default,
  // a toggle button reveals them. This way the filter is reversible client-side.
  const excludedSet = new Set(
    (classification?.tickers || [])
      .filter(c => c.tier === 'EXCLUDED')
      .map(c => c.symbol)
  );
  const valid = scanner.tickers.filter(t => !t.error && t.rsi != null && t.score != null);
  if (!valid.length) {
    return `<div class="hud-empty">// NO ASSETS WITH DATA YET //</div>`;
  }
  // Geometry tuned for 113-ticker V2 universe (was 480 tall — too cramped).
  // Tickers cluster heavily in the top half (score 80-100), so we give the
  // upper region more room and apply a deterministic jitter so overlapping
  // dots become individually visible.
  const W = 900, H = 600, padL = 60, padR = 30, padT = 60, padB = 60;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xOf = rsi => padL + (Math.max(0, Math.min(100, rsi)) / 100) * innerW;
  const yOfBase = score => padT + (1 - Math.max(0, Math.min(100, score)) / 100) * innerH;

  const tierColor = (sym) => {
    const tier = classification?.tickers?.find(c => c.symbol === sym)?.tier;
    return tier === 'AUTO_TRADE' ? '#39ff14'
         : tier === 'MONITOR'    ? '#ffaa00'
         : tier === 'EXCLUDED'   ? '#ff0044'
         : '#00ffff';
  };

  const grid = [0, 25, 50, 75, 100].map(v => `
    <line x1="${xOf(v)}" y1="${padT}" x2="${xOf(v)}" y2="${padT + innerH}" stroke="#0a4a4a" stroke-width="0.5" opacity="0.6"/>
    <line x1="${padL}" y1="${yOfBase(v)}" x2="${padL + innerW}" y2="${yOfBase(v)}" stroke="#0a4a4a" stroke-width="0.5" opacity="0.6"/>
  `).join('');

  const refLines = `
    <line x1="${xOf(30)}" y1="${padT}" x2="${xOf(30)}" y2="${padT + innerH}" stroke="#39ff14" stroke-width="1" stroke-dasharray="4,4" opacity="0.5" style="filter: drop-shadow(0 0 4px #39ff14)"/>
    <line x1="${xOf(75)}" y1="${padT}" x2="${xOf(75)}" y2="${padT + innerH}" stroke="#ff1493" stroke-width="1" stroke-dasharray="4,4" opacity="0.5" style="filter: drop-shadow(0 0 4px #ff1493)"/>
  `;

  // Collision-resolving jitter: sort by score, walk through and offset any
  // dot whose base position is within `minDist` of the previous one.
  // Deterministic so the layout is stable across builds.
  const minDist = 18;
  const placed = [];
  const positioned = valid
    .slice()
    .sort((a, b) => (b.score - a.score) || (a.rsi - b.rsi))
    .map(t => {
      const x = xOf(t.rsi);
      let y = yOfBase(t.score);
      // Find an open vertical slot if another dot is too close in (x,y) space
      let attempt = 0;
      while (attempt < 12 && placed.some(p => Math.hypot(p.x - x, p.y - y) < minDist)) {
        // Alternate above / below
        y = yOfBase(t.score) + (attempt % 2 === 0 ? 1 : -1) * (minDist * Math.ceil((attempt + 1) / 2));
        attempt++;
      }
      placed.push({ x, y });
      return { ...t, x, y };
    });

  const dots = positioned.map(t => {
    const { x, y } = t;
    const color = tierColor(t.symbol);
    const isSignal = (t.status || '').startsWith('SIGNAL');
    const r = isSignal ? 12 : 7;  // Smaller non-signal dots reduce overlap
    const isExcluded = excludedSet.has(t.symbol);
    const tierLabel = classification?.tickers?.find(c => c.symbol === t.symbol)?.tier || 'UNCLASSIFIED';
    return `<g class="heatmap-dot" data-tier="${tierLabel}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="${isExcluded ? '0.2' : '0.4'}" stroke="${color}" stroke-width="1.5" style="filter: drop-shadow(0 0 ${isExcluded ? '4' : '8'}px ${color})">
        <title>${t.symbol} · ${t.status} · ${tierLabel} · RSI ${t.rsi.toFixed(1)} · Score ${t.score}</title>
      </circle>
      <text x="${x}" y="${y + 3}" text-anchor="middle" fill="#fff" font-size="${isSignal ? 8 : 7}" font-family="Share Tech Mono, monospace" font-weight="700" pointer-events="none">${t.symbol}</text>
    </g>`;
  }).join('');

  const axesLabels = `
    <text x="${padL + innerW / 2}" y="${H - 12}" text-anchor="middle" fill="#00ffff" font-size="11" font-family="Orbitron, monospace" style="filter: drop-shadow(0 0 4px #00ffff)">RSI(14)</text>
    <text x="18" y="${padT + innerH/2}" text-anchor="middle" fill="#00ffff" font-size="11" font-family="Orbitron, monospace" transform="rotate(-90 18 ${padT + innerH/2})" style="filter: drop-shadow(0 0 4px #00ffff)">TRADABILITY SCORE</text>
    <text x="${xOf(15)}" y="${padT + 18}" text-anchor="middle" fill="#39ff14" font-size="10" font-family="Orbitron, monospace" style="filter: drop-shadow(0 0 4px #39ff14)">OVERSOLD ◀</text>
    <text x="${xOf(85)}" y="${padT + 18}" text-anchor="middle" fill="#ff1493" font-size="10" font-family="Orbitron, monospace" style="filter: drop-shadow(0 0 4px #ff1493)">▶ OVERBOUGHT</text>
  `;

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#000;border:1px solid #1a4040;border-radius:4px">
    ${grid}
    ${refLines}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="#00ffff" stroke-width="1" opacity="0.6"/>
    <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="#00ffff" stroke-width="1" opacity="0.6"/>
    ${axesLabels}
    ${dots}
  </svg>`;
}

// ── Stat tiles ──────────────────────────────────────────────────────────
function statTile(label, value, color, subtitle = '') {
  return `<div class="stat-tile" style="--accent:${color}">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    ${subtitle ? `<div class="stat-sub">${subtitle}</div>` : ''}
  </div>`;
}

// ── Pie segments ────────────────────────────────────────────────────────
let donutSegments = [];
if (liveStats.total > 0) {
  donutSegments = [
    { value: liveStats.wins,   color: '#39ff14', label: 'WINS' },
    { value: liveStats.losses, color: '#ff0044', label: 'LOSSES' },
  ];
} else if (backtest) {
  const wTotal = backtest.results.reduce((s,r)=>s+r.all.wins,0);
  const lTotal = backtest.results.reduce((s,r)=>s+(r.all.total - r.all.wins),0);
  donutSegments = [
    { value: wTotal, color: '#39ff14', label: 'BACKTEST WINS' },
    { value: lTotal, color: '#ff0044', label: 'BACKTEST LOSSES' },
  ];
} else {
  donutSegments = [{ value: 1, color: '#1a4040', label: 'NO DATA' }];
}

// ── Generated timestamp ─────────────────────────────────────────────────
const generated = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const scanDate = scanner?.scanDate ? new Date(scanner.scanDate).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'no scan data';

// ── HTML ────────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SID // v${STRATEGY_VERSION} TERMINAL</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Share+Tech+Mono&family=Rajdhani:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #000;
    --bg-panel: #050818;
    --cyan: #00ffff;
    --magenta: #ff00ff;
    --green: #39ff14;
    --pink: #ff1493;
    --red: #ff0044;
    --amber: #ffaa00;
    --border: #1a4040;
    --border-glow: #00ffff33;
    --text: #c8e8ff;
    --text-dim: #6080a0;
    --text-data: #e0f8ff;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Rajdhani', -apple-system, sans-serif;
    font-size: 14px;
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* animated grid background */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      linear-gradient(rgba(0, 255, 255, 0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 255, 0.02) 1px, transparent 1px),
      radial-gradient(ellipse at 50% 0%, rgba(255, 0, 255, 0.08), transparent 60%),
      radial-gradient(ellipse at 100% 100%, rgba(0, 255, 255, 0.06), transparent 50%);
    background-size: 40px 40px, 40px 40px, auto, auto;
    pointer-events: none;
    z-index: 0;
  }

  /* scan lines */
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent 0px,
      transparent 2px,
      rgba(0, 255, 255, 0.015) 2px,
      rgba(0, 255, 255, 0.015) 4px
    );
    pointer-events: none;
    z-index: 1;
  }

  .container {
    position: relative;
    z-index: 2;
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 32px 48px;
  }

  /* ── HEADER ──────────────────────────────────────────── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 24px 28px;
    background: linear-gradient(180deg, rgba(0,255,255,0.04), transparent);
    border: 1px solid var(--border);
    border-radius: 4px;
    margin-bottom: 24px;
    position: relative;
  }
  header::before, header::after {
    content: '';
    position: absolute;
    width: 24px;
    height: 24px;
    border: 2px solid var(--cyan);
    box-shadow: 0 0 8px var(--cyan);
  }
  header::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  header::after  { bottom: -1px; right: -1px; border-left: none; border-top: none; }

  .brand {
    font-family: 'Orbitron', sans-serif;
    font-size: 28px;
    font-weight: 900;
    letter-spacing: 4px;
    color: var(--cyan);
    text-shadow: 0 0 12px var(--cyan), 0 0 24px rgba(0,255,255,0.4);
  }
  .brand-sub {
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    color: var(--magenta);
    letter-spacing: 2px;
    margin-top: 4px;
    text-shadow: 0 0 6px var(--magenta);
  }

  .live-status {
    display: flex;
    align-items: center;
    gap: 14px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 12px;
    color: var(--text-dim);
  }
  .live-dot {
    width: 10px; height: 10px;
    background: var(--green);
    border-radius: 50%;
    box-shadow: 0 0 10px var(--green), 0 0 20px var(--green);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }

  /* ── TABS ─────────────────────────────────────────────── */
  nav.tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .tab-btn {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-family: 'Orbitron', sans-serif;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 2px;
    padding: 14px 24px;
    cursor: pointer;
    position: relative;
    transition: color 0.2s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active {
    color: var(--cyan);
    text-shadow: 0 0 8px var(--cyan);
  }
  .tab-btn.active::after {
    content: '';
    position: absolute;
    bottom: -1px; left: 0; right: 0;
    height: 2px;
    background: var(--cyan);
    box-shadow: 0 0 12px var(--cyan), 0 0 20px var(--cyan);
  }
  .tab-pane { display: none; animation: fadein 0.3s ease; }
  .tab-pane.active { display: block; }
  @keyframes fadein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  /* ── PANELS ───────────────────────────────────────────── */
  .panel {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 20px;
    margin-bottom: 20px;
    position: relative;
  }
  .panel::before, .panel::after {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    border: 1.5px solid var(--cyan);
    opacity: 0.6;
  }
  .panel::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  .panel::after  { bottom: -1px; right: -1px; border-left: none; border-top: none; }

  .panel-title {
    font-family: 'Orbitron', sans-serif;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 3px;
    color: var(--cyan);
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
    text-shadow: 0 0 6px rgba(0,255,255,0.4);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .panel-title::before {
    content: '▸';
    color: var(--magenta);
    text-shadow: 0 0 6px var(--magenta);
  }

  /* ── STAT TILES ───────────────────────────────────────── */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  .stat-tile {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    padding: 16px 18px;
    border-radius: 4px;
    position: relative;
    overflow: hidden;
  }
  .stat-tile::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, transparent 60%, var(--accent) 200%);
    opacity: 0.08;
    pointer-events: none;
  }
  .stat-label {
    font-family: 'Share Tech Mono', monospace;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 2px;
    margin-bottom: 6px;
  }
  .stat-value {
    font-family: 'Orbitron', sans-serif;
    font-size: 26px;
    font-weight: 700;
    color: var(--accent);
    text-shadow: 0 0 8px var(--accent);
    letter-spacing: 1px;
  }
  .stat-sub {
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  /* ── TWO-COLUMN ───────────────────────────────────────── */
  .two-col {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 20px;
  }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }

  /* ── TABLES ───────────────────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-family: 'Share Tech Mono', monospace;
    font-size: 13px;
  }
  th {
    text-align: left;
    padding: 10px 12px;
    color: var(--text-dim);
    font-weight: 400;
    font-size: 10px;
    letter-spacing: 2px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 12px;
    border-bottom: 1px solid rgba(26, 64, 64, 0.4);
    color: var(--text-data);
  }
  tr.signal-row:hover, tr:hover td {
    background: rgba(0, 255, 255, 0.04);
  }
  .sig-arrow { font-size: 18px; width: 30px; }
  .sig-symbol { font-weight: 700; color: var(--cyan); letter-spacing: 1px; }
  .sig-state { font-size: 12px; letter-spacing: 1px; }
  .sig-rsi, .sig-price { font-variant-numeric: tabular-nums; }
  .sig-tier { font-size: 11px; letter-spacing: 1px; font-weight: 700; }

  .hud-empty {
    padding: 28px;
    text-align: center;
    color: var(--text-dim);
    font-family: 'Share Tech Mono', monospace;
    font-size: 12px;
    letter-spacing: 2px;
    border: 1px dashed var(--border);
    border-radius: 4px;
  }

  /* ── DONUT ────────────────────────────────────────────── */
  .donut-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .donut-legend {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }
  .legend-item {
    display: flex;
    justify-content: space-between;
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    color: var(--text);
  }
  .legend-swatch {
    display: inline-block;
    width: 10px; height: 10px;
    margin-right: 8px;
    vertical-align: middle;
    box-shadow: 0 0 6px currentColor;
  }

  /* ── DISCLAIMER ───────────────────────────────────────── */
  .disclaimer {
    margin-top: 32px;
    padding: 16px 20px;
    background: rgba(255, 0, 68, 0.04);
    border: 1px solid rgba(255, 0, 68, 0.2);
    border-radius: 4px;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.7;
    font-family: 'Share Tech Mono', monospace;
  }
  .disclaimer strong {
    color: var(--red);
    text-shadow: 0 0 6px var(--red);
    letter-spacing: 2px;
  }

  footer {
    margin-top: 24px;
    text-align: center;
    color: var(--text-dim);
    font-family: 'Share Tech Mono', monospace;
    font-size: 10px;
    letter-spacing: 2px;
  }

  /* ── BETA BANNER ───────────────────────────────────── */
  .beta-banner {
    background: linear-gradient(90deg, rgba(255,170,0,0.08), rgba(255,0,255,0.06), rgba(255,170,0,0.08));
    border: 1px solid var(--amber);
    border-left: 4px solid var(--amber);
    border-radius: 4px;
    padding: 12px 20px;
    margin-bottom: 20px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    color: var(--text);
    letter-spacing: 1px;
    line-height: 1.6;
    box-shadow: 0 0 14px rgba(255, 170, 0, 0.15);
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .beta-banner .badge {
    flex-shrink: 0;
    padding: 4px 10px;
    background: var(--amber);
    color: #000;
    font-family: 'Orbitron', sans-serif;
    font-weight: 900;
    font-size: 10px;
    letter-spacing: 3px;
    text-shadow: none;
    border-radius: 2px;
    box-shadow: 0 0 12px var(--amber);
  }
  .beta-banner .msg strong { color: var(--amber); }

  /* ── HEATMAP TOGGLE ───────────────────────────────── */
  .heatmap-controls {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
    gap: 10px;
  }
  .toggle-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 8px 16px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    letter-spacing: 2px;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.2s;
  }
  .toggle-btn:hover {
    border-color: var(--cyan);
    color: var(--cyan);
    box-shadow: 0 0 8px rgba(0,255,255,0.3);
  }
  .toggle-btn.active {
    background: rgba(0,255,255,0.1);
    border-color: var(--cyan);
    color: var(--cyan);
    text-shadow: 0 0 6px var(--cyan);
    box-shadow: 0 0 10px rgba(0,255,255,0.4);
  }
  .toggle-btn .state-on  { display: none; color: var(--green); }
  .toggle-btn .state-off { display: inline; color: var(--text-dim); }
  .toggle-btn.active .state-on  { display: inline; }
  .toggle-btn.active .state-off { display: none; }

  /* by default, hide EXCLUDED tier dots from heatmap — toggle reveals them */
  body:not(.show-excluded) .heatmap-dot[data-tier="EXCLUDED"] { display: none; }

  /* ── POSITION CARDS ─────────────────────────────────── */
  .position-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }
  .position-card {
    background: rgba(0, 255, 255, 0.02);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 14px 16px;
    position: relative;
  }
  .position-card::before {
    content: '';
    position: absolute;
    top: -1px; left: -1px;
    width: 12px; height: 12px;
    border-top: 1.5px solid var(--cyan);
    border-left: 1.5px solid var(--cyan);
    opacity: 0.7;
  }
  .pos-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 6px;
  }
  .pos-symbol {
    font-family: 'Orbitron', sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: var(--cyan);
    letter-spacing: 2px;
    text-shadow: 0 0 6px var(--cyan);
    margin-right: 12px;
  }
  .pos-side {
    font-family: 'Share Tech Mono', monospace;
    font-size: 12px;
    letter-spacing: 2px;
    font-weight: 700;
  }
  .pos-pnl {
    font-family: 'Orbitron', sans-serif;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 1px;
  }
  .position-chart {
    width: 100%;
    height: auto;
    margin: 8px 0 6px;
  }
  .pos-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px 14px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 10px;
    color: var(--text-dim);
    letter-spacing: 1px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
  }
  .pos-meta strong {
    color: var(--text);
    font-weight: 400;
    margin-left: 4px;
  }

  /* ── HEADER RIGHT (clock + toggle + status) ────────── */
  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .market-clock {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(0,255,255,0.05);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 11px;
    color: var(--text);
    letter-spacing: 1px;
  }
  .market-state-dot {
    width: 8px; height: 8px;
    background: var(--text-dim);
    border-radius: 50%;
    transition: all 0.3s;
  }
  .market-clock.open .market-state-dot {
    background: var(--green);
    box-shadow: 0 0 8px var(--green);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .market-clock.closed .market-state-dot {
    background: var(--amber);
    box-shadow: 0 0 8px var(--amber);
  }
  .market-clock.open .market-state-label { color: var(--green); }
  .market-clock.closed .market-state-label { color: var(--amber); }

  .theme-toggle {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 8px 10px;
    font-family: 'Share Tech Mono', monospace;
    font-size: 14px;
    cursor: pointer;
    border-radius: 2px;
    transition: all 0.2s;
    line-height: 1;
  }
  .theme-toggle:hover {
    border-color: var(--cyan);
    color: var(--cyan);
    box-shadow: 0 0 6px rgba(0,255,255,0.3);
  }
  body:not(.light-mode) .theme-icon-light { display: none; }
  body.light-mode       .theme-icon-dark  { display: none; }

  /* ── LIGHT MODE ───────────────────────────────────── */
  body.light-mode {
    --bg: #f5f3ee;
    --bg-panel: #ffffff;
    --cyan: #00838f;
    --magenta: #c2185b;
    --green: #2e7d32;
    --pink: #d81b60;
    --red: #d32f2f;
    --amber: #ed6c02;
    --border: #b0bec5;
    --border-glow: #00838f33;
    --text: #1a1a1a;
    --text-dim: #5a6e7c;
    --text-data: #0d2c40;
  }
  body.light-mode::before {
    background:
      linear-gradient(rgba(0, 131, 143, 0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 131, 143, 0.04) 1px, transparent 1px),
      radial-gradient(ellipse at 50% 0%, rgba(194, 24, 91, 0.05), transparent 60%);
  }
  body.light-mode::after {
    background: repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.015) 2px, rgba(0,0,0,0.015) 4px);
  }
  body.light-mode .brand,
  body.light-mode .pos-symbol,
  body.light-mode .panel-title {
    text-shadow: 0 0 1px var(--cyan);  /* lighter glow in light mode */
  }
</style>
</head>
<body>
${PAPER_TRADING_MODE ? `
<!-- PAPER TRADING BANNER -->
<div style="background:linear-gradient(90deg,#00ffff 0%,#ff1493 100%);color:#000;padding:10px 16px;font-family:'Courier New',monospace;font-weight:bold;font-size:13px;text-align:center;letter-spacing:2px;border-bottom:2px solid #00ffff;text-shadow:0 0 4px rgba(255,255,255,0.5);">
  ⚠ PAPER TRADING · V2 METHOD LAUNCH 2026-05-16 · NO REAL MONEY AT RISK · ALPACA PENDING ⚠
</div>` : ''}
<div class="container">

  <!-- HEADER -->
  <header>
    <div>
      <div class="brand">SID // v${STRATEGY_VERSION}${PAPER_TRADING_MODE ? ' <span style="color:#ff1493;font-size:0.55em;">[PAPER]</span>' : ''}</div>
      <div class="brand-sub">V2 METHOD · ${HEADLINE_BACKTEST_WR}% BACKTEST WR · ${HEADLINE_BACKTEST_CAGR}% CAGR · ${HEADLINE_MAX_DD}% MAX DD</div>
    </div>
    <div class="header-right">
      <div id="market-clock" class="market-clock">
        <span class="market-state-dot"></span>
        <span class="market-state-label">— · —</span>
      </div>
      <button id="theme-toggle" class="theme-toggle" title="Toggle light/dark mode">
        <span class="theme-icon-dark">◐</span>
        <span class="theme-icon-light">◑</span>
      </button>
      <div class="live-status">
        <span class="live-dot"></span>
        <span>SYS · ${esc(generated.slice(11, 19))}</span>
      </div>
    </div>
  </header>

  <!-- BETA BANNER -->
  <div class="beta-banner">
    <span class="badge">BETA</span>
    <div class="msg">
      <strong>SID v${STRATEGY_VERSION} is under active development.</strong> Currently in paper-trading validation phase.
      Features in progress: Telegram alerts · sentiment integration · Alpaca live trading · v2 scanner enhancements.
      Backtest results (77% WR) are over a 12-month bullish window; live performance will differ.
      <strong>Not financial advice.</strong>
    </div>
  </div>

  <!-- STAT TILES -->
  <div class="stat-grid">
    ${statTile('OPEN POSITIONS', String(open.length || 0), 'var(--cyan)', 'live')}
    ${statTile('CLOSED TRADES', String(liveStats.total), 'var(--magenta)', 'lifetime')}
    ${statTile('WIN RATE', liveStats.total ? fmtPct(liveStats.winRate) : fmtPct(HEADLINE_BACKTEST_WR), 'var(--green)', liveStats.total ? 'live' : 'backtest baseline')}
    ${statTile('NET P&L', liveStats.total ? fmtUSD(liveStats.netPnl) : '+$' + HEADLINE_BACKTEST_PNL, 'var(--green)', liveStats.total ? 'realized' : 'backtest 12mo')}
    ${statTile('AUTO_TRADE', String(byTier.AUTO_TRADE?.length || 0), 'var(--green)', 'auto-executing')}
    ${statTile('MONITOR', String(byTier.MONITOR?.length || 0), 'var(--amber)', 'manual review')}
  </div>

  <!-- TABS -->
  <nav class="tabs">
    <button class="tab-btn active" data-tab="signals">▰ LIVE SIGNALS</button>
    <button class="tab-btn"        data-tab="history">▰ TRADE HISTORY</button>
    <button class="tab-btn"        data-tab="heatmap">▰ HEATMAP</button>
  </nav>

  <!-- TAB: SIGNALS -->
  <div id="tab-signals" class="tab-pane active">
    <!-- Open positions full-width at the top -->
    <div class="panel">
      <div class="panel-title">OPEN POSITIONS // CURRENTLY HELD (${open.length})</div>
      ${renderOpenPositionsCards(open)}
    </div>

    <div class="two-col">
      <div>
        <div class="panel">
          <div class="panel-title">ACTIVE SIGNALS // READY TO ARM OR ENTER</div>
          ${renderSignalsTable(liveSignals, 'Active', '// NO ACTIVE SIGNALS // SCANNER LAST RAN: ' + scanDate + ' //')}
        </div>
        <div class="panel">
          <div class="panel-title">APPROACHING ZONE // WITHIN 5 PTS OF TRIGGER</div>
          ${renderSignalsTable(approaching, 'Approaching', '// NO TICKERS APPROACHING THRESHOLD //')}
        </div>
      </div>
      <div>
        <div class="panel">
          <div class="panel-title">PERFORMANCE</div>
          <div class="donut-wrap">
            ${donutChart(donutSegments)}
            <div class="donut-legend">
              ${donutSegments.map(s => `<div class="legend-item"><span><span class="legend-swatch" style="background:${s.color};color:${s.color}"></span>${s.label}</span><span style="color:${s.color}">${s.value}</span></div>`).join('')}
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-title">CLASSIFICATION</div>
          <div style="display:flex;flex-direction:column;gap:10px;font-family:'Share Tech Mono', monospace;font-size:12px">
            <div style="display:flex;justify-content:space-between"><span style="color:var(--green)">▰ AUTO_TRADE</span><span>${byTier.AUTO_TRADE?.length || 0}</span></div>
            <div style="display:flex;justify-content:space-between"><span style="color:var(--amber)">▰ MONITOR</span><span>${byTier.MONITOR?.length || 0}</span></div>
            <div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">▰ INSUFFICIENT</span><span>${byTier.INSUFFICIENT_DATA?.length || 0}</span></div>
            <div style="display:flex;justify-content:space-between"><span style="color:var(--red)">▰ EXCLUDED</span><span>${byTier.EXCLUDED?.length || 0}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB: HISTORY -->
  <div id="tab-history" class="tab-pane">
    <div class="panel">
      <div class="panel-title">CLOSED TRADES // CHRONOLOGICAL</div>
      ${renderHistoryTable(closedArr)}
    </div>
  </div>

  <!-- TAB: HEATMAP -->
  <div id="tab-heatmap" class="tab-pane">
    <div class="panel">
      <div class="panel-title">RSI × TRADABILITY SCATTER // APPROVED ASSETS</div>
      <div class="heatmap-controls">
        <button id="toggle-excluded" class="toggle-btn">
          <span class="state-off">▢ SHOW EXCLUDED</span>
          <span class="state-on">▣ EXCLUDED VISIBLE</span>
        </button>
      </div>
      ${renderHeatmap()}
      <div style="margin-top:14px;display:flex;gap:20px;font-family:'Share Tech Mono', monospace;font-size:11px;flex-wrap:wrap;color:var(--text-dim)">
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--green);box-shadow:0 0 6px var(--green);margin-right:6px"></span>AUTO_TRADE</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--amber);box-shadow:0 0 6px var(--amber);margin-right:6px"></span>MONITOR</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--cyan);box-shadow:0 0 6px var(--cyan);margin-right:6px"></span>INSUFFICIENT_DATA · pending</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--red);box-shadow:0 0 6px var(--red);margin-right:6px"></span>EXCLUDED · hidden by default</span>
      </div>
    </div>
  </div>

  <!-- DISCLAIMER -->
  <div class="disclaimer">
    <strong>// CAUTION:</strong> SID is a private swing-trading strategy. Backtest performance is not a guarantee of future results. The 77% win rate is over a 26-trade sample in a 12-month bullish window; live performance will differ. All trades carry risk of total loss. Position sizing is at 2% of account per trade — never exceed without recalculating drawdown impact. Earnings within 14 days, weekly trend reversals, and macro events can invalidate signals. This dashboard is not financial advice. Trade only what you can afford to lose.
  </div>

  <footer>SID v${STRATEGY_VERSION} // PRIVATE TERMINAL // GENERATED ${esc(generated)}</footer>

</div>

<script>
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // Toggle EXCLUDED visibility on heatmap
  const toggleBtn = document.getElementById('toggle-excluded');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('show-excluded');
      toggleBtn.classList.toggle('active');
    });
  }

  // Theme toggle (dark <-> light)
  const themeBtn = document.getElementById('theme-toggle');
  function applyTheme(t) {
    if (t === 'light') document.body.classList.add('light-mode');
    else document.body.classList.remove('light-mode');
  }
  applyTheme(localStorage.getItem('sid-theme') || 'dark');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light-mode');
      localStorage.setItem('sid-theme', isLight ? 'light' : 'dark');
    });
  }

  // Market hours clock (US Eastern, 09:30–16:00 ET, Mon–Fri)
  // Uses Intl.DateTimeFormat for reliable ET conversion regardless of viewer's TZ
  function getETParts() {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    });
    const parts = {};
    for (const p of fmt.formatToParts(new Date())) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    return parts;
  }
  function fmtCountdown(ms) {
    if (ms <= 0) return '0s';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }
  function updateMarketClock() {
    const el = document.getElementById('market-clock');
    if (!el) return;
    const p = getETParts();
    const weekday = p.weekday;
    const hour = parseInt(p.hour, 10);
    const minute = parseInt(p.minute, 10);
    const second = parseInt(p.second, 10);
    const isWeekday = ['Mon','Tue','Wed','Thu','Fri'].includes(weekday);
    const minutesIntoDay = hour * 60 + minute;
    const openMin = 9 * 60 + 30;
    const closeMin = 16 * 60;
    const label = el.querySelector('.market-state-label');

    if (isWeekday && minutesIntoDay >= openMin && minutesIntoDay < closeMin) {
      // Market OPEN — countdown to close
      const closeMs = ((closeMin - minutesIntoDay) * 60 - second) * 1000;
      el.classList.remove('closed'); el.classList.add('open');
      label.textContent = 'MARKET OPEN · CLOSES IN ' + fmtCountdown(closeMs);
    } else {
      // Market CLOSED — compute next open
      let daysAhead = 0;
      const dayOrder = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      let dayIdx = dayOrder.indexOf(weekday);
      // If past close today AND it's a weekday, next day is +1 (unless Friday → +3)
      // If pre-market on weekday, daysAhead stays 0
      if (isWeekday && minutesIntoDay >= closeMin) {
        daysAhead = (weekday === 'Fri') ? 3 : 1;
      } else if (!isWeekday) {
        // Sat -> Mon (+2), Sun -> Mon (+1)
        daysAhead = (weekday === 'Sat') ? 2 : 1;
      }
      // Time remaining today (until midnight ET) + full days until next open (until 9:30 of target day)
      const minsLeftToday = (24 * 60) - minutesIntoDay;
      const totalMinsToOpen = (daysAhead > 0 ? minsLeftToday : 0) + (daysAhead > 0 ? (daysAhead - 1) * 24 * 60 : 0) + (daysAhead > 0 ? openMin : (openMin - minutesIntoDay));
      const totalMs = totalMinsToOpen * 60 * 1000 - second * 1000;
      el.classList.remove('open'); el.classList.add('closed');
      label.textContent = 'MARKET CLOSED · OPENS IN ' + fmtCountdown(totalMs);
    }
  }
  updateMarketClock();
  setInterval(updateMarketClock, 1000);
</script>

</body>
</html>`;

// ── Write output ─────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);

console.log('━━ SID Dashboard Build ━━');
console.log(`  Strategy version: v${STRATEGY_VERSION}`);
console.log(`  Closed trades:    ${liveStats.total}`);
console.log(`  Open positions:   ${open.length}`);
console.log(`  Live signals:     ${liveSignals.length}`);
console.log(`  Approaching:      ${approaching.length}`);
console.log(`  Output:           ${path.relative(ROOT, OUT)} (${sizeKB} KB)`);
