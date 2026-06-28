// SID/price-alert.js — generic cloud-fired price-level alert (GitHub Actions cron).
//
// Fires a ONE-SHOT Telegram alert when a symbol touches a price level, then
// records state so it never re-fires (no spam). Cloud-first per the repo rule
// (trade/level automation must be PC-independent — never a local scheduler).
// Env-driven so it's reusable for any future level alert, not just UNH $440.
//
//   ALERT_ID    unique key for the state file (e.g. "unh-440-resistance")
//   SYMBOL      ticker (e.g. "UNH")
//   THRESHOLD   price level (e.g. "440")
//   DIRECTION   "above" -> fire when the day's HIGH >= threshold (price touched it)
//               "below" -> fire when the day's LOW  <= threshold
//   LABEL       human description used in the alert text
//   TEST_MODE   "true" -> send a test ping regardless of price; does NOT touch state
//
// NOTE: this is a LEVEL alert only. It never places a trade — the user decides.

import fs from 'fs';
import { sendMessage } from './telegram-alerts.js';

const ALERT_ID   = process.env.ALERT_ID   || 'unh-440-resistance';
const SYMBOL     = process.env.SYMBOL     || 'UNH';
const THRESHOLD  = parseFloat(process.env.THRESHOLD || '440');
const DIRECTION  = (process.env.DIRECTION || 'above').toLowerCase();
const LABEL      = process.env.LABEL || `${SYMBOL} ${DIRECTION} $${THRESHOLD}`;
const TEST_MODE  = process.env.TEST_MODE === 'true';
const STATE_PATH = './price-alert-state.json';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n'); }

async function fetchQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const j = await res.json();
  const m = j.chart?.result?.[0]?.meta;
  if (!m || m.regularMarketPrice == null) throw new Error('no price in Yahoo response');
  return {
    price:   m.regularMarketPrice,
    dayHigh: m.regularMarketDayHigh ?? m.regularMarketPrice,
    dayLow:  m.regularMarketDayLow  ?? m.regularMarketPrice,
  };
}

async function main() {
  console.log(`[price-alert] ${ALERT_ID}: ${SYMBOL} ${DIRECTION} $${THRESHOLD}`);

  if (TEST_MODE) {
    const r = await sendMessage(`🔔 <b>SID PRICE ALERT — TEST</b>\n\nPipeline check for "${LABEL}".\nIf you got this, the alert is wired. It will fire for real when ${SYMBOL} touches $${THRESHOLD}.`);
    console.log('  TEST_MODE — telegram result:', JSON.stringify(r));
    return;
  }

  const state = loadState();
  if (state[ALERT_ID]?.fired) {
    console.log(`  already fired on ${state[ALERT_ID].firedAt} — no-op (delete this workflow to stop checks)`);
    return;
  }

  let q;
  try { q = await fetchQuote(SYMBOL); }
  catch (e) { console.log(`  price fetch failed: ${e.message} — will retry next run`); return; }

  const probe = DIRECTION === 'above' ? q.dayHigh : q.dayLow;
  console.log(`  last $${q.price?.toFixed(2)}  dayHigh $${q.dayHigh?.toFixed(2)}  dayLow $${q.dayLow?.toFixed(2)}`);

  const hit = DIRECTION === 'above' ? (q.dayHigh >= THRESHOLD) : (q.dayLow <= THRESHOLD);
  if (!hit) {
    const gap = DIRECTION === 'above' ? (THRESHOLD - q.price) : (q.price - THRESHOLD);
    console.log(`  not reached — $${gap.toFixed(2)} away, waiting`);
    return;
  }

  const arrow = DIRECTION === 'above' ? '▲' : '▼';
  const word  = DIRECTION === 'above' ? 'high' : 'low';
  const msg = [
    `🔔 <b>SID PRICE ALERT</b> ${arrow}`,
    ``,
    `<b>${SYMBOL}</b> reached your level — <b>$${THRESHOLD}</b>`,
    LABEL,
    ``,
    `Last $${q.price?.toFixed(2)}  ·  day ${word} $${probe?.toFixed(2)}`,
    ``,
    `<i>Level alert only — not a trade instruction. Your call.</i>`,
  ].join('\n');
  const r = await sendMessage(msg);
  console.log('  ALERT SENT:', JSON.stringify(r));

  state[ALERT_ID] = {
    fired: true,
    firedAt: new Date().toISOString().slice(0, 19) + 'Z',
    symbol: SYMBOL, threshold: THRESHOLD, direction: DIRECTION,
    priceAtFire: q.price, probeAtFire: probe,
  };
  saveState(state);
  console.log('  state recorded — will not re-fire');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
