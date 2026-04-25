import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const BITGET_BASE        = 'https://api.bitget.com';

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

// Tokens always included in the watchlist regardless of daily research
const WATCHLIST = [
  // Crypto
  { token: 'BTC',     name: 'Bitcoin',      category: 'crypto',    pair: 'BTC/USDT',     note: 'Long-term watchlist' },
  { token: 'ETH',     name: 'Ethereum',     category: 'crypto',    pair: 'ETH/USDT',     note: 'Long-term watchlist' },
  { token: 'SOL',     name: 'Solana',       category: 'crypto',    pair: 'SOL/USDT',     note: 'Long-term watchlist' },
  { token: 'XRP',     name: 'XRP',          category: 'crypto',    pair: 'XRP/USDT',     note: 'Long-term watchlist' },
  { token: 'LINK',    name: 'Chainlink',    category: 'crypto',    pair: 'LINK/USDT',    note: 'Long-term watchlist' },
  { token: 'HYPE',    name: 'Hyperliquid',  category: 'crypto',    pair: 'HYPE/USDT',    note: 'Long-term watchlist' },
  { token: 'VIRTUAL', name: 'Virtual',      category: 'crypto',    pair: 'VIRTUAL/USDT', note: 'Long-term watchlist' },
  // DegenDave swing picks
  { token: 'APT',     name: 'Aptos',        category: 'crypto',    pair: 'APT/USDT',     note: 'DegenDave pick' },
  { token: 'ONDO',    name: 'Ondo Finance', category: 'crypto',    pair: 'ONDO/USDT',    note: 'DegenDave pick' },
  { token: 'JUP',     name: 'Jupiter',      category: 'crypto',    pair: 'JUP/USDT',     note: 'DegenDave pick' },
  // Stocks
  { token: 'AAPL',   name: 'Apple',        category: 'stock',     pair: 'AAPL/USDT',    note: 'Long-term watchlist' },
  { token: 'NVDA',   name: 'Nvidia',       category: 'stock',     pair: 'NVDA/USDT',    note: 'Long-term watchlist' },
  { token: 'GOOGL',  name: 'Alphabet',     category: 'stock',     pair: 'GOOGL/USDT',   note: 'Long-term watchlist' },
  // Commodities
  { token: 'XAU',    name: 'Gold',         category: 'commodity', pair: 'XAU/USDT',     note: 'Long-term watchlist' },
  { token: 'UKO',    name: 'Brent Crude',  category: 'commodity', pair: 'UKO/USD',      note: 'Long-term watchlist' },
];

// ── DegenDave / ChartHackers YouTube Transcript ──────────────────────────────

