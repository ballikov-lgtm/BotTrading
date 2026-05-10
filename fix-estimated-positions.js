/**
 * fix-estimated-positions.js
 * ──────────────────────────
 * Queries Bitget API to find the real close data for "reconstructed-estimate"
 * entries that have fabricated or missing data in closed-positions-ironclad.json.
 *
 * For each estimated entry:
 *   - If Bitget position history has a record → patch with real exit price / P&L
 *   - If Bitget has an open position for the same symbol/side BUT with a DIFFERENT
 *     open time or entry price → that is a NEW trade; our entry was correctly closed
 *   - If Bitget has an open position that matches our entry time AND price → still open,
 *     remove from closed-positions
 *   - If the open order ID is confirmed live via order detail → still open, remove
 *   - If not found anywhere → flag as unresolved (do NOT silently remove)
 *
 * Run from Trading Setup folder:
 *   node fix-estimated-positions.js
 */

import fetch     from 'node-fetch';
import fs        from 'fs';
import crypto    from 'crypto';
import { execSync } from 'child_process';

const API_KEY    = process.env.BITGET_API_KEY    || 'bg_46c0aaf2c28b996a642a39f437a6f9dc';
const SECRET     = process.env.BITGET_SECRET_KEY || '8008e0da0054e9878df767be2f67ddd5d3b9be20f228eaca229cbf7ec126dc8c';
const PASSPHRASE = process.env.BITGET_PASSPHRASE || 'P4VlOvN4T4BeLkO';
const BASE       = 'https://api.bitget.com';
const CLOSED_PATH = 'closed-positions-ironclad.json';

// ── Bitget auth ────────────────────────────────────────────────────────────────

function sign(timestamp, method, path, body = '') {
  const msg = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac('sha256', SECRET).update(msg).digest('base64');
}

async function bitget(method, path, params = {}) {
  const ts    = Date.now().toString();
  const qs    = Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString()
    : '';
  const fullPath = path + qs;
  const sig   = sign(ts, method.toUpperCase(), fullPath, '');
  const res   = await fetch(`${BASE}${fullPath}`, {
    method,
    headers: {
      'ACCESS-KEY':        API_KEY,
      'ACCESS-SIGN':       sig,
      'ACCESS-TIMESTAMP':  ts,
      'ACCESS-PASSPHRASE': PASSPHRASE,
      'Content-Type':      'application/json',
      'locale':            'en-US',
    },
  });
  return res.json();
}

// ── Fetch all Bitget USDT-M position history ───────────────────────────────────

