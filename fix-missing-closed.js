/**
 * fix-missing-closed.js — Reconstruct missing closed-position records
 *
 * When the Railway bot detects a position has closed but fails to push the
 * updated closed-positions-ironclad.json (e.g. git conflict), the close data
 * is lost on the next run's pull.  This script:
 *
 *   1. Reads trades-ironclad.csv to find live trades not in closed-positions-ironclad.json
 *   2. Skips any positions that are still open on Bitget right now
 *   3. Queries Bitget position history for the actual close price / P&L
 *   4. Writes the reconstructed records into closed-positions-ironclad.json
 *   5. Pushes updated file to the logs branch
 *
 * Run once from your Trading Setup folder:
 *   node fix-missing-closed.js
 */

import 'dotenv/config';
import fetch from 'node-fetch';
import fs   from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';

const BITGET_BASE = 'https://api.bitget.com';
const API_KEY    = process.env.BITGET_API_KEY    || '';
const SECRET_KEY = process.env.BITGET_SECRET_KEY || '';
const PASSPHRASE = process.env.BITGET_PASSPHRASE || '';
const LEVERAGE   = 3;

if (!API_KEY) { console.error('❌  No BITGET_API_KEY in .env'); process.exit(1); }

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

// ── Bitget auth ───────────────────────────────────────────────────────────────
function sign(ts, method, path, body) {
  return crypto.createHmac('sha256', SECRET_KEY)
    .update(ts + method + path + (body || ''))
    .digest('base64');
}

async function bitgetReq(method, path, body = null) {
  const ts      = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sig     = sign(ts, method, path, bodyStr);
  const res = await fetch(BITGET_BASE + path, {
    method,
    headers: {
      'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': sig,
      'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': PASSPHRASE,
      'Content-Type': 'application/json',
    },
    body: body ? bodyStr : undefined,
  });
  return res.json();
}

// ── Parse CSV ─────────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  // Deduplicate headers (the CSV sometimes has a double header row)
  const headerLine = lines[0];
  const dataLines  = lines.filter((l, i) => i === 0 || l !== headerLine);
  const headers = dataLines[0].split(',').map(h =>
    h.trim().toLowerCase().replace(/[→\s]+/g, '_').replace(/[^a-z0-9_]/g, '')
  );
  return dataLines.slice(1).map(line => {
    const vals = line.split(',');
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = vals[i]?.trim() ?? ''; });
    return obj;
  });
}