// ChartHackers channel ID — DegenDave posts every Thursday ~11pm UK time
// The Friday 8am UTC research run picks this up automatically
const CHARTHACKERS_CHANNEL_ID = 'UCybasP-2D2b5kTLAb_kvhWQ';
const CHARTHACKERS_RSS         = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHARTHACKERS_CHANNEL_ID}`;

// How far back to look for videos (10 days catches any late Thursday uploads)
const VIDEO_LOOKBACK_DAYS = 10;

async function fetchLatestChartHackersVideos() {
  try {
    console.log('Fetching ChartHackers RSS feed...');
    const res  = await fetch(CHARTHACKERS_RSS);
    const xml  = await res.text();

    // Parse entries from YouTube Atom feed using regex (no XML parser needed)
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);

    const cutoff  = Date.now() - VIDEO_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const videos  = [];

    for (const entry of entries) {
      const idMatch      = entry.match(/yt:videoId>([^<]+)/);
      const titleMatch   = entry.match(/<title>([^<]+)<\/title>/);
      const pubMatch     = entry.match(/<published>([^<]+)<\/published>/);
      if (!idMatch || !titleMatch || !pubMatch) continue;

      const published = new Date(pubMatch[1]);
      if (published.getTime() < cutoff) continue; // Too old

      videos.push({
        id:    idMatch[1].trim(),
        title: titleMatch[1].trim(),
        date:  pubMatch[1].slice(0, 10),
      });
    }

    if (videos.length) {
      console.log(`  Found ${videos.length} recent ChartHackers video(s):`);
      videos.forEach(v => console.log(`    • [${v.date}] ${v.title} (${v.id})`));
    } else {
      console.log(`  No ChartHackers videos in the last ${VIDEO_LOOKBACK_DAYS} days`);
    }

    return videos;
  } catch (err) {
    console.log(`  Could not fetch ChartHackers RSS: ${err.message}`);
    return [];
  }
}

// Fetch a YouTube transcript natively — no npm package needed.
// Parses the caption track URL directly from the video's player response.
async function fetchYouTubeTranscript(videoId) {
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await pageRes.text();

  // Pull out the embedded player JSON
  const jsonMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*(?:;|<\/script>)/s);
  if (!jsonMatch) throw new Error('ytInitialPlayerResponse not found in page');

  const player    = JSON.parse(jsonMatch[1]);
  const tracks    = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) throw new Error('No caption tracks available');

  // Prefer English captions (manual or auto-generated)
  const track = tracks.find(t => t.languageCode === 'en') ||
                tracks.find(t => t.languageCode?.startsWith('en')) ||
                tracks[0];

  // Fetch the raw XML caption file
  const captRes = await fetch(track.baseUrl);
  const captXml = await captRes.text();

  // Parse <text> nodes and decode HTML entities
  const text = [...captXml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map(m => m[1]
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&#39;/g,  "'")
      .replace(/&quot;/g, '"')
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}

async function fetchDegenDaveTranscript() {
  const videos  = await fetchLatestChartHackersVideos();
  const results = [];

  for (const video of videos) {
    try {
      console.log(`Fetching transcript: ${video.title} (${video.id})...`);
      const fullText = await fetchYouTubeTranscript(video.id);
      results.push({ ...video, transcript: fullText.slice(0, 8000) }); // Cap at 8k chars
      console.log(`  Got ${fullText.length} chars of transcript`);
    } catch (err) {
      console.log(`  Could not fetch transcript for ${video.id}: ${err.message}`);
    }
  }

  return results;
}

async function analyseDegenDaveTranscript(videos) {
  if (!videos.length) return [];
  const combined = videos.map(v => `Video: ${v.title}\nDate: ${v.date}\n\n${v.transcript}`).join('\n\n---\n\n');

  const prompt = `You are a crypto trading analyst. Below are transcripts from DegenDave (X: @DavidSendsIt) who appears on the ChartHackers YouTube channel. He is well respected for chart reading and swing trade analysis.

Analyse these transcripts and extract every crypto token or coin he mentions with a clear view on it.

Return ONLY valid JSON, no other text:
{
  "signals": [
    {
      "token": "BTC",
      "name": "Bitcoin",
      "category": "crypto",
      "signal": "bull",
      "risk": "medium",
      "reason": "one sentence describing his view",
      "source": "DegenDave / ChartHackers",
      "price_level": "optional key level mentioned e.g. $95000 resistance",
      "chart_pattern": "optional pattern e.g. bull flag, swing low, breakout"
    }
  ]
}

Rules:
- signal must be: "bull", "bear", or "neutral"
- risk must be: "low", "medium", or "high"
- Only include tokens where he gives a clear directional view
- Include price levels and chart patterns if mentioned
- If he mentions something is near a swing high or swing low, note it