async function fetchAllPositionHistory() {
  console.log('\n── Fetching Bitget USDT-M position history (all pages)...');
  const all = [];
  let endTime = Date.now();
  let page = 0;

  while (true) {
    page++;
    const data = await bitget('GET', '/api/v2/mix/position/history', {
      productType: 'USDT-FUTURES',
      limit:       100,
      endTime:     endTime.toString(),
    });

    if (!data.data?.list?.length) break;

    const records = data.data.list;
    all.push(...records);
    console.log(`  Page ${page}: ${records.length} records`);

    if (!data.data.nextFlag || records.length < 100) break;

    // Move endTime back to before the oldest record on this page
    const oldest = Math.min(...records.map(r => parseInt(r.openTime || r.cTime || endTime)));
    endTime = oldest - 1;

    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  console.log(`  Total position history records: ${all.length}`);
  return all;
}

// ── Fetch open positions ───────────────────────────────────────────────────────

async function fetchOpenPositions() {
  console.log('\n── Fetching current open positions...');
  const data = await bitget('GET', '/api/v2/mix/position/all-position', {
    productType: 'USDT-FUTURES',
    marginCoin:  'USDT',
  });
  const list = data.data || [];
  console.log(`  Open positions: ${list.length}`);
  return list;
}

// ── Check whether an open Bitget position is the SAME trade as our record ─────
//
// A matching symbol+side is not enough — if the bot recorded a close and then
// a new position opened in the same direction, they will share the same key.
// We verify by comparing:
//   1. Open time  — must be within 5 minutes of our openDate+openTime
//   2. Entry price — must be within 0.5% of our entry
// If either check fails, the open position is a DIFFERENT (newer) trade.

function isSameOpenPosition(pos, bitgetOpenPos) {
  // Entry price check
  const ourEntry    = parseFloat(pos.entry || 0);
  const theirEntry  = parseFloat(bitgetOpenPos.openAvgPrice || bitgetOpenPos.averageOpenPrice || 0);
  if (ourEntry && theirEntry) {
    const priceDiff = Math.abs(ourEntry - theirEntry) / ourEntry;
    if (priceDiff > 0.005) {
      console.log(`    Entry price mismatch: ours=${ourEntry} Bitget=${theirEntry} (${(priceDiff*100).toFixed(2)}% diff) → different trade`);
      return false;
    }
  }

  // Open time check — Bitget open position has openTime (epoch ms) or openDelegateCount
  const bitgetOpenMs = parseInt(bitgetOpenPos.openTime || bitgetOpenPos.cTime || 0);
  if (bitgetOpenMs && pos.openDate && pos.openTime) {
    const ourOpenMs = new Date(`${pos.openDate}T${pos.openTime}Z`).getTime();
    const diffMin   = Math.abs(bitgetOpenMs - ourOpenMs) / 60000;
    if (diffMin > 5) {
      console.log(`    Open time mismatch: ours=${pos.openDate} ${pos.openTime} UTC  Bitget=${new Date(bitgetOpenMs).toISOString().slice(0,16)} UTC (${diffMin.toFixed(0)} min apart) → different trade`);
      return false;
    }
  }

  return true;
}

// ── Fetch order detail by orderId ──────────────────────────────────────────────

async function fetchOrderDetail(symbol, orderId) {
  try {
    const data = await bitget('GET', '/api/v2/mix/order/detail', {
      symbol,
      productType: 'USDT-FUTURES',
      orderId,
    });
    return data.data || null;
  } catch {
    return null;
  }
}

// ── Fetch fills for a specific orderId ────────────────────────────────────────

async function fetchOrderFills(symbol, orderId) {
  try {
    const data = await bitget('GET', '/api/v2/mix/order/fill-history', {
      symbol,
      productType: 'USDT-FUTURES',
      orderId,
    });
    return data.data?.fillList || [];
  } catch {
    return [];
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══ Fix estimated closed-position entries ══\n');

  // Load closed positions
  let closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  const estimated = closed.filter(p =>
    p.source && (p.source.includes('estimated') || p.source.includes('reconstructed'))
  );
  console.log(`Estimated entries to fix: ${estimated.length}`);
  estimated.forEach(p =>
    console.log(`  ${p.symbol} ${p.side} ${p.openDate}  exit=${p.exitPrice}  pnl=${p.realizedPnl}  id=${p.id}`)
  );

  // Fetch Bitget data
  const posHistory  = await fetchAllPositionHistory();
  const openPosList = await fetchOpenPositions();

  // Build lookup: "SYMBOL_side" → list of open position objects with full detail
  // We keep the full objects so we can compare entry price and open time later.
  const openByKey = {};
  for (const p of openPosList) {
    if (parseFloat(p.total || p.size || 0) <= 0) continue;
    const key = `${p.symbol?.toUpperCase()}_${p.holdSide?.toLowerCase()}`;
    if (!openByKey[key]) openByKey[key] = [];
    openByKey[key].push(p);
  }
  console.log('\n  Currently open positions:', Object.keys(openByKey).join(', ') || 'none');

  // Build lookup from position history: try to match by orderId list inside position
  // Bitget position history doesn't always expose orderId directly — we'll match by
  // symbol + side + openTime proximity + entry price proximity
  const posMap = new Map(); // key: "SYMBOL_side_openDate" → position history record

  for (const rec of posHistory) {
    const sym    = (rec.symbol || '').replace('_UMCBL', '').replace('UMCBL', '').toUpperCase();
    const side   = rec.holdSide?.toLowerCase() || '';
    const openTs = parseInt(rec.openTime || rec.cTime || 0);
    const openDate = openTs ? new Date(openTs).toISOString().slice(0, 10) : '';
    const key    = `${sym}_${side}_${openDate}`;
    // Keep the record with closest entry price if there are duplicates
    if (!posMap.has(key)) posMap.set(key, []);
    posMap.get(key).push(rec);
  }

  // Process each estimated entry
  const toRemove  = new Set();
  const toUpdate  = {};  // id → patch object

  for (const pos of estimated) {
    const sym    = pos.symbol.toUpperCase();
    const side   = pos.side.toLowerCase();
    const key    = `${sym}_${side}_${pos.openDate}`;
    const posKey = `${sym}_${side}`;
    const entry  = parseFloat(pos.entry || 0);

    console.log(`\n──────────────────────────────────`);
    console.log(`Processing: ${sym} ${side} ${pos.openDate} (id=${pos.id})`);

    // 1. Check if still open on Bitget — but verify it is the SAME position,
    //    not a new trade opened in the same direction after our entry closed.
    const openCandidates = openByKey[posKey] || [];
    if (openCandidates.length > 0) {
      const matchingOpen = openCandidates.find(op => isSameOpenPosition(pos, op));
      if (matchingOpen) {
        console.log(`  ⬆  Confirmed SAME position still open on Bitget (entry & time match) → removing from closed-positions`);
        toRemove.add(pos.id);
        continue;
      } else {
        console.log(`  ℹ  Bitget has an open ${sym} ${side} but it is a DIFFERENT (newer) position — our entry was correctly closed`);
      }
    }

    // 2. Try to find in position history
    const candidates = posMap.get(key) || [];
    let best = null;
    if (candidates.length > 0) {
      // Pick the one whose avgOpenPrice is closest to our entry
      best = candidates.reduce((a, b) => {
        const da = Math.abs(parseFloat(a.openAvgPrice || 0) - entry);
        const db = Math.abs(parseFloat(b.openAvgPrice || 0) - entry);
        return da < db ? a : b;
      });
      const entryMatch = entry === 0 || Math.abs(parseFloat(best.openAvgPrice || 0) - entry) / entry < 0.02;
      if (!entryMatch) best = null;
    }

    if (best) {
      const exitPrice = parseFloat(best.closeAvgPrice || 0);
      const pnl       = parseFloat(best.netProfit || best.achievedProfits || 0);
      const closeTs   = parseInt(best.closeTime || best.uTime || 0);
      const closeDate = closeTs ? new Date(closeTs).toISOString().slice(0, 10) : pos.openDate;
      const closeTime = closeTs ? new Date(closeTs).toISOString().slice(11, 19) : '00:00:00';
      const outcome   = pnl >= 0 ? 'WIN' : 'LOSS';

      // Infer exit level
      const sl  = parseFloat(pos.stopLoss || 0);
      const tp1 = parseFloat(pos.tp1 || 0);
      const tp2 = parseFloat(pos.tp2 || 0);
      const tp3 = parseFloat(pos.tp3 || 0);
      let exitLevel = 'tp1';
      const near = (a, b) => b !== 0 && Math.abs(a - b) / Math.abs(b) < 0.005;
      if (near(exitPrice, sl))  exitLevel = 'sl';
      else if (near(exitPrice, tp1)) exitLevel = 'tp1';
      else if (near(exitPrice, tp2)) exitLevel = 'tp2';
      else if (near(exitPrice, tp3)) exitLevel = 'tp3';
      else if (side === 'long')  exitLevel = exitPrice > entry ? 'tp1' : 'sl';
      else                       exitLevel = exitPrice < entry ? 'tp1' : 'sl';

      console.log(`  ✅ Found in position history:`);
      console.log(`     entry=${best.openAvgPrice} → exit=${exitPrice}  pnl=${pnl}  ${closeDate}`);

      toUpdate[pos.id] = {
        exitPrice,
        realizedPnl: Math.round(pnl * 10000) / 10000,
        exitLevel,
        closeDate,
        closeTime,
        outcome,
        source:  'bitget-verified',
        locked:  true,
        partialCloses: [{
          price: exitPrice,
          level: exitLevel,
          date:  closeDate,
          time:  closeTime,
          pnl:   Math.round(pnl * 10000) / 10000,
        }],
      };
      continue;
    }

    // 3. Not open, not in position history → try to get order detail
    console.log(`  ? Not in position history — checking order detail...`);
    await new Promise(r => setTimeout(r, 200));
    const orderDetail = await fetchOrderDetail(sym, pos.id);

    if (orderDetail) {
      const status = orderDetail.status || orderDetail.state || '';
      console.log(`  Order status: ${status}`);

      if (status === 'live' || status === 'new' || status === 'partially_filled') {
        // Still open
        console.log(`  ⬆  Order still live → removing from closed-positions`);
        toRemove.add(pos.id);
        continue;
      }

      if (status === 'cancelled' || status === 'canceled') {
        // Cancelled order — remove, no trade happened
        console.log(`  ✗  Order was cancelled → removing from closed-positions`);
        toRemove.add(pos.id);
        continue;
      }
    }

    // 4. Can't confirm what happened — do NOT remove silently.
    //    Flag as unresolved so it can be investigated. A manual Bitget export
    //    and re-run of reconcile-closed-positions.py is the correct next step.
    console.log(`  ⚠  Cannot confirm status — leaving in place, flagged as unresolved`);
    console.log(`     → Export fresh Bitget XLS and run reconcile-closed-positions.py to fix`);
    // Update source to make it clear this needs attention, but keep the entry
    pos.source  = 'unresolved-needs-bitget-export';
    pos.locked  = false;
    toUpdate[pos.id] = { source: 'unresolved-needs-bitget-export', locked: false };
  }

  // Apply updates and removals
  let patched = 0;
  let removed = 0;
  const newClosed = [];

  for (const pos of closed) {
    if (toRemove.has(pos.id)) {
      console.log(`\n  🗑  Removed: ${pos.symbol} ${pos.side} ${pos.openDate} (pnl was ${pos.realizedPnl})`);
      removed++;
      continue;
    }
    if (toUpdate[pos.id]) {
      Object.assign(pos, toUpdate[pos.id]);
      console.log(`\n  ✅ Patched: ${pos.symbol} ${pos.side} ${pos.openDate} → exit=${pos.exitPrice} pnl=${pos.realizedPnl}`);
      patched++;
    }
    newClosed.push(pos);
  }

  console.log(`\n══ Summary ══`);
  console.log(`  Removed:  ${removed}`);
  console.log(`  Patched:  ${patched}`);
  console.log(`  Remaining: ${newClosed.length} records`);

  // Save
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(newClosed, null, 2));
  console.log(`\n  ✓ Saved ${newClosed.length} records to ${CLOSED_PATH}`);

  // Push to logs branch
  console.log('\n── Pushing to logs branch...');
  try {
    execSync('git fetch origin logs', { stdio: 'inherit' });
    // Use temp branch approach
    execSync('git branch -D _fix_temp 2>nul & git checkout -b _fix_temp origin/logs', { stdio: 'inherit', shell: true });
    fs.writeFileSync(CLOSED_PATH, JSON.stringify(newClosed, null, 2));
    execSync('git add closed-positions-ironclad.json', { stdio: 'inherit' });
    execSync('git commit -m "fix: remove fabricated estimated-loss entries from closed-positions"', { stdio: 'inherit' });
    execSync('git push origin _fix_temp:logs', { stdio: 'inherit' });
    execSync('git checkout main', { stdio: 'inherit' });
    execSync('git branch -D _fix_temp', { stdio: 'inherit' });
    console.log('  ✓ Pushed to logs branch');
  } catch (e) {
    console.log(`  ⚠ Push error: ${e.message}`);
  }

  // Also push to main so research.yml picks it up
  console.log('\n── Pushing to main branch...');
  try {
    execSync('git add closed-positions-ironclad.json', { stdio: 'inherit' });
    execSync('git commit -m "fix: remove fabricated estimated-loss entries"', { stdio: 'inherit' });
    execSync('git pull --rebase --autostash origin main && git push origin main', { stdio: 'inherit', shell: true });
    console.log('  ✓ Pushed to main branch');
  } catch (e) {
    console.log(`  ⚠ Main push note: ${e.message}`);
  }

  // Rebuild dashboard
  console.log('\n── Rebuilding dashboard...');
  try {
    execSync('node research.js', { stdio: 'inherit', timeout: 120000 });
    console.log('  ✓ Dashboard rebuilt');
  } catch (e) {
    console.log(`  ⚠ Dashboard rebuild: ${e.message}`);
  }

  console.log('\n══ Done ══\n');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
