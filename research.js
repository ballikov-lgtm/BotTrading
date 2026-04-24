import 'dotenv/config';
import fetch from 'node-fetch';
import fs from 'fs';
import { YoutubeTranscript } from 'youtube-transcript';

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const BITGET_BASE        = 'https://api.bitget.com';

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
  // Stocks
  { token: 'AAPL',   name: 'Apple',        category: 'stock',     pair: 'AAPL/USDT',    note: 'Long-term watchlist' },
  { token: 'NVDA',   name: 'Nvidia',       category: 'stock',     pair: 'NVDA/USDT',    note: 'Long-term watchlist' },
  { token: 'GOOGL',  name: 'Alphabet',     category: 'stock',     pair: 'GOOGL/USDT',   note: 'Long-term watchlist' },
  // Commodities
  { token: 'XAU',    name: 'Gold',         category: 'commodity', pair: 'XAU/USDT',     note: 'Long-term watchlist' },
  { token: 'UKO',    name: 'Brent Crude',  category: 'commodity', pair: 'UKO/USD',      note: 'Long-term watchlist' },
];

// ── DegenDave / ChartHackers YouTube Transcript ──────────────────────────────

// Known video IDs — updated manually or automatically when new videos are found
// DegenDave posts every Thursday on ChartHackers
const DEGENDAVE_VIDEOS = [
  { id: 'oAH36N9X7pA', title: 'Latest ChartHackers — DegenDave', date: '2026-04-22' },
];

async function fetchDegenDaveTranscript() {
  const results = [];
  for (const video of DEGENDAVE_VIDEOS) {
    try {
      console.log(`Fetching DegenDave transcript: ${video.id}...`);
      const transcript = await YoutubeTranscript.fetchTranscript(video.id);
      const fullText   = transcript.map(t => t.text).join(' ');
      results.push({ ...video, transcript: fullText.slice(0, 8000) }); // Limit size
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

function readTrades() {
  try {
    if (!fs.existsSync('./trades.csv')) return [];
    const lines = fs.readFileSync('./trades.csv', 'utf8').trim().split('\n');
    return lines.slice(1).filter(l => l.trim()).map(l => {
      const [date, time, exchange, symbol, side, quantity, price, totalUsd, fee, netAmount, orderId, mode, notes] = l.split(',');
      return { date, time, exchange, symbol, side, quantity: parseFloat(quantity), price: parseFloat(price), totalUsd: parseFloat(totalUsd), fee, netAmount: parseFloat(netAmount), orderId, mode, notes };
    });
  } catch { return []; }
}

function readSafetyLog() {
  try {
    if (!fs.existsSync('./safety-check-log.json')) return [];
    return JSON.parse(fs.readFileSync('./safety-check-log.json', 'utf8'));
  } catch { return []; }
}

function buildTradeSection(trades, safetyLog) {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades  = trades.filter(t => t.date === today);
  const todayChecks  = safetyLog.filter(e => e.timestamp?.startsWith(today));
  const passed  = todayChecks.filter(e => e.passed).length;
  const failed  = todayChecks.filter(e => !e.passed).length;

  // Win/loss — compare entry price vs most recent check price
  let winCount = 0, lossCount = 0, totalPnl = 0;
  todayTrades.forEach(t => {
    const latest = safetyLog.find(e => e.symbol === t.symbol && e.timestamp > `${t.date}T${t.time}`);
    if (latest?.indicators?.price) {
      const currentPrice = latest.indicators.price;
      const pnl = t.side === 'long'
        ? (currentPrice - t.price) * t.quantity * 3  // 3x leverage
        : (t.price - currentPrice) * t.quantity * 3;
      totalPnl += pnl;
      if (pnl >= 0) winCount++; else lossCount++;
    }
  });

  // Recommendations based on failed checks
  const failReasons = {};
  todayChecks.filter(e => !e.passed).forEach(e => {
    (e.reasons || []).forEach(r => {
      failReasons[r] = (failReasons[r] || 0) + 1;
    });
  });
  const recommendations = Object.entries(failReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      let tip = '';
      if (reason.includes('VWAP')) tip = 'Consider widening the VWAP distance threshold or switching to a shorter timeframe during volatile sessions';
      else if (reason.includes('RSI')) tip = 'RSI3 is staying mid-range — market may be trending. Consider adding a trend filter or adjusting RSI thresholds';
      else if (reason.includes('directional')) tip = 'No clear signal detected. Market may be consolidating — consider sitting out until a clear trend emerges';
      else tip = 'Review strategy conditions — this rule is blocking most trades';
      return `<li><strong>${reason}</strong> (${count}x today)<br><span class="tip">💡 ${tip}</span></li>`;
    }).join('');

  const tradeRows = todayTrades.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:#8b949e;padding:20px">No trades executed today</td></tr>'
    : todayTrades.map(t => {
        const modeLabel = t.mode === 'paper'
          ? '<span style="color:#d29922">📄 Paper</span>'
          : '<span style="color:#3fb950">💰 Live</span>';
        return `<tr>
          <td>${t.date}</td>
          <td>${t.time}</td>
          <td>${t.symbol}</td>
          <td>${t.side === 'long' ? '🟢 Long' : '🔴 Short'}</td>
          <td>$${t.price?.toFixed(2)}</td>
          <td>${t.quantity}</td>
          <td>$${t.totalUsd?.toFixed(2)}</td>
          <td>${modeLabel}</td>
        </tr>`;
      }).join('');

  const pnlColor  = totalPnl >= 0 ? '#3fb950' : '#f85149';
  const pnlSign   = totalPnl >= 0 ? '+' : '';
  const winRate   = (winCount + lossCount) > 0
    ? Math.round((winCount / (winCount + lossCount)) * 100)
    : 0;

  return `
  <h2 style="margin:32px 0 16px;font-size:16px;color:#e6edf3">🤖 Today's Bot Activity</h2>

  <div class="stats">
    <div class="stat"><div class="num" style="color:#3fb950">${passed}</div><div class="label">Checks Passed</div></div>
    <div class="stat"><div class="num" style="color:#f85149">${failed}</div><div class="label">Checks Failed</div></div>
    <div class="stat"><div class="num" style="color:#58a6ff">${todayTrades.length}</div><div class="label">Trades Taken</div></div>
    <div class="stat"><div class="num" style="color:${pnlColor}">${pnlSign}$${Math.abs(totalPnl).toFixed(2)}</div><div class="label">Unrealised P&L</div></div>
    <div class="stat"><div class="num" style="color:#e6edf3">${winRate}%</div><div class="label">Win Rate</div></div>
  </div>

  <table style="margin-bottom:24px">
    <thead>
      <tr>
        <th>Date</th><th>Time</th><th>Symbol</th><th>Side</th>
        <th>Entry Price</th><th>Quantity</th><th>Total</th><th>Mode</th>
      </tr>
    </thead>
    <tbody>${tradeRows}</tbody>
  </table>

  ${recommendations ? `
  <h2 style="margin:0 0 16px;font-size:16px;color:#e6edf3">💡 Recommendations to Improve Signal Quality</h2>
  <div class="summary">
    <ul style="padding-left:20px;line-height:2">${recommendations}</ul>
  </div>` : ''}`;
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
    <div class="date">⏱ Updates every morning at 9am UK time</div>
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

  // Fetch DegenDave transcript signals (runs every day, picks up latest video)
  const isThursday = new Date().getDay() === 4;
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
  const trades      = readTrades();
  const safetyLog   = readSafetyLog();
  const tradeSection = buildTradeSection(trades, safetyLog);

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