Transcripts:
${combined}`;

  const res  = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'sonar-pro',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });

  const json    = await res.json();
  const content = json.choices?.[0]?.message?.content || '';
  const match   = content.match(/\{[\s\S]*\}/);
  if (!match) return [];

  const parsed = JSON.parse(match[0]);
  return (parsed.signals || []).map(s => ({ ...s, source: 'DegenDave / ChartHackers' }));
}

// ── Read local trade logs ─────────────────────────────────────────────────────

// Parse CSV using the header row so column changes never break parsing again
function parseCSV(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
    return lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj  = {};
      headers.forEach((h, i) => { obj[h] = vals[i]?.trim() ?? ''; });
      return obj;
    });
  } catch { return []; }
}

function readTrades() {
  const rows = parseCSV('./trades.csv');
  return rows.map(r => ({
    date:     r.date     || '',
    time:     r.time     || '',
    exchange: r.exchange || '',
    symbol:   r.symbol   || '',
    side:     r.side     || '',
    quantity: parseFloat(r.quantity)   || 0,
    price:    parseFloat(r.price || r.entry_price) || 0,
    stopLoss: parseFloat(r.stop_loss)  || null,
    takeProfit: parseFloat(r.take_profit || r.tp1) || null,
    rr:       parseFloat(r.rr || r.rr1) || null,
    totalUsd: parseFloat(r.total_usd)  || 0,
    fee:      r.fee      || '0',
    orderId:  r.order_id || r.orderId  || '',
    mode:     r.mode     || '',
    notes:    r.notes || r.strategy   || '',
  }));
}

// ── Fetch current live prices from BitGet for all traded symbols ──────────────

async function fetchLivePrices(symbols) {
  const prices = {};
  if (!symbols.length) return prices;
  try {
    const res  = await fetch(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
    const json = await res.json();
    for (const ticker of (json.data || [])) {
      const sym = ticker.symbol?.replace('_UMCBL', '');
      if (sym && symbols.includes(sym)) {
        prices[sym] = parseFloat(ticker.lastPr || ticker.close || 0);
      }
    }
  } catch { /* silently skip — P&L will show as — */ }
  return prices;
}

function readSafetyLog() {
  try {
    if (!fs.existsSync('./safety-check-log.json')) return [];
    return JSON.parse(fs.readFileSync('./safety-check-log.json', 'utf8'));
  } catch { return []; }
}

// Calculate estimated P&L for a single trade.
// Priority: live BitGet price → safety log → null (shows —)
function calcTradePnl(trade, safetyLog, livePrices = {}) {
  const LEVERAGE = 3;

  // 1. Use live price from BitGet ticker (most accurate)
  let currentPrice = livePrices[trade.symbol] || null;

  // 2. Fall back to most recent safety log entry for this symbol after trade time
  if (!currentPrice) {
    const tradeTs = `${trade.date}T${trade.time}`;
    const later   = safetyLog
      .filter(e => e.symbol === trade.symbol && e.timestamp > tradeTs && e.indicators?.price)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (later.length) currentPrice = later[0].indicators.price;
  }

  if (!currentPrice || !trade.price) return null;

  const pnl = trade.side === 'long'
    ? (currentPrice - trade.price) * trade.quantity * LEVERAGE
    : (trade.price - currentPrice) * trade.quantity * LEVERAGE;
  return { pnl, currentPrice };
}

function pnlCell(pnlResult) {
  if (pnlResult === null) return '<td style="color:#484f58">—</td>';
  const { pnl } = pnlResult;
  const color = pnl >= 0 ? '#3fb950' : '#f85149';
  const sign  = pnl >= 0 ? '+' : '';
  return `<td style="color:${color};font-weight:600">${sign}$${Math.abs(pnl).toFixed(2)}</td>`;
}

function buildTradeSection(trades, safetyLog, livePrices = {}) {
  const today       = new Date().toISOString().slice(0, 10);
  const todayTrades = trades.filter(t => t.date === today);
  const todayChecks = safetyLog.filter(e => e.timestamp?.startsWith(today));
  const passed      = todayChecks.filter(e => e.passed).length;
  const failed      = todayChecks.filter(e => !e.passed).length;

  // ── P&L for every trade (chronological order for cumulative calc) ──────────
  let cumulative = 0;
  let totalPnl   = 0;
  let wins = 0, losses = 0, bestTrade = 0, worstTrade = 0;

  const tradesWithPnl = trades.map(t => {
    const result = calcTradePnl(t, safetyLog, livePrices);
    let tradeP   = null;
    if (result !== null) {
      tradeP      = result.pnl;
      cumulative += result.pnl;
      totalPnl   += result.pnl;
      if (result.pnl >= 0) wins++;   else losses++;
      if (result.pnl > bestTrade)  bestTrade  = result.pnl;
      if (result.pnl < worstTrade) worstTrade = result.pnl;
    }
    return { ...t, tradePnl: tradeP, cumulativePnl: result !== null ? cumulative : null, currentPrice: result?.currentPrice };
  });

  // Today's P&L subset
  const todayPnl  = tradesWithPnl
    .filter(t => t.date === today && t.tradePnl !== null)
    .reduce((s, t) => s + t.tradePnl, 0);
  const todayWins = tradesWithPnl.filter(t => t.date === today && t.tradePnl !== null && t.tradePnl >= 0).length;
  const todayLoss = tradesWithPnl.filter(t => t.date === today && t.tradePnl !== null && t.tradePnl < 0).length;
  const winRate   = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;

  // All-time stats
  const totalVolume = trades.reduce((s, t) => s + (t.totalUsd || 0), 0);
  const totalFees   = trades.reduce((s, t) => s + (parseFloat(t.fee) || 0), 0);
  const paperCount  = trades.filter(t => t.mode === 'paper').length;
  const liveCount   = trades.filter(t => t.mode === 'live').length;

  // By symbol breakdown (with P&L)
  const bySymbol = {};
  tradesWithPnl.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, volume: 0, longs: 0, shorts: 0, pnl: 0, hasPnl: false };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].volume += t.totalUsd || 0;
    if (t.side === 'long')  bySymbol[t.symbol].longs++;
    if (t.side === 'short') bySymbol[t.symbol].shorts++;
    if (t.tradePnl !== null) { bySymbol[t.symbol].pnl += t.tradePnl; bySymbol[t.symbol].hasPnl = true; }
  });

  // Recommendations based on failed checks
  const failReasons = {};
  todayChecks.filter(e => !e.passed).forEach(e => {
    (e.reasons || []).forEach(r => { failReasons[r] = (failReasons[r] || 0) + 1; });
  });
  const recommendations = Object.entries(failReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      let tip = '';
      if (reason.includes('VWAP'))          tip = 'Consider widening the VWAP distance threshold or switching to a shorter timeframe during volatile sessions';
      else if (reason.includes('trending')) tip = 'Market is trending — Ironclad swing strategy will handle this. VWAP scalper correctly sitting out';
      else if (reason.includes('RSI'))      tip = 'RSI3 is staying mid-range — market may be consolidating. Consider sitting out until a clear reversal signal';
      else if (reason.includes('directional')) tip = 'No clear signal detected — market may be choppy. This is correct behaviour';
      else tip = 'Review strategy conditions — this rule is blocking most trades';
      return `<li><strong>${reason}</strong> (${count}× today)<br><span class="tip">💡 ${tip}</span></li>`;
    }).join('');

  // Today's trade rows (with P&L)
  const todayTradeRows = todayTrades.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:#8b949e;padding:20px">No trades executed today</td></tr>'
    : tradesWithPnl.filter(t => t.date === today).map(t => {
        const modeLabel = t.mode === 'paper'
          ? '<span style="color:#d29922">📄 Paper</span>'
          : '<span style="color:#3fb950">💰 Live</span>';
        return `<tr>
          <td>${t.time}</td>
          <td>${t.symbol}</td>
          <td>${t.side === 'long' ? '🟢 Long' : '🔴 Short'}</td>
          <td>$${t.price?.toFixed(2)}</td>
          <td>${t.currentPrice ? '$' + t.currentPrice.toFixed(2) : '—'}</td>
          <td>${t.quantity}</td>
          ${pnlCell(t.tradePnl !== null ? { pnl: t.tradePnl } : null)}
          <td>${modeLabel}</td>
        </tr>`;
      }).join('');

  // All trades history — most recent first, with P&L and cumulative
  const recentTrades = [...tradesWithPnl].reverse().slice(0, 50);
  const allTradeRows = recentTrades.length === 0
    ? '<tr><td colspan="10" style="text-align:center;color:#8b949e;padding:20px">No trades recorded yet — bot is running in safety-check mode</td></tr>'
    : recentTrades.map(t => {
        const modeLabel = t.mode === 'paper'
          ? '<span style="color:#d29922">📄 Paper</span>'
          : '<span style="color:#3fb950">💰 Live</span>';
        const cumColor  = t.cumulativePnl === null ? '#484f58' : t.cumulativePnl >= 0 ? '#3fb950' : '#f85149';
        const cumLabel  = t.cumulativePnl === null ? '—' : `${t.cumulativePnl >= 0 ? '+' : ''}$${Math.abs(t.cumulativePnl).toFixed(2)}`;
        return `<tr>
          <td>${t.date}</td>
          <td>${t.time}</td>
          <td>${t.symbol}</td>
          <td>${t.side === 'long' ? '🟢 Long' : '🔴 Short'}</td>
          <td>$${t.price?.toFixed(2)}</td>
          <td>${t.currentPrice ? '$' + t.currentPrice.toFixed(2) : '—'}</td>
          <td>${t.quantity}</td>
          ${pnlCell(t.tradePnl !== null ? { pnl: t.tradePnl } : null)}
          <td style="color:${cumColor};font-weight:600">${cumLabel}</td>
          <td>${modeLabel}</td>
        </tr>`;
      }).join('');

  // Symbol breakdown rows (with P&L)
  const symbolRows = Object.entries(bySymbol)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([sym, d]) => {
      const pnlColor = d.pnl >= 0 ? '#3fb950' : '#f85149';
      const pnlStr   = d.hasPnl ? `<span style="color:${pnlColor}">${d.pnl >= 0 ? '+' : ''}$${Math.abs(d.pnl).toFixed(2)}</span>` : '—';
      return `<tr>
        <td>${sym}</td>
        <td>${d.count}</td>
        <td>${d.longs}</td>
        <td>${d.shorts}</td>
        <td>$${d.volume.toFixed(2)}</td>
        <td>${pnlStr}</td>
      </tr>`;
    }).join('');

  // Summary colour helpers
  const todayPnlColor = todayPnl >= 0 ? '#3fb950' : '#f85149';
  const totalPnlColor = totalPnl >= 0 ? '#3fb950' : '#f85149';
  const bestColor     = '#3fb950';
  const worstColor    = '#f85149';

  return `
  <!-- ── Today's Activity ── -->
  <h2 style="margin:32px 0 16px;font-size:16px;color:#e6edf3">🤖 Today's Bot Activity</h2>

  <div class="stats">
    <div class="stat"><div class="num" style="color:#3fb950">${passed}</div><div class="label">Checks Passed</div></div>
    <div class="stat"><div class="num" style="color:#f85149">${failed}</div><div class="label">Checks Failed</div></div>
    <div class="stat"><div class="num" style="color:#58a6ff">${todayTrades.length}</div><div class="label">Trades Today</div></div>
    <div class="stat"><div class="num" style="color:${todayPnlColor}">${todayPnl >= 0 ? '+' : ''}$${Math.abs(todayPnl).toFixed(2)}</div><div class="label">Today's P&L (est.)</div></div>
    <div class="stat"><div class="num" style="color:#3fb950">${todayWins}</div><div class="label">Wins Today</div></div>
    <div class="stat"><div class="num" style="color:#f85149">${todayLoss}</div><div class="label">Losses Today</div></div>
  </div>

  <table style="margin-bottom:24px">
    <thead>
      <tr>
        <th>Time</th><th>Symbol</th><th>Side</th>
        <th>Entry</th><th>Current</th><th>Qty</th><th>P&amp;L (est.)</th><th>Mode</th>
      </tr>
    </thead>
    <tbody>${todayTradeRows}</tbody>
  </table>

  ${recommendations ? `
  <h2 style="margin:0 0 16px;font-size:16px;color:#e6edf3">💡 Why Checks Are Failing</h2>
  <div class="summary">
    <ul style="padding-left:20px;line-height:2">${recommendations}</ul>
  </div>` : ''}

  <!-- ── All-Time Summary ── -->
  <h2 style="margin:32px 0 16px;font-size:16px;color:#e6edf3">📈 All-Time Trade Summary</h2>

  <div class="stats">
    <div class="stat"><div class="num" style="color:#58a6ff">${trades.length}</div><div class="label">Total Trades</div></div>
    <div class="stat"><div class="num" style="color:${totalPnlColor}">${totalPnl >= 0 ? '+' : ''}$${Math.abs(totalPnl).toFixed(2)}</div><div class="label">Total P&amp;L (est.)</div></div>
    <div class="stat"><div class="num" style="color:#3fb950">${wins}</div><div class="label">Wins</div></div>
    <div class="stat"><div class="num" style="color:#f85149">${losses}</div><div class="label">Losses</div></div>
    <div class="stat"><div class="num" style="color:#e6edf3">${winRate}%</div><div class="label">Win Rate</div></div>
    <div class="stat"><div class="num" style="color:${bestColor}">+$${Math.abs(bestTrade).toFixed(2)}</div><div class="label">Best Trade</div></div>
    <div class="stat"><div class="num" style="color:${worstColor}">-$${Math.abs(worstTrade).toFixed(2)}</div><div class="label">Worst Trade</div></div>
    <div class="stat"><div class="num" style="color:#d29922">${paperCount}</div><div class="label">Paper</div></div>
    <div class="stat"><div class="num" style="color:#3fb950">${liveCount}</div><div class="label">Live</div></div>
  </div>

  ${Object.keys(bySymbol).length > 0 ? `
  <h3 style="margin:0 0 12px;font-size:14px;color:#8b949e;font-weight:500">By Symbol</h3>
  <table style="margin-bottom:24px">
    <thead><tr><th>Symbol</th><th>Trades</th><th>Longs</th><th>Shorts</th><th>Volume</th><th>P&amp;L (est.)</th></tr></thead>
    <tbody>${symbolRows}</tbody>
  </table>` : ''}

  <h3 style="margin:0 0 12px;font-size:14px;color:#8b949e;font-weight:500">Recent Trade Log ${trades.length > 50 ? '(last 50)' : ''}</h3>
  <table style="margin-bottom:24px">
    <thead>
      <tr>
        <th>Date</th><th>Time</th><th>Symbol</th><th>Side</th>
        <th>Entry</th><th>Current</th><th>Qty</th><th>P&amp;L (est.)</th><th>Cumulative</th><th>Mode</th>
      </tr>
    </thead>
    <tbody>${allTradeRows}</tbody>
  </table>`;
}

// ── Fetch available BitGet futures pairs ──────────────────────────────────────

async function fetchBitgetPairs() {
  try {
    const res  = await fetch(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
    const json = await res.json();
    return new Set((json.data || []).map(p => p.symbol.replace('_UMCBL', '').replace('USDT', '')));
  } catch {
    return new Set();
  }
}

// ── Query Perplexity for today's market signals ───────────────────────────────

async function fetchMarketResearch(date) {
  const prompt = `Today is ${date}. You are a financial market research analyst.