// ── Fetch currently open positions from Bitget ────────────────────────────────
async function getLivePositions() {
  const r = await bitgetReq('GET',
    '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
  if (r.code !== '00000') { console.log(RED(`Position fetch failed: ${r.msg}`)); return []; }
  return r.data.filter(p => parseFloat(p.total) > 0);
}

// ── Fetch position history for a symbol ──────────────────────────────────────
async function getPositionHistory(symbol) {
  const r = await bitgetReq('GET',
    `/api/v2/mix/position/history?productType=USDT-FUTURES&symbol=${symbol}&limit=20`);
  if (r.code !== '00000') return [];
  return r.data?.list || (Array.isArray(r.data) ? r.data : []);
}

// ── Infer exit level from close price ────────────────────────────────────────
function inferExitLevel(pos, closePrice) {
  const near = (a, b) => b > 0 && Math.abs(a - b) / b < 0.005;
  if (near(closePrice, pos.stopLoss)) return 'sl';
  if (pos.tp3 && near(closePrice, pos.tp3)) return 'tp3';
  if (pos.tp2 && near(closePrice, pos.tp2)) return 'tp2';
  if (pos.tp1 && near(closePrice, pos.tp1)) return 'tp1';
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(BOLD('\n════════════════════════════════════════════════'));
  console.log(BOLD('  Fix Missing Closed Position Records'));
  console.log(BOLD('════════════════════════════════════════════════\n'));

  // Pull latest files from logs branch first
  console.log('Pulling latest files from logs branch...');
  try {
    execSync(
      'git fetch origin logs && ' +
      'git checkout origin/logs -- trades-ironclad.csv && ' +
      'git checkout origin/logs -- closed-positions-ironclad.json',
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.log(YELLOW('  Could not pull from logs — using local files'));
  }

  // Load existing closed positions (keyed by id)
  const CLOSED_PATH = './closed-positions-ironclad.json';
  let closedPositions = [];
  try {
    closedPositions = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
  } catch { closedPositions = []; }
  const closedIds = new Set(closedPositions.map(p => String(p.id)));
  console.log(`Loaded ${closedPositions.length} existing closed positions\n`);

  // Load trades CSV — find live trades not in closed-positions
  const rows = parseCSV('./trades-ironclad.csv');
  const liveRows = rows.filter(r =>
    r.mode === 'live' &&
    r.order_id && r.order_id !== 'unknown' &&
    !closedIds.has(r.order_id)
  );

  if (!liveRows.length) {
    console.log(GREEN('✅ All live trades are already in closed-positions-ironclad.json — nothing to fix'));
    return;
  }

  console.log(`Found ${liveRows.length} live trade(s) missing from closed-positions-ironclad.json`);

  // Get currently open positions on Bitget (these should NOT be added to closed-positions yet)
  console.log('\nChecking which are still open on Bitget...');
  const liveOnExchange = await getLivePositions();
  const openOrderIds = new Set();
  // Also check open-positions-ironclad.json tracker
  try {
    const openTracked = JSON.parse(fs.readFileSync('./open-positions-ironclad.json', 'utf8'));
    for (const p of openTracked) {
      if (p.id) openOrderIds.add(String(p.id));
      if (p.orderId) openOrderIds.add(String(p.orderId));
    }
  } catch {}

  // Group open Bitget positions by symbol for lookup
  const openOnBitget = new Set(liveOnExchange.map(p => p.symbol?.replace(/_UMCBL$/, '')));
  console.log(`  Currently open on Bitget: ${[...openOnBitget].join(', ') || 'none'}`);
  console.log(`  Currently tracked as open: ${[...openOrderIds].join(', ').slice(0, 100) || 'none'}\n`);

  let anyAdded = false;

  // Group missing trades by symbol for efficient history lookup
  const bySymbol = {};
  for (const r of liveRows) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
    bySymbol[r.symbol].push(r);
  }

  for (const [symbol, trades] of Object.entries(bySymbol)) {
    console.log(BOLD(`\n${symbol} — ${trades.length} missing trade(s)`));

    // If ALL of this symbol's missing trades are ones we know are still open, skip
    const allStillOpen = trades.every(t => openOrderIds.has(t.order_id));
    if (allStillOpen) {
      console.log(YELLOW(`  ⏭ All are still open on Bitget — skipping`));
      continue;
    }

    // Fetch position history from Bitget
    console.log(`  Fetching position history from Bitget...`);
    await new Promise(r => setTimeout(r, 400));
    const history = await getPositionHistory(symbol);
    console.log(`  Got ${history.length} historical records`);

    for (const trade of trades) {
      const orderId = trade.order_id;

      // Skip if we confirmed this specific orderId is still open
      if (openOrderIds.has(orderId)) {
        console.log(YELLOW(`  ⏭ ${trade.date} ${trade.side} orderId=${orderId} — still open, skipping`));
        continue;
      }

      const entry   = parseFloat(trade.entry_price) || 0;
      const sl      = parseFloat(trade.stop_loss)   || 0;
      const tp1     = parseFloat(trade.tp1)          || null;
      const tp2     = parseFloat(trade.tp2)          || null;
      const tp3     = parseFloat(trade.tp3)          || null;
      const qty     = parseFloat(trade.quantity)     || 0;
      const totalUsd= parseFloat(trade.total_usd)   || 50;
      const side    = trade.side;

      // Try to find matching history record (by time proximity — Bitget doesn't expose orderId in position history)
      // Position history has: openTime, closeTime, openAvgPrice, closeAvgPrice, netProfit, etc.
      const tradeOpenTs = new Date(`${trade.date}T${trade.time}Z`).getTime();
      const match = history.find(h => {
        const openTs  = parseInt(h.openTime  || h.cTime || 0);
        const closeTs = parseInt(h.closeTime || h.uTime || 0);
        // Match if: open time is within 10 minutes of trade open AND close time > open time
        return Math.abs(openTs - tradeOpenTs) < 600_000 && closeTs > openTs;
      });

      let exitPrice, realizedPnl, exitLevel, closeDate, closeTime, outcome;

      if (match) {
        exitPrice   = parseFloat(match.closeAvgPrice || match.achievedProfits || 0);
        // Use Bitget's reported net profit; fall back to our own calculation
        const bitgetPnl = parseFloat(match.netProfit || match.achievedProfits || 0);
        if (Math.abs(bitgetPnl) > 0) {
          realizedPnl = parseFloat(bitgetPnl.toFixed(4));
        } else if (exitPrice > 0 && entry > 0) {
          const pnlFrac = side === 'long'
            ? (exitPrice - entry) / entry
            : (entry - exitPrice) / entry;
          realizedPnl = parseFloat((pnlFrac * totalUsd * LEVERAGE).toFixed(4));
        } else {
          realizedPnl = 0;
        }
        const closeTs = parseInt(match.closeTime || match.uTime || 0);
        const closeDt = closeTs ? new Date(closeTs).toISOString() : new Date().toISOString();
        closeDate = closeDt.slice(0, 10);
        closeTime = closeDt.slice(11, 19);
        exitLevel = inferExitLevel({ stopLoss: sl, tp1, tp2, tp3 }, exitPrice)
                  || (realizedPnl >= 0 ? 'tp1' : 'sl');
        outcome   = realizedPnl >= 0 ? 'WIN' : 'LOSS';
        console.log(GREEN(
          `  ✅ ${trade.date} ${side} orderId=${orderId}\n` +
          `     exit $${exitPrice} · ${exitLevel.toUpperCase()} · P&L: ${realizedPnl >= 0 ? '+' : ''}$${Math.abs(realizedPnl).toFixed(2)} (Bitget history)`
        ));
      } else {
        // No history match — assume SL hit, P&L = max loss for that trade size
        const pnlFrac = side === 'long'
          ? (sl - entry) / entry
          : (entry - sl) / entry;
        realizedPnl  = parseFloat((pnlFrac * totalUsd * LEVERAGE).toFixed(4));
        exitPrice    = sl;
        exitLevel    = 'sl';
        closeDate    = trade.date; // Assume closed same day — best guess
        closeTime    = '00:00:00';
        outcome      = 'LOSS';
        console.log(YELLOW(
          `  ⚠️  ${trade.date} ${side} orderId=${orderId} — no history match\n` +
          `     Assumed SL hit at $${sl} · P&L: $${realizedPnl.toFixed(2)} (estimated)`
        ));
      }

      const closedEntry = {
        id:          orderId,
        symbol,
        side,
        entry,
        stopLoss:    sl,
        tp1, tp2, tp3,
        qty,
        totalUsd,
        openDate:    trade.date,
        openTime:    trade.time,
        strategy:    trade.strategy,
        mode:        'live',
        tp1Hit:      exitLevel === 'tp2' || exitLevel === 'tp3',
        tp2Hit:      exitLevel === 'tp3',
        currentSl:   sl,
        partialCloses: exitPrice > 0 ? [{
          price: exitPrice, level: exitLevel, date: closeDate, time: closeTime, pnl: realizedPnl
        }] : [],
        realizedPnl,
        exitLevel,
        exitPrice,
        closeDate,
        closeTime,
        outcome,
        source: match ? 'bitget-history-reconstructed' : 'reconstructed-estimate',
      };

      closedPositions.push(closedEntry);
      closedIds.add(orderId);
      anyAdded = true;
    }
  }

  if (!anyAdded) {
    console.log(YELLOW('\n⚠️  No positions could be reconstructed (all are still open or already recorded)'));
    return;
  }

  // Save updated closed positions
  fs.writeFileSync(CLOSED_PATH, JSON.stringify(closedPositions, null, 2));
  console.log(BOLD(`\nSaved ${closedPositions.length} total closed positions to ${CLOSED_PATH}`));

  // Push to logs branch
  console.log('Pushing to logs branch...');
  try {
    execSync(
      'git add closed-positions-ironclad.json && ' +
      'git commit -m "fix: reconstruct missing closed-position records for dashboard" && ' +
      'git push origin HEAD:logs',
      { stdio: 'inherit' }
    );
    console.log(GREEN('\n✅ Done — closed positions updated and pushed to logs branch'));
    console.log('   Dashboard will update on the next research workflow run (8am/5pm UTC)');
    console.log('   To update immediately: GitHub → Actions → Daily Market Research → Run workflow');
  } catch (e) {
    console.log(YELLOW('\n⚠️  Could not push to logs — file saved locally'));
    console.log('    Push manually: git add closed-positions-ironclad.json && git push origin HEAD:logs');
  }
}

main().catch(e => { console.error(RED(`\nError: ${e.message}`)); process.exit(1); });
