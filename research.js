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
  const videos       = await fetchLatestChartHackersVideos();
  const withTranscript = [];
  const titleOnly      = [];

  for (const video of videos) {
    try {
      console.log(`Fetching transcript: ${video.title} (${video.id})...`);
      const fullText = await fetchYouTubeTranscript(video.id);
      withTranscript.push({ ...video, transcript: fullText.slice(0, 8000), titleOnly: false });
      console.log(`  Got ${fullText.length} chars of transcript`);
    } catch (err) {
      console.log(`  No transcript for ${video.id} (${err.message}) — will use title`);
      titleOnly.push({ ...video, transcript: null, titleOnly: true });
    }
  }

  // For videos where we only have the title, group them and let Perplexity
  // search for what DegenDave said, guided by the title as context.
  const results = [...withTranscript];
  if (titleOnly.length) {
    console.log(`  ${titleOnly.length} video(s) without transcript — using title-based analysis`);
    results.push(...titleOnly);
  }

  return results;
}

async function analyseDegenDaveTranscript(videos) {
  if (!videos.length) return [];

  // Separate full transcripts from title-only videos
  const fullVideos  = videos.filter(v => !v.titleOnly);
  const titleVideos = videos.filter(v => v.titleOnly);

  // For title-only videos, use Perplexity to search for what DegenDave discussed
  // in that video based on the title — better than nothing
  const titleContext = titleVideos.length
    ? `\n\nNote: For the following videos only the title is available (captions unavailable). Use your knowledge of DegenDave's style and the title to infer likely setups, or search for community discussion of these videos:\n` +
      titleVideos.map(v => `- [${v.date}] "${v.title}"`).join('\n')
    : '';

  const combined = fullVideos.length
    ? fullVideos.map(v => `Video: ${v.title}\nDate: ${v.date}\n\n${v.transcript}`).join('\n\n---\n\n')
    : '(No transcripts available — analyse based on video titles only)';

  const prompt = `You are a crypto trading analyst with access to real-time search. DegenDave (X: @DavidSendsIt) appears on the ChartHackers YouTube channel and is well respected for chart reading and swing trade analysis.

Analyse the content below and extract every crypto token or coin DegenDave mentions with a clear directional view. Where transcripts are unavailable, use Perplexity's real-time search to find community discussion of those videos (Reddit, Twitter/X, YouTube comments) to infer his views from the video title and date.${titleContext}

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

function mapTradeRow(r, botName) {
  return {
    date:       r.date     || '',
    time:       r.time     || '',
    exchange:   r.exchange || '',
    symbol:     r.symbol   || '',
    side:       r.side     || '',
    // SID uses "shares" column; VWAP uses "quantity"; Ironclad uses "quantity"
    quantity:   parseFloat(r.quantity || r.shares) || 0,
    // VWAP has "price", Ironclad has "entry_price", SID has "entry_price"
    price:      parseFloat(r.price || r.entry_price) || 0,
    stopLoss:   parseFloat(r.stop_loss)  || null,
    takeProfit: parseFloat(r.take_profit || r.tp1) || null,
    rr:         parseFloat(r.rr || r.rr1) || null,
    totalUsd:   parseFloat(r.total_usd)  || 0,
    fee:        r.fee      || '0',
    orderId:    r.order_id || r.orderId  || '',
    // Fallback mode detection — check Order ID prefix if the column is missing/wrong
    mode:       (() => {
      const m  = r.mode || '';
      if (m === 'paper' || m === 'live') return m;
      const id = r.order_id || r.orderId || '';
      return (id.startsWith('PAPER-') || id.startsWith('IRONCLAD-PAPER-') || id.startsWith('SID-PAPER-')) ? 'paper' : (m || 'paper');
    })(),
    notes:      r.notes || r.strategy || '',
    bot:        botName,
  };
}

function readTrades() {
  // Read all three bots' trade logs and merge into a single chronological list
  const vwapRows     = parseCSV('./trades.csv').map(r => mapTradeRow(r, 'VWAP Scalper'));
  const ironcladRows = parseCSV('./trades-ironclad.csv').map(r => mapTradeRow(r, 'Ironclad'));
  const sidRows      = parseCSV('./trades-sid.csv').map(r => mapTradeRow(r, 'SID'));

  return [...vwapRows, ...ironcladRows, ...sidRows].sort((a, b) => {
    const ta = `${a.date}T${a.time || '00:00:00'}`;
    const tb = `${b.date}T${b.time || '00:00:00'}`;
    return ta.localeCompare(tb);
  });
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

// Read realized P&L from all position monitors' closed-positions files.
// Returns a Map keyed by order ID → { realizedPnl, exitLevel, exitPrice, closeDate, outcome }
function readClosedPositions() {
  const map = new Map();
  const files = [
    './closed-positions-ironclad.json',
    './closed-positions-sid.json',
  ];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const positions = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const pos of positions) {
        map.set(pos.id, pos);
      }
    } catch {}
  }
  return map;
}

// Read SID account state for dashboard display
function readSidAccount() {
  try {
    if (fs.existsSync('./sid-account.json')) {
      return JSON.parse(fs.readFileSync('./sid-account.json', 'utf8'));
    }
  } catch {}
  return null;
}

// Calculate P&L for a single trade.
// Priority order:
//   1. Realized P&L from position monitor (locked-in — never changes)
//   2. Unrealized P&L from live BitGet price (changes with market)
//   3. Unrealized P&L from safety log (historical fallback)
function calcTradePnl(trade, safetyLog, livePrices = {}, closedPositions = new Map()) {
  const LEVERAGE = 3;

  // 1. Realized — use if the position monitor has already closed this trade
  const closed = closedPositions.get(trade.orderId);
  if (closed) {
    return {
      pnl:          closed.realizedPnl,
      currentPrice: closed.exitPrice,
      realized:     true,
      exitLevel:    closed.exitLevel,
      outcome:      closed.outcome,
    };
  }

  // 2. Unrealized — live BitGet ticker price
  let currentPrice = livePrices[trade.symbol] || null;

  // 3. Unrealized — safety log fallback
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
  return { pnl, currentPrice, realized: false };
}

function pnlCell(pnlResult) {
  if (pnlResult === null) return '<td style="color:#484f58">—</td>';
  const { pnl } = pnlResult;
  const color = pnl >= 0 ? '#3fb950' : '#f85149';
  const sign  = pnl >= 0 ? '+' : '';
  return `<td style="color:${color};font-weight:600">${sign}$${Math.abs(pnl).toFixed(2)}</td>`;
}

// ── Parse "Strategy Name vX.Y" into separate name + version parts ─────────────
// Handles new format ("VWAP Scalper v1.3", "Ironclad v1.2") and legacy strings

function parseStrategy(str) {
  if (!str) return { stratName: 'Unknown', stratVersion: '—' };
  // Match "Some Name v1.2" or "Some Name v1.2.3"
  const match = str.match(/^(.+?)\s+(v\d+\.\d+(?:\.\d+)?)$/);
  if (match) return { stratName: match[1].trim(), stratVersion: match[2] };
  // Legacy fallback — infer from keywords
  if (/ironclad/i.test(str))                    return { stratName: 'Ironclad',     stratVersion: 'v1.0' };
  if (/vwap|scalp|rsi|ema/i.test(str))          return { stratName: 'VWAP Scalper', stratVersion: 'v1.0' };
  return { stratName: str.slice(0, 30), stratVersion: '—' };
}

// ── Build all trade data — returns structured object for HTML generation ──────

function buildTradeData(trades, safetyLog, livePrices = {}, closedPositions = new Map(), sidAccount = null) {
  const today       = new Date().toISOString().slice(0, 10);
  const todayTrades = trades.filter(t => t.date === today);
  const todayChecks = safetyLog.filter(e => e.timestamp?.startsWith(today));
  const passed      = todayChecks.filter(e => e.passed).length;
  const failed      = todayChecks.filter(e => !e.passed).length;

  // Category lookup — strip USDT suffix and check against watchlist
  const watchlistCat = {};
  WATCHLIST.forEach(w => { watchlistCat[w.token.toUpperCase()] = w.category; });
  const getCategory = (symbol) => watchlistCat[symbol.replace(/USDT$/, '').toUpperCase()] || 'crypto';

  // P&L for every trade (in chronological order for cumulative running total)
  let cumulative = 0;
  let totalPnl   = 0;
  let wins = 0, losses = 0, bestTrade = 0, worstTrade = 0;

  const tradesWithPnl = trades.map(t => {
    const result   = calcTradePnl(t, safetyLog, livePrices, closedPositions);
    let tradePnl   = null;
    let cumPnl     = null;
    let realized   = false;
    let exitLevel  = null;
    let outcome    = null;
    if (result !== null) {
      tradePnl    = result.pnl;
      realized    = result.realized || false;
      exitLevel   = result.exitLevel || null;
      outcome     = result.outcome   || null;
      cumulative += result.pnl;
      cumPnl      = cumulative;
      totalPnl   += result.pnl;
      if (result.pnl >= 0) wins++; else losses++;
      if (result.pnl > bestTrade)  bestTrade  = result.pnl;
      if (result.pnl < worstTrade) worstTrade = result.pnl;
    }
    return {
      ...t,
      tradePnl,
      cumPnl,
      realized,
      exitLevel,
      outcome,
      currentPrice: result?.currentPrice,
      category:     getCategory(t.symbol),
      month:        t.date ? t.date.slice(0, 7) : '',
      token:        t.symbol.replace(/USDT$/, ''),
    };
  });

  // Today's subset
  const todayPnl  = tradesWithPnl.filter(t => t.date === today && t.tradePnl !== null).reduce((s, t) => s + t.tradePnl, 0);
  const todayWins = tradesWithPnl.filter(t => t.date === today && t.tradePnl !== null && t.tradePnl >= 0).length;
  const todayLoss = tradesWithPnl.filter(t => t.date === today && t.tradePnl !== null && t.tradePnl < 0).length;
  const winRate   = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;

  const totalVolume = trades.reduce((s, t) => s + (t.totalUsd || 0), 0);
  const paperCount  = trades.filter(t => t.mode === 'paper').length;
  const liveCount   = trades.filter(t => t.mode === 'live').length;

  // By symbol
  const bySymbol = {};
  tradesWithPnl.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, volume: 0, longs: 0, shorts: 0, pnl: 0, hasPnl: false };
    bySymbol[t.symbol].count++;
    bySymbol[t.symbol].volume += t.totalUsd || 0;
    if (t.side === 'long')  bySymbol[t.symbol].longs++;
    if (t.side === 'short') bySymbol[t.symbol].shorts++;
    if (t.tradePnl !== null) { bySymbol[t.symbol].pnl += t.tradePnl; bySymbol[t.symbol].hasPnl = true; }
  });

  // Fail reason recommendations
  const failReasons = {};
  todayChecks.filter(e => !e.passed).forEach(e => {
    (e.reasons || []).forEach(r => { failReasons[r] = (failReasons[r] || 0) + 1; });
  });
  const recommendations = Object.entries(failReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => {
      let tip = '';
      if (reason.includes('VWAP'))           tip = 'Consider widening the VWAP distance threshold or switching to a shorter timeframe during volatile sessions';
      else if (reason.includes('trending'))  tip = 'Market is trending — Ironclad swing strategy will handle this. VWAP scalper correctly sitting out';
      else if (reason.includes('RSI'))       tip = 'RSI3 is staying mid-range — market may be consolidating. Consider sitting out until a clear reversal signal';
      else if (reason.includes('directional')) tip = 'No clear signal detected — market may be choppy. This is correct behaviour';
      else                                   tip = 'Review strategy conditions — this rule is blocking most trades';
      return { reason, count, tip };
    });

  // Today's trade rows (HTML) for the quick widget on Tab 1
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

  return {
    today: {
      passed, failed,
      tradeCount: todayTrades.length,
      pnl: todayPnl, wins: todayWins, losses: todayLoss,
      tradeRows: todayTradeRows,
    },
    allTime: {
      total: trades.length, pnl: totalPnl, wins, losses, winRate,
      bestTrade, worstTrade, volume: totalVolume, paper: paperCount, live: liveCount,
    },
    bySymbol,
    recommendations,
    sidAccount,
    // JSON array embedded in HTML for client-side filtering + pagination
    tradesJson: tradesWithPnl.map(t => {
      const { stratName, stratVersion } = parseStrategy(t.notes);
      return {
        date:        t.date,
        time:        t.time,
        symbol:      t.symbol,
        token:       t.token,
        category:    t.category,
        month:       t.month,
        side:        t.side,
        entry:       t.price        || null,
        sl:          t.stopLoss     || null,
        current:     t.currentPrice || null,
        qty:         t.quantity,
        pnl:         t.tradePnl,
        cumPnl:      t.cumPnl,
        realized:    t.realized,
        exitLevel:   t.exitLevel,
        outcome:     t.outcome,
        mode:        t.mode,
        strategy:    t.notes        || '',
        stratName,
        stratVersion,
        bot:         t.bot          || '',
      };
    }),
  };
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
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });

  const json    = await res.json();
  const content = json.choices?.[0]?.message?.content || '';

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

function generateHTML(date, summary, signals, bitgetPairs, tradeData) {
  const td = tradeData.today;
  const at = tradeData.allTime;

  // ── Watchlist rows (pinned, always shown) ──────────────────────────────────
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

  // ── Additional signal rows (non-watchlist) ─────────────────────────────────
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

  const bulls    = signals.filter(s => s.signal === 'bull').length;
  const bears    = signals.filter(s => s.signal === 'bear').length;
  const neutral  = signals.filter(s => s.signal === 'neutral').length;
  const tradable = signals.filter(s => bitgetPairs.has(s.token.toUpperCase())).length;

  // ── Today's P&L colour ─────────────────────────────────────────────────────
  const todayPnlColor  = td.pnl  >= 0 ? '#3fb950' : '#f85149';
  const totalPnlColor  = at.pnl  >= 0 ? '#3fb950' : '#f85149';

  // ── Recommendations HTML ───────────────────────────────────────────────────
  const recommendationsHtml = tradeData.recommendations.length ? `
  <h2 style="margin:32px 0 16px;font-size:16px;color:#e6edf3">💡 Why Checks Are Failing</h2>
  <div class="summary">
    <ul style="padding-left:20px;line-height:2">
      ${tradeData.recommendations.map(r =>
        `<li><strong>${r.reason}</strong> (${r.count}× today)<br><span class="tip">💡 ${r.tip}</span></li>`
      ).join('')}
    </ul>
  </div>` : '';

  // ── By-symbol table rows ───────────────────────────────────────────────────
  const symbolRows = Object.entries(tradeData.bySymbol)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([sym, d]) => {
      const pnlColor = d.pnl >= 0 ? '#3fb950' : '#f85149';
      const pnlStr   = d.hasPnl
        ? `<span style="color:${pnlColor}">${d.pnl >= 0 ? '+' : ''}$${Math.abs(d.pnl).toFixed(2)}</span>`
        : '—';
      return `<tr>
        <td>${sym}</td>
        <td>${d.count}</td>
        <td>${d.longs}</td>
        <td>${d.shorts}</td>
        <td>$${d.volume.toFixed(2)}</td>
        <td>${pnlStr}</td>
      </tr>`;
    }).join('');

  // ── Embedded trade JSON for client-side filtering ──────────────────────────
  const tradesJsonStr = JSON.stringify(tradeData.tradesJson);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trading Dashboard — ${date}</title>
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
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #30363d;
    }
    h1 { font-size: 22px; font-weight: 600; }
    .date { color: #8b949e; font-size: 14px; }

    /* ── Tab navigation ── */
    .tab-nav {
      display: flex;
      gap: 4px;
      margin-bottom: 24px;
      border-bottom: 1px solid #30363d;
      padding-bottom: 0;
    }
    .tab-btn {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: #8b949e;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      padding: 10px 20px;
      margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover  { color: #e6edf3; }
    .tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    /* ── Shared components ── */
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
    .stat .num   { font-size: 28px; font-weight: 700; }
    .stat .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
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
    .tradable     { font-size: 13px; }
    .tradable.yes { color: #3fb950; }
    .tradable.no  { color: #f85149; }
    .reason { color: #8b949e; font-size: 13px; max-width: 280px; }
    .source { color: #58a6ff; font-size: 12px; }
    .watchlist-row td { background: #1a1f2e; border-left: 3px solid #58a6ff; }
    .watchlist-row:hover td { background: #1f2535; }
    .tip { color: #8b949e; font-size: 13px; font-weight: 400; }

    /* ── Filter bar ── */
    .filter-bar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 16px;
    }
    .filter-bar label {
      font-size: 12px;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .filter-bar select {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      font-size: 13px;
      padding: 6px 10px;
      cursor: pointer;
      min-width: 130px;
    }
    .filter-bar select:focus { outline: none; border-color: #58a6ff; }
    .btn-reset {
      background: none;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #8b949e;
      cursor: pointer;
      font-size: 13px;
      padding: 6px 12px;
      margin-left: auto;
      transition: color 0.15s, border-color 0.15s;
    }
    .btn-reset:hover { color: #e6edf3; border-color: #58a6ff; }

    /* ── Pagination ── */
    .pagination {
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      margin-top: 16px;
      padding-top: 16px;
    }
    .pagination button {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      cursor: pointer;
      font-size: 13px;
      min-width: 36px;
      padding: 5px 10px;
      transition: background 0.15s, border-color 0.15s;
    }
    .pagination button:hover:not(:disabled) { background: #21262d; border-color: #58a6ff; }
    .pagination button.active { background: #1f4477; border-color: #58a6ff; color: #58a6ff; font-weight: 600; }
    .pagination button:disabled { color: #484f58; cursor: default; }
    .pagination .ellipsis { color: #484f58; padding: 0 4px; }
    .pagination .page-info { color: #8b949e; font-size: 12px; margin-left: 8px; }

    footer {
      margin-top: 32px;
      text-align: center;
      color: #484f58;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>📊 Trading Dashboard</h1>
      <div class="date">Generated ${date} · Powered by Perplexity Sonar Pro</div>
    </div>
    <div class="date">⏱ Updated 9am &amp; 6pm UK time daily</div>
  </header>

  <!-- ── Tab Navigation ── -->
  <nav class="tab-nav">
    <button class="tab-btn active" data-tab="research">📊 Market Research</button>
    <button class="tab-btn"        data-tab="history">📈 Trade History</button>
  </nav>

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- TAB 1 — Market Research                                                -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <div id="tab-research" class="tab-pane active">

    <div class="summary">${summary}</div>

    <div class="stats">
      <div class="stat"><div class="num" style="color:#3fb950">${bulls}</div><div class="label">Bullish</div></div>
      <div class="stat"><div class="num" style="color:#f85149">${bears}</div><div class="label">Bearish</div></div>
      <div class="stat"><div class="num" style="color:#d29922">${neutral}</div><div class="label">Neutral</div></div>
      <div class="stat"><div class="num" style="color:#58a6ff">${tradable}</div><div class="label">On BitGet</div></div>
      <div class="stat"><div class="num" style="color:#e6edf3">${signals.length}</div><div class="label">Total Signals</div></div>
    </div>

    <table style="margin-bottom:32px">
      <thead>
        <tr>
          <th>Token</th><th>Name</th><th>BitGet Pair</th>
          <th>Signal</th><th>Risk</th><th>BitGet</th><th>Reason</th><th>Source</th>
        </tr>
      </thead>
      <tbody>${watchlistSignals}${rows}</tbody>
    </table>

    <!-- Today's Bot Activity widget -->
    <h2 style="margin:0 0 16px;font-size:16px;color:#e6edf3">🤖 Today's Bot Activity</h2>

    <div class="stats">
      <div class="stat"><div class="num" style="color:#3fb950">${td.passed}</div><div class="label">Checks Passed</div></div>
      <div class="stat"><div class="num" style="color:#f85149">${td.failed}</div><div class="label">Checks Failed</div></div>
      <div class="stat"><div class="num" style="color:#58a6ff">${td.tradeCount}</div><div class="label">Trades Today</div></div>
      <div class="stat"><div class="num" style="color:${todayPnlColor}">${td.pnl >= 0 ? '+' : ''}$${Math.abs(td.pnl).toFixed(2)}</div><div class="label">Today's P&amp;L (est.)</div></div>
      <div class="stat"><div class="num" style="color:#3fb950">${td.wins}</div><div class="label">Wins Today</div></div>
      <div class="stat"><div class="num" style="color:#f85149">${td.losses}</div><div class="label">Losses Today</div></div>
    </div>

    <table style="margin-bottom:24px">
      <thead>
        <tr>
          <th>Time</th><th>Symbol</th><th>Side</th>
          <th>Entry</th><th>Current</th><th>Qty</th><th>P&amp;L (est.)</th><th>Mode</th>
        </tr>
      </thead>
      <tbody>${td.tradeRows}</tbody>
    </table>

    ${recommendationsHtml}

  </div><!-- /tab-research -->

  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <!-- TAB 2 — Trade History                                                  -->
  <!-- ═══════════════════════════════════════════════════════════════════════ -->
  <div id="tab-history" class="tab-pane">

    <!-- All-time summary stats -->
    <h2 style="margin:0 0 16px;font-size:16px;color:#e6edf3">📈 All-Time Performance</h2>

    <div id="history-stats"><!-- populated by renderStats() on load and every filter change --></div>

    ${tradeData.sidAccount ? (() => {
      const sa        = tradeData.sidAccount;
      const growth    = sa.accountUsd - sa.startingUsd;
      const growthPct = ((growth / sa.startingUsd) * 100).toFixed(2);
      const color     = growth >= 0 ? '#3fb950' : '#f85149';
      return `
    <h3 style="margin:0 0 12px;font-size:14px;color:#8b949e;font-weight:500">📈 SID Compound Account</h3>
    <div class="stats" style="margin-bottom:32px">
      <div class="stat"><div class="num" style="color:#e6edf3">$${sa.startingUsd.toFixed(2)}</div><div class="label">Starting Capital</div></div>
      <div class="stat"><div class="num" style="color:${color}">$${sa.accountUsd.toFixed(2)}</div><div class="label">Current Balance</div></div>
      <div class="stat"><div class="num" style="color:${color}">${growth >= 0 ? '+' : ''}$${Math.abs(growth).toFixed(2)}</div><div class="label">Total Growth</div></div>
      <div class="stat"><div class="num" style="color:${color}">${growth >= 0 ? '+' : ''}${growthPct}%</div><div class="label">Return</div></div>
      <div class="stat"><div class="num" style="color:#58a6ff">${sa.tradeCount}</div><div class="label">Closed Trades</div></div>
    </div>`;
    })() : ''}

    ${Object.keys(tradeData.bySymbol).length > 0 ? `
    <h3 style="margin:0 0 12px;font-size:14px;color:#8b949e;font-weight:500">By Symbol</h3>
    <table style="margin-bottom:32px">
      <thead><tr><th>Symbol</th><th>Trades</th><th>Longs</th><th>Shorts</th><th>Volume</th><th>P&amp;L (est.)</th></tr></thead>
      <tbody>${symbolRows}</tbody>
    </table>` : ''}

    <!-- Filter bar -->
    <h3 style="margin:0 0 12px;font-size:14px;color:#8b949e;font-weight:500">Trade Log</h3>

    <div class="filter-bar">
      <label>Pair</label>
      <select id="filter-pair" onchange="onFilterChange()"><option value="">All Pairs</option></select>

      <label>Month</label>
      <select id="filter-month" onchange="onFilterChange()"><option value="">All Months</option></select>

      <label>Category</label>
      <select id="filter-category" onchange="onFilterChange()"><option value="">All Categories</option></select>

      <label>Strategy</label>
      <select id="filter-strategy" onchange="onFilterChange()"><option value="">All Strategies</option></select>

      <label>Version</label>
      <select id="filter-version" onchange="onFilterChange()"><option value="">All Versions</option></select>

      <label>Bot</label>
      <select id="filter-bot" onchange="onFilterChange()"><option value="">All Bots</option></select>

      <label>Mode</label>
      <select id="filter-mode" onchange="onFilterChange()">
        <option value="">All Modes</option>
        <option value="paper">Paper</option>
        <option value="live">Live</option>
      </select>

      <button class="btn-reset" onclick="resetFilters()">✕ Reset</button>
    </div>

    <table>
      <thead>
        <tr>
          <th>Date</th><th>Time</th><th>Symbol</th><th>Side</th>
          <th>Entry</th><th>Stop Loss</th><th>Exit / Live</th><th>Qty</th>
          <th>P&amp;L</th><th>Cumulative</th><th>Mode</th>
          <th>Bot</th><th>Strategy</th><th>Version</th>
        </tr>
      </thead>
      <tbody id="history-tbody">
        <tr><td colspan="14" style="text-align:center;color:#8b949e;padding:20px">Loading…</td></tr>
      </tbody>
    </table>

    <div id="pagination"></div>

  </div><!-- /tab-history -->

  <footer>Data sourced from public trader commentary · Not financial advice · Paper trading mode active</footer>

  <script>
    // ── Tab switching ─────────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    // ── Trade data (embedded at build time) ───────────────────────────────────
    const TRADES = ${tradesJsonStr};

    // ── Pagination state ──────────────────────────────────────────────────────
    const PAGE_SIZE = 25;
    let currentPage = 1;

    // ── Populate filter dropdowns from data ───────────────────────────────────
    function populateSelect(id, values, labelFn) {
      const sel = document.getElementById(id);
      const existing = sel.querySelector('option[value=""]');
      const placeholder = existing ? existing.textContent : '';
      sel.innerHTML = '<option value="">' + placeholder + '</option>' +
        [...values].sort().map(v => '<option value="' + v + '">' + (labelFn ? labelFn(v) : v) + '</option>').join('');
    }

    const catLabel = { crypto: '🪙 Crypto', stock: '📈 Stock', forex: '💱 Forex', commodity: '🛢️ Commodity' };

    populateSelect('filter-pair',     new Set(TRADES.map(t => t.symbol)));
    populateSelect('filter-month',    [...new Set(TRADES.map(t => t.month))].sort().reverse().reduce((s, v) => (s.add(v), s), new Set()));
    populateSelect('filter-category', new Set(TRADES.map(t => t.category)), v => catLabel[v] || v);
    populateSelect('filter-bot',      new Set(TRADES.map(t => t.bot).filter(Boolean)));
    populateSelect('filter-strategy', new Set(TRADES.map(t => t.stratName).filter(Boolean)));
    populateSelect('filter-version',  [...new Set(TRADES.map(t => t.stratVersion).filter(v => v && v !== '—'))].sort().reverse().reduce((s, v) => (s.add(v), s), new Set()));

    // ── Filtering logic ───────────────────────────────────────────────────────
    function getFiltered() {
      const pair     = document.getElementById('filter-pair').value;
      const month    = document.getElementById('filter-month').value;
      const category = document.getElementById('filter-category').value;
      const bot      = document.getElementById('filter-bot').value;
      const strategy = document.getElementById('filter-strategy').value;
      const version  = document.getElementById('filter-version').value;
      const mode     = document.getElementById('filter-mode').value;

      // Most recent first
      return [...TRADES].reverse().filter(t => {
        if (pair     && t.symbol       !== pair)     return false;
        if (month    && t.month        !== month)    return false;
        if (category && t.category     !== category) return false;
        if (bot      && t.bot          !== bot)      return false;
        if (strategy && t.stratName    !== strategy) return false;
        if (version  && t.stratVersion !== version)  return false;
        if (mode     && t.mode         !== mode)     return false;
        return true;
      });
    }

    // ── Render helpers ────────────────────────────────────────────────────────
    function fmtPnl(val, realized, exitLevel) {
      if (val === null || val === undefined) return '<span style="color:#484f58">—</span>';
      const color = val >= 0 ? '#3fb950' : '#f85149';
      const sign  = val >= 0 ? '+' : '';
      const label = realized
        ? '<span title="Realized — position closed at ' + (exitLevel || 'exit') + '" style="font-size:10px;opacity:0.7"> 🔒</span>'
        : '<span title="Unrealized — based on current live price" style="font-size:10px;opacity:0.5"> 📊</span>';
      return '<span style="color:' + color + ';font-weight:600">' + sign + '$' + Math.abs(val).toFixed(2) + label + '</span>';
    }

    const catIcon = { crypto: '🪙', stock: '📈', forex: '💱', commodity: '🛢️' };

    // ── Render table for current page ─────────────────────────────────────────
    function renderTable() {
      const filtered = getFiltered();
      const total    = filtered.length;
      const pages    = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (currentPage > pages) currentPage = pages;

      const start = (currentPage - 1) * PAGE_SIZE;
      const page  = filtered.slice(start, start + PAGE_SIZE);
      const tbody = document.getElementById('history-tbody');

      if (page.length === 0) {
        tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;color:#8b949e;padding:20px">No trades match the selected filters</td></tr>';
      } else {
        tbody.innerHTML = page.map(t => {
          const modeLabel = t.mode === 'paper'
            ? '<span style="color:#d29922">📄 Paper</span>'
            : '<span style="color:#3fb950">💰 Live</span>';
          const botColor  = t.bot === 'Ironclad' ? '#d29922' : '#58a6ff';

          // Exit / Live price cell — for closed trades show exit level badge
          let priceCell;
          if (t.realized && t.current) {
            const lvlColor = t.exitLevel === 'sl' ? '#f85149'
                           : t.exitLevel === 'tp3' ? '#3fb950'
                           : '#58a6ff';
            const lvlLabel = (t.exitLevel || 'exit').toUpperCase();
            priceCell = '<span style="color:#8b949e;font-size:11px">' + lvlLabel + ' </span>' +
                        '<span style="color:' + lvlColor + ';font-weight:600">$' + t.current.toFixed(2) + '</span>';
          } else if (t.current) {
            priceCell = '<span style="color:#8b949e;font-size:11px">live </span>$' + t.current.toFixed(2);
          } else {
            priceCell = '<span style="color:#484f58">—</span>';
          }

          return '<tr>' +
            '<td>' + t.date + '</td>' +
            '<td>' + t.time + '</td>' +
            '<td>' + (catIcon[t.category] || '📊') + ' ' + t.symbol + '</td>' +
            '<td>' + (t.side === 'long' ? '🟢 Long' : '🔴 Short') + '</td>' +
            '<td>$' + (t.entry ? t.entry.toFixed(2) : '—') + '</td>' +
            '<td style="color:#f85149;font-size:13px">' + (t.sl ? '$' + t.sl.toFixed(2) : '—') + '</td>' +
            '<td>' + priceCell + '</td>' +
            '<td style="color:#8b949e;font-size:13px">' + t.qty + '</td>' +
            '<td>' + fmtPnl(t.pnl, t.realized, t.exitLevel) + '</td>' +
            '<td>' + fmtPnl(t.cumPnl) + '</td>' +
            '<td>' + modeLabel + '</td>' +
            '<td style="font-size:13px;font-weight:500;color:' + botColor + '">' + (t.bot || '—') + '</td>' +
            '<td style="font-size:13px;color:#c9d1d9">' + (t.stratName || '—') + '</td>' +
            '<td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:#1f2d3d;color:#58a6ff">' + (t.stratVersion || '—') + '</span></td>' +
            '</tr>';
        }).join('');
      }

      renderPagination(pages, total);
    }

    // ── Pagination controls ───────────────────────────────────────────────────
    function renderPagination(pages, total) {
      const el = document.getElementById('pagination');
      if (pages <= 1) { el.innerHTML = ''; return; }

      let html = '<div class="pagination">';
      html += '<button onclick="goPage(' + (currentPage - 1) + ')"' + (currentPage <= 1 ? ' disabled' : '') + '>← Prev</button>';

      for (let i = 1; i <= pages; i++) {
        if (i === 1 || i === pages || Math.abs(i - currentPage) <= 2) {
          html += '<button onclick="goPage(' + i + ')"' + (i === currentPage ? ' class="active"' : '') + '>' + i + '</button>';
        } else if (Math.abs(i - currentPage) === 3) {
          html += '<span class="ellipsis">…</span>';
        }
      }

      html += '<button onclick="goPage(' + (currentPage + 1) + ')"' + (currentPage >= pages ? ' disabled' : '') + '>Next →</button>';
      html += '<span class="page-info">Page ' + currentPage + ' of ' + pages + ' · ' + total + ' trades</span>';
      html += '</div>';

      el.innerHTML = html;
    }

    function goPage(p) {
      const filtered = getFiltered();
      const pages    = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      currentPage    = Math.max(1, Math.min(p, pages));
      renderTable();
      document.querySelector('table').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ── Dynamic all-time stats (recalculates on every filter change) ──────────
    function renderStats(filteredTrades) {
      let total = filteredTrades.length;
      let pnl = 0, wins = 0, losses = 0, bestTrade = 0, worstTrade = 0;
      let paper = 0, live = 0;
      filteredTrades.forEach(t => {
        if (t.mode === 'paper') paper++; else if (t.mode === 'live') live++;
        if (t.pnl !== null && t.pnl !== undefined) {
          pnl += t.pnl;
          if (t.pnl >= 0) wins++; else losses++;
          if (t.pnl > bestTrade)  bestTrade  = t.pnl;
          if (t.pnl < worstTrade) worstTrade = t.pnl;
        }
      });
      const winRate  = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
      const pnlColor = pnl >= 0 ? '#3fb950' : '#f85149';
      const pnlSign  = pnl >= 0 ? '+' : '';
      document.getElementById('history-stats').innerHTML =
        '<div class="stats">' +
        '<div class="stat"><div class="num" style="color:#58a6ff">' + total + '</div><div class="label">Total Trades</div></div>' +
        '<div class="stat"><div class="num" style="color:' + pnlColor + '">' + pnlSign + '$' + Math.abs(pnl).toFixed(2) + '</div><div class="label">Total P&amp;L (est.)</div></div>' +
        '<div class="stat"><div class="num" style="color:#3fb950">' + wins + '</div><div class="label">Wins</div></div>' +
        '<div class="stat"><div class="num" style="color:#f85149">' + losses + '</div><div class="label">Losses</div></div>' +
        '<div class="stat"><div class="num" style="color:#e6edf3">' + winRate + '%</div><div class="label">Win Rate</div></div>' +
        '<div class="stat"><div class="num" style="color:#3fb950">+$' + Math.abs(bestTrade).toFixed(2) + '</div><div class="label">Best Trade</div></div>' +
        '<div class="stat"><div class="num" style="color:#f85149">-$' + Math.abs(worstTrade).toFixed(2) + '</div><div class="label">Worst Trade</div></div>' +
        '<div class="stat"><div class="num" style="color:#d29922">' + paper + '</div><div class="label">Paper</div></div>' +
        '<div class="stat"><div class="num" style="color:#3fb950">' + live + '</div><div class="label">Live</div></div>' +
        '</div>';
    }

    function onFilterChange() {
      currentPage = 1;
      renderStats(getFiltered());
      renderTable();
    }

    function resetFilters() {
      ['filter-pair','filter-month','filter-category','filter-bot','filter-strategy','filter-version','filter-mode']
        .forEach(id => { document.getElementById(id).value = ''; });
      currentPage = 1;
      renderStats(TRADES);
      renderTable();
    }

    // Initial render
    renderStats(TRADES);
    renderTable();
  </script>
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

  // Read trade logs + realized P&L from position monitor
  const trades          = readTrades();
  const safetyLog       = readSafetyLog();
  const closedPositions = readClosedPositions();
  const sidAccount      = readSidAccount();
  console.log(`Closed positions loaded: ${closedPositions.size} realized P&L record(s)`);
  if (sidAccount) {
    const growth = ((sidAccount.accountUsd - sidAccount.startingUsd) / sidAccount.startingUsd * 100).toFixed(2);
    console.log(`SID account: $${sidAccount.accountUsd.toFixed(2)} (${growth >= 0 ? '+' : ''}${growth}% from $${sidAccount.startingUsd})`);
  }

  // Fetch live prices for every symbol we've ever traded
  const tradedSymbols = [...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const livePrices    = await fetchLivePrices(tradedSymbols);
  console.log(`Live prices fetched for: ${Object.keys(livePrices).join(', ') || 'none'}`);

  // Build structured trade data (stats + JSON for client-side filtering)
  const tradeData = buildTradeData(trades, safetyLog, livePrices, closedPositions, sidAccount);

  // Save machine-readable signal file for the trading bots to read
  const signalFile = {
    generated:  new Date().toISOString(),
    date:       todayString(),
    summary:    research.summary,
    signals:    signals.map(s => ({
      token:         s.token?.toUpperCase(),
      name:          s.name,
      category:      s.category,
      signal:        s.signal,
      risk:          s.risk,
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
  const html = generateHTML(date, research.summary, signals, bitgetPairs, tradeData);
  fs.writeFileSync('./docs/index.html', html);
  console.log(`\nDashboard saved to docs/index.html`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