Search the web RIGHT NOW for the latest posts, videos, and commentary from top traders and analysts across crypto, forex, and commodities published TODAY or in the last 24 hours.

Focus on these sources if available:
- Crypto Banter (Ran Neuner and team)
- Michael van de Poppe
- Altcoin Daily
- Miles Deutscher
- Crypto Rover
- Forex Factory
- Bloomberg, Reuters market commentary
- Reddit: r/CryptoCurrency, r/Forex, r/investing
- Any other high-profile traders or analysts with significant following

For each token, coin, forex pair, commodity, or stock mentioned with a clear bullish or bearish view, extract it.

IMPORTANT: Always include today's sentiment for these specific tokens even if not widely discussed — search for them specifically: BTC, ETH, SOL, XRP, LINK (Chainlink), HYPE (Hyperliquid), VIRTUAL, AAPL (Apple), NVDA (Nvidia), GOOGL (Alphabet/Google), XAU (Gold), UKO (Brent Crude Oil).

Return ONLY a valid JSON object in this exact format, no other text:
{
  "summary": "2-3 sentence overview of today's market mood",
  "signals": [
    {
      "token": "BTC",
      "name": "Bitcoin",
      "category": "crypto",
      "signal": "bull",
      "risk": "low",
      "reason": "one sentence why",
      "source": "who said it"
    }
  ]
}

Rules:
- signal must be: "bull", "bear", or "neutral"
- risk must be: "low", "medium", or "high"
- category must be: "crypto", "forex", "commodity", or "stock"
- Include at least 10 tokens/pairs if possible
- Include a mix of crypto, forex, and commodities
- Keep reason to one clear sentence
- If sentiment is mixed, use "neutral"`;

  const res  = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'sonar-pro',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
    }),
  });

  const json    = await res.json();
  const content = json.choices?.[0]?.message?.content || '';

  // Extract JSON from response
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not parse Perplexity response: ${content.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ── Generate HTML dashboard ───────────────────────────────────────────────────

function signalBadge(signal) {
  if (signal === 'bull')    return '<span class="badge bull">🟢 Bull</span>';
  if (signal === 'bear')    return '<span class="badge bear">🔴 Bear</span>';
  return '<span class="badge neutral">🟡 Neutral</span>';
}

function riskBadge(risk) {
  if (risk === 'low')    return '<span class="risk low">Low</span>';
  if (risk === 'high')   return '<span class="risk high">High</span>';
  return '<span class="risk medium">Medium</span>';
}

function categoryBadge(cat) {
  const map = { crypto: '🪙', forex: '💱', commodity: '🛢️', stock: '📈' };
  return map[cat] || '📊';
}

function generateHTML(date, summary, signals, bitgetPairs, tradeSection) {
  // Watchlist rows — always shown, pinned at top
  const watchlistTokens = new Set(WATCHLIST.map(w => w.token.toUpperCase()));
  const watchlistSignals = WATCHLIST.map(w => {
    const found    = signals.find(s => s.token.toUpperCase() === w.token.toUpperCase());
    const onBitget = bitgetPairs.has(w.token.toUpperCase());
    const tradable = onBitget
      ? '<span class="tradable yes">✅ Yes</span>'
      : '<span class="tradable no">❌ No</span>';
    return `
      <tr class="watchlist-row">
        <td>⭐ ${categoryBadge(w.category)} ${w.token}</td>
        <td>${w.name}</td>
        <td>${w.pair}</td>
        <td>${found ? signalBadge(found.signal) : '<span class="badge neutral">🟡 Pending</span>'}</td>
        <td>${found ? riskBadge(found.risk) : '<span class="risk medium">—</span>'}</td>
        <td>${tradable}</td>
        <td class="reason">${found ? found.reason : 'Awaiting today\'s signal'}</td>
        <td class="source">${found ? found.source : w.note}</td>
      </tr>`;
  }).join('');

  // Main signal rows — exclude tokens already in watchlist
  const rows = signals
    .filter(s => !watchlistTokens.has(s.token.toUpperCase()))
    .map(s => {
      const onBitget = bitgetPairs.has(s.token.toUpperCase());
      const tradable = onBitget
        ? '<span class="tradable yes">✅ Yes</span>'
        : '<span class="tradable no">❌ No</span>';
      const pair     = onBitget ? `${s.token.toUpperCase()}/USDT` : '—';
      return `
      <tr>
        <td>${categoryBadge(s.category)} ${s.token.toUpperCase()}</td>
        <td>${s.name}</td>
        <td>${pair}</td>
        <td>${signalBadge(s.signal)}</td>
        <td>${riskBadge(s.risk)}</td>
        <td>${tradable}</td>
        <td class="reason">${s.reason}</td>
        <td class="source">${s.source}</td>
      </tr>`;
    }).join('');

  const bulls   = signals.filter(s => s.signal === 'bull').length;
  const bears   = signals.filter(s => s.signal === 'bear').length;
  const neutral = signals.filter(s => s.signal === 'neutral').length;
  const tradable = signals.filter(s => bitgetPairs.has(s.token.toUpperCase())).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Market Research — ${date}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117;
      color: #e6edf3;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #30363d;
    }
    h1 { font-size: 22px; font-weight: 600; }
    .date { color: #8b949e; font-size: 14px; }
    .summary {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 24px;
      line-height: 1.6;
      color: #c9d1d9;
    }
    .stats {
      display: flex;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .stat {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px 20px;
      text-align: center;
      min-width: 100px;
    }
    .stat .num { font-size: 28px; font-weight: 700; }
    .stat .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .bull-num  { color: #3fb950; }
    .bear-num  { color: #f85149; }
    .neu-num   { color: #d29922; }
    .trade-num { color: #58a6ff; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #161b22;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #30363d;
    }
    th {
      background: #21262d;
      padding: 12px 14px;
      text-align: left;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #8b949e;
      border-bottom: 1px solid #30363d;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid #21262d;
      font-size: 14px;
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #1c2128; }
    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .bull    { background: #1a4a2e; color: #3fb950; }
    .bear    { background: #4a1a1a; color: #f85149; }
    .neutral { background: #3d3100; color: #d29922; }
    .risk {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }
    .risk.low    { background: #1a4a2e; color: #3fb950; }
    .risk.medium { background: #3d3100; color: #d29922; }
    .risk.high   { background: #4a1a1a; color: #f85149; }
    .tradable { font-size: 13px; }
    .tradable.yes { color: #3fb950; }
    .tradable.no  { color: #f85149; }
    .reason { color: #8b949e; font-size: 13px; max-width: 280px; }
    .source { color: #58a6ff; font-size: 12px; }
    .watchlist-row td { background: #1a1f2e; border-left: 3px solid #58a6ff; }
    .watchlist-row:hover td { background: #1f2535; }
    .tip { color: #8b949e; font-size: 13px; font-weight: 400; }
    footer {
      margin-top: 24px;
      text-align: center;
      color: #484f58;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>📊 Daily Market Research</h1>
      <div class="date">Generated ${date} · Powered by Perplexity Sonar Pro</div>
    </div>
    <div class="date">⏱ Updated 9am &amp; 6pm UK time daily</div>
  </header>

  <div class="summary">${summary}</div>

  <div class="stats">
    <div class="stat"><div class="num bull-num">${bulls}</div><div class="label">Bullish</div></div>
    <div class="stat"><div class="num bear-num">${bears}</div><div class="label">Bearish</div></div>
    <div class="stat"><div class="num neu-num">${neutral}</div><div class="label">Neutral</div></div>
    <div class="stat"><div class="num trade-num">${tradable}</div><div class="label">On BitGet</div></div>
    <div class="stat"><div class="num" style="color:#e6edf3">${signals.length}</div><div class="label">Total Signals</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Token</th>
        <th>Name</th>
        <th>BitGet Pair</th>
        <th>Signal</th>
        <th>Risk</th>
        <th>BitGet</th>
        <th>Reason</th>
        <th>Source</th>
      </tr>
    </thead>
    <tbody>${watchlistSignals}${rows}</tbody>
  </table>

  ${tradeSection}

  <footer>Data sourced from public trader commentary · Not financial advice · Paper trading mode active</footer>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const date = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/London'
  });

  console.log(`\n── Market Research ${new Date().toISOString()} ──`);
  console.log(`Fetching BitGet available pairs...`);
  const bitgetPairs = await fetchBitgetPairs();
  console.log(`Found ${bitgetPairs.size} BitGet futures pairs`);

  console.log(`Querying Perplexity for today's signals...`);
  const research = await fetchMarketResearch(date);
  console.log(`Got ${research.signals?.length || 0} signals from Perplexity`);

  // Fetch DegenDave transcript signals — auto-discovers latest ChartHackers video via RSS
  let degenDaveSignals = [];
  try {
    const videos = await fetchDegenDaveTranscript();
    if (videos.length) {
      degenDaveSignals = await analyseDegenDaveTranscript(videos);
      console.log(`Got ${degenDaveSignals.length} signals from DegenDave / ChartHackers`);
    }
  } catch (err) {
    console.log(`DegenDave fetch skipped: ${err.message}`);
  }

  // Merge signals — DegenDave signals take priority, then Perplexity
  const allSignalTokens = new Set();
  const signals = [];
  for (const s of [...degenDaveSignals, ...(research.signals || [])]) {
    if (!allSignalTokens.has(s.token?.toUpperCase())) {
      allSignalTokens.add(s.token?.toUpperCase());
      signals.push(s);
    }
  }

  // Log summary to console
  console.log(`\nMarket Summary: ${research.summary}`);
  console.log(`\nSignals:`);
  signals.forEach(s => {
    const onBitget = bitgetPairs.has(s.token.toUpperCase());
    console.log(`  ${s.token.padEnd(8)} ${s.signal.padEnd(8)} Risk:${s.risk.padEnd(8)} BitGet:${onBitget ? 'YES' : 'NO'}`);
  });

  // Read trade logs
  const trades    = readTrades();
  const safetyLog = readSafetyLog();

  // Fetch live prices for every symbol we've ever traded — gives accurate P&L
  // for all historical trades, not just ones with recent safety log entries
  const tradedSymbols = [...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const livePrices    = await fetchLivePrices(tradedSymbols);
  console.log(`Live prices fetched for: ${Object.keys(livePrices).join(', ') || 'none'}`);

  const tradeSection = buildTradeSection(trades, safetyLog, livePrices);

  // Save machine-readable signal file for the trading bots to read
  const signalFile = {
    generated:  new Date().toISOString(),
    date:       todayString(),
    summary:    research.summary,
    signals:    signals.map(s => ({
      token:         s.token?.toUpperCase(),
      name:          s.name,
      category:      s.category,
      signal:        s.signal,        // bull / bear / neutral
      risk:          s.risk,          // low / medium / high
      reason:        s.reason,
      source:        s.source,
      price_level:   s.price_level   || null,
      chart_pattern: s.chart_pattern || null,
      bitget:        bitgetPairs.has(s.token?.toUpperCase()),
    })),
  };
  fs.writeFileSync('./research-signals.json', JSON.stringify(signalFile, null, 2));
  console.log(`Signal file saved to research-signals.json (${signals.length} signals)`);

  // Generate and save HTML dashboard
  if (!fs.existsSync('./docs')) fs.mkdirSync('./docs');
  const html = generateHTML(date, research.summary, signals, bitgetPairs, tradeSection);
  fs.writeFileSync('./docs/index.html', html);
  console.log(`\nDashboard saved to docs/index.html`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
