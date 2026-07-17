/**
 * SID account reconciliation — makes ALPACA THE SOURCE OF TRUTH.
 *
 * WHY THIS EXISTS
 * ───────────────
 * SID's internal accounting drifted away from the real Alpaca paper account:
 *   - The ledger (sid-account.json realizedPnl) carries a PHANTOM loss: the MCD
 *     record was deleted from closed-positions-sid.json but its -$78.14 was
 *     never removed from the running realizedPnl counter, and tradeCount counts
 *     ledger EVENTS (TP1 partials, TP2 runner closes) not distinct positions.
 *   - The closed records book SIMULATED prices (TP1 at the RSI-50 bar close, TP2
 *     at the historical SMA50-touch bar), NOT the real Alpaca fill on the run
 *     day. On multi-day-late runner closes the two diverge a lot (e.g. a runner
 *     booked at the SMA50 touch weeks ago actually filled at today's price).
 *
 * WHAT THIS DOES
 * ──────────────
 * Pulls Alpaca's REAL data (FILL activities + account equity), matches each
 * closed SID position to its actual fills, computes the true per-position
 * realised P&L, and:
 *   - Rewrites each closed record's P&L to the Alpaca-fill-derived value,
 *     stamping pnl_source:"alpaca_fill" when matched, "estimate" on fallback.
 *   - Re-derives sid-account.json realizedPnl (= Σ corrected records),
 *     accountUsd (= startingUsd + realizedPnl), tradeCount (= distinct closed
 *     positions) — killing the phantom loss + inflated count.
 *   - Writes alpaca-account-sid.json — a snapshot of the REAL Alpaca equity for
 *     the dashboard headline (Phase 2 re-points the dashboard at this file).
 *
 * IT NEVER GUESSES: any position it can't match to real fills keeps its existing
 * (estimate) P&L and is flagged pnl_source:"estimate" so untrustworthy rows are
 * always visible. It never silently trusts an unverified number.
 *
 * MODES
 * ─────
 *   --dry-run   (DEFAULT) — prints the before/after table, writes NOTHING.
 *   --write               — persists the corrected files.
 *
 * This is a READ-ONLY-BY-DEFAULT diagnostic. bot-sid.js is NOT touched; this
 * tool is entirely additive and independent of the bot's run path.
 *
 * Console output is ASCII-only ([OK]/[FAIL]/->) — this machine's console is
 * cp1252 and unicode ticks crash mid-print (see SID/CLAUDE.md).
 *
 * Alpaca keys live only in the cloud (GHA secrets). Run via the
 * sid-reconcile.yml workflow_dispatch to produce the real numbers.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AlpacaClient } from './alpaca-client.js';
import { resolveTradingMode } from './alpaca-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths (relative to SID/, matching bot-sid.js) ────────────────────────────
const CLOSED_PATH        = path.join(__dirname, 'closed-positions-sid.json');
const ACCOUNT_PATH       = path.join(__dirname, 'sid-account.json');
const ALPACA_SNAP_PATH   = path.join(__dirname, 'alpaca-account-sid.json');

const STARTING_LEDGER_USD  = 10000;    // internal sizing base (unchanged)
const STARTING_ALPACA_USD  = 100000;   // Alpaca paper base (can't be set lower)

// ── CLI ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const WRITE   = args.includes('--write');
const DRY_RUN = !WRITE;   // dry-run is the DEFAULT

// ── Console helpers (ASCII only — cp1252 trap) ───────────────────────────────
const OK   = '[OK]';
const FAIL = '[FAIL]';
const WARN = '[WARN]';
const ARROW = '->';
function money(n)  { const v = Number(n) || 0; return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2); }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padl(s, n){ s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

// ── Mode / base URL (mirrors alpaca-executor.baseUrlForMode) ─────────────────
function baseUrlForMode(mode) {
  if (mode === 'live')  return 'https://api.alpaca.markets';
  if (mode === 'paper') return 'https://paper-api.alpaca.markets';
  return null;
}

// ── clientOrderIdPrefix (mirrors alpaca-executor, which does not export it) ──
function computePrefix({ symbol, side, signalDate }) {
  return `SID-${symbol}-${(signalDate || '').replace(/-/g, '')}-${side}`.slice(0, 40);
}
// A closed record's prefix: prefer the stored one, else reconstruct.
function prefixForPos(pos) {
  if (pos.clientOrderIdPrefix) return pos.clientOrderIdPrefix;
  return computePrefix({ symbol: pos.symbol, side: pos.side, signalDate: pos.signalDate });
}

// ── File IO ──────────────────────────────────────────────────────────────────
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ── Per-position P&L from real fills ─────────────────────────────────────────
// A "matched" position needs entry fills + exit fills that account for the
// position's shares. Realised P&L is direction-agnostic:
//   realised = (proceeds from sells) - (cost of buys), over the matched fills.
// For a long:  buy(entry) then sell(exit)          -> sells - buys
// For a short: sell_short(entry) then buy(exit)    -> sells - buys
// So summing signed cashflow (sell:+price*qty, buy:-price*qty) across the
// position's entry+exit fills yields realised P&L for a fully round-tripped
// position of equal in/out share counts.
function fillCashflow(fill) {
  const qty   = parseFloat(fill.qty);
  const price = parseFloat(fill.price);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return null;
  const side  = String(fill.side || '').toLowerCase();
  const isSell = side === 'sell' || side === 'sell_short';
  const isBuy  = side === 'buy'  || side === 'buy_to_cover';
  if (!isSell && !isBuy) return null;
  return isSell ? price * qty : -price * qty;   // signed cashflow
}

/**
 * Given a position and the fills attributed to it, compute realised P&L +
 * a per-leg breakdown. Returns { pnl, buyQty, sellQty, entryAvg, exitAvg,
 * matched:boolean }.
 * matched === true only when in-qty and out-qty both cover shares_total (a
 * complete round trip) — otherwise we DON'T trust it and fall back.
 */
function realisedFromFills(pos, fills) {
  const sharesTotal = pos.shares_total ?? pos.shares ?? 0;
  let buyQty = 0, sellQty = 0, buyCost = 0, sellProceeds = 0, cash = 0;
  for (const f of fills) {
    const cf = fillCashflow(f);
    if (cf === null) continue;
    cash += cf;
    const qty = parseFloat(f.qty), price = parseFloat(f.price);
    const side = String(f.side || '').toLowerCase();
    if (side === 'sell' || side === 'sell_short') { sellQty += qty; sellProceeds += price * qty; }
    else { buyQty += qty; buyCost += price * qty; }
  }
  // A complete round trip: both legs cover the position size (within a share of
  // rounding). Short entry is a sell_short; long entry is a buy.
  const legQty = Math.min(buyQty, sellQty);
  const matched = sharesTotal > 0 && legQty >= sharesTotal - 0.5 &&
                  buyQty >= sharesTotal - 0.5 && sellQty >= sharesTotal - 0.5;
  return {
    pnl: parseFloat(cash.toFixed(2)),
    buyQty, sellQty,
    entryAvg: pos.side === 'long'  ? (buyQty  ? buyCost / buyQty     : null)
                                   : (sellQty ? sellProceeds / sellQty : null),
    exitAvg:  pos.side === 'long'  ? (sellQty ? sellProceeds / sellQty : null)
                                   : (buyQty  ? buyCost / buyQty      : null),
    matched,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('== SID Account Reconciliation (Alpaca = source of truth) ==');
  console.log(`   Mode: ${DRY_RUN ? 'DRY-RUN (default) - writes NOTHING' : 'WRITE - will persist corrected files'}`);
  console.log('');

  const closed  = loadJSON(CLOSED_PATH, null);
  const account = loadJSON(ACCOUNT_PATH, null);
  if (!Array.isArray(closed)) {
    console.error(`${FAIL} Could not read ${CLOSED_PATH}`);
    process.exit(1);
  }
  console.log(`${OK} Loaded ${closed.length} closed record(s) from closed-positions-sid.json`);
  if (account) {
    console.log(`${OK} Loaded ledger: realizedPnl ${money(account.realizedPnl)}  tradeCount ${account.tradeCount}  accountUsd $${account.accountUsd}`);
  } else {
    console.log(`${WARN} sid-account.json not found — will re-derive from records`);
  }
  console.log('');

  // ── Connect to Alpaca (paper/live via resolveTradingMode) ────────────────
  const mode = resolveTradingMode();
  let client = null;
  let alpacaOk = false;
  let alpacaEquity = null;
  if (mode === 'dry_run') {
    console.log(`${WARN} SID_TRADING_MODE=dry_run (or unset) - no Alpaca keys in scope.`);
    console.log(`       This is EXPECTED locally. Run in the cloud via sid-reconcile.yml`);
    console.log(`       (workflow_dispatch) where the ALPACA_* secrets exist.`);
    console.log(`       Every position will be reported as pnl_source:"estimate".`);
  } else {
    try {
      client = new AlpacaClient({ baseUrl: baseUrlForMode(mode) });
      const acct = await client.getAccount();
      alpacaEquity = parseFloat(acct.equity);
      alpacaOk = true;
      console.log(`${OK} Connected to Alpaca (${mode}). Real account equity: $${alpacaEquity.toFixed(2)}`);
    } catch (err) {
      console.log(`${FAIL} Alpaca connection failed: ${err.message}`);
      console.log(`       Falling back to estimates for every position (nothing trusted blindly).`);
    }
  }
  console.log('');

  // ── Pull FILL activities + order map (order_id -> client_order_id) ────────
  let fills = [];
  let orderIdToClientId = new Map();
  if (alpacaOk) {
    // Earliest open across records bounds the activity window.
    const earliest = closed
      .map(p => p.openDate)
      .filter(Boolean)
      .sort()[0];
    const afterIso = earliest ? `${earliest}T00:00:00Z` : undefined;
    try {
      fills = await client.getActivities({ activity_types: 'FILL', after: afterIso, page_size: 100, direction: 'asc' });
      console.log(`${OK} Pulled ${fills.length} FILL activity record(s) from Alpaca since ${earliest || 'account start'}`);
    } catch (err) {
      console.log(`${FAIL} getActivities failed: ${err.message} — will estimate all positions`);
    }
    // Map order_id -> client_order_id so we can attribute fills by SID prefix.
    try {
      const symbols = [...new Set(closed.map(p => p.symbol))];
      for (const sym of symbols) {
        const orders = await client.listOrders({ status: 'all', symbols: sym, after: afterIso, limit: 500 });
        for (const o of (orders || [])) {
          if (o && o.id) orderIdToClientId.set(o.id, o.client_order_id || '');
        }
      }
      console.log(`${OK} Built order map for ${orderIdToClientId.size} order(s) across ${new Set(closed.map(p=>p.symbol)).size} symbol(s)`);
    } catch (err) {
      console.log(`${WARN} Could not build full order map: ${err.message} — will match by symbol/side/time window`);
    }
  }
  console.log('');

  // ── Reconcile each position ──────────────────────────────────────────────
  const rows = [];
  const corrected = [];
  let sumCorrected = 0;

  for (const pos of closed) {
    const prefix = prefixForPos(pos);
    const symU   = String(pos.symbol).toUpperCase();
    const oldPnl = pos.total_pnl ?? pos.realizedPnl ?? 0;

    // Attribute fills to this position.
    let posFills = [];
    if (alpacaOk && fills.length) {
      // (a) primary match: fill's order's client_order_id starts with our prefix
      posFills = fills.filter(f => {
        if (String(f.symbol || '').toUpperCase() !== symU) return false;
        const cid = orderIdToClientId.get(f.order_id) || '';
        return cid.startsWith(prefix);
      });
      // (b) fallback: symbol + time window [openDate, closeDate] when the order
      //     map is incomplete OR the exit order had no SID client_order_id
      //     (bot market closes carry no prefix). Keep it tight to the position's
      //     own date window so it can't steal another position's fills.
      if (!posFills.length || posFills.reduce((s, f) => s + parseFloat(f.qty || 0), 0) < (pos.shares_total ?? pos.shares ?? 0)) {
        const openMs  = pos.openDate  ? Date.parse(`${pos.openDate}T00:00:00Z`)  : -Infinity;
        const closeMs = pos.closeDate ? Date.parse(`${pos.closeDate}T23:59:59Z`) : Infinity;
        const windowFills = fills.filter(f => {
          if (String(f.symbol || '').toUpperCase() !== symU) return false;
          const t = Date.parse(f.transaction_time || f.transactionTime || '');
          return Number.isFinite(t) && t >= openMs && t <= closeMs;
        });
        // Prefer the union but de-dupe by activity id.
        const byId = new Map();
        for (const f of [...posFills, ...windowFills]) byId.set(f.id, f);
        posFills = [...byId.values()];
      }
    }

    let newPnl = oldPnl;
    let source = 'estimate';
    let detail = '';
    if (alpacaOk && posFills.length) {
      const r = realisedFromFills(pos, posFills);
      if (r.matched) {
        newPnl = r.pnl;
        source = 'alpaca_fill';
        detail = `entry~$${r.entryAvg != null ? r.entryAvg.toFixed(2) : '?'} exit~$${r.exitAvg != null ? r.exitAvg.toFixed(2) : '?'} (${r.buyQty}b/${r.sellQty}s)`;
      } else {
        detail = `incomplete fills (${r.buyQty}b/${r.sellQty}s vs ${pos.shares_total ?? pos.shares} needed) - kept estimate`;
      }
    } else if (alpacaOk) {
      detail = 'no fills matched - kept estimate';
    } else {
      detail = 'offline - kept estimate';
    }

    sumCorrected += newPnl;
    rows.push({
      symbol: pos.symbol, side: pos.side, closeDate: pos.closeDate || '',
      oldPnl, newPnl, source, detail, delta: parseFloat((newPnl - oldPnl).toFixed(2)),
    });

    // Build the corrected record (additive stamp; only overwrite P&L fields).
    corrected.push({
      ...pos,
      total_pnl:   parseFloat(newPnl.toFixed(2)),
      realizedPnl: parseFloat(newPnl.toFixed(2)),
      pnl_source:  source,
      reconciled_at: new Date().toISOString().slice(0, 10),
    });
  }

  sumCorrected = parseFloat(sumCorrected.toFixed(2));

  // ── Print the before/after table ─────────────────────────────────────────
  console.log('== Per-position reconciliation ==');
  console.log(`   ${pad('SYMBOL',7)} ${pad('SIDE',6)} ${pad('CLOSED',11)} ${padl('OLD P&L',10)} ${padl('NEW P&L',10)} ${padl('DELTA',9)}  SOURCE / NOTE`);
  console.log('   ' + '-'.repeat(88));
  for (const r of rows) {
    const tag = r.source === 'alpaca_fill' ? OK : WARN;
    console.log(`   ${pad(r.symbol,7)} ${pad(r.side,6)} ${pad(r.closeDate,11)} ${padl(money(r.oldPnl),10)} ${padl(money(r.newPnl),10)} ${padl(money(r.delta),9)}  ${tag} ${r.source} ${r.detail ? ARROW + ' ' + r.detail : ''}`);
  }
  console.log('   ' + '-'.repeat(88));

  const oldRecordsSum = parseFloat(closed.reduce((s, p) => s + (p.total_pnl ?? p.realizedPnl ?? 0), 0).toFixed(2));
  const matchedCount  = rows.filter(r => r.source === 'alpaca_fill').length;
  const estimateCount = rows.length - matchedCount;

  console.log('');
  console.log('== Ledger reconciliation (internal $10K sizing base) ==');
  console.log(`   ${pad('',34)} ${padl('BEFORE',12)} ${padl('AFTER',12)}`);
  console.log(`   ${pad('realizedPnl (Sigma records)',34)} ${padl(money(account?.realizedPnl ?? oldRecordsSum),12)} ${padl(money(sumCorrected),12)}`);
  console.log(`   ${pad('tradeCount (distinct positions)',34)} ${padl(String(account?.tradeCount ?? '?'),12)} ${padl(String(corrected.length),12)}`);
  console.log(`   ${pad('accountUsd (10000 + realizedPnl)',34)} ${padl('$' + (account?.accountUsd ?? (STARTING_LEDGER_USD + oldRecordsSum)).toFixed(2),12)} ${padl('$' + (STARTING_LEDGER_USD + sumCorrected).toFixed(2),12)}`);
  console.log('');
  console.log(`   Old records sum:      ${money(oldRecordsSum)}   (what the dashboard headline shows today)`);
  console.log(`   Corrected records:    ${money(sumCorrected)}   (${matchedCount} matched to Alpaca fills, ${estimateCount} kept as estimate)`);
  if (alpacaOk && alpacaEquity != null) {
    const alpacaNet = parseFloat((alpacaEquity - STARTING_ALPACA_USD).toFixed(2));
    console.log(`   Alpaca equity:        $${alpacaEquity.toFixed(2)}  -> net ${money(alpacaNet)} on $${STARTING_ALPACA_USD} base (SOURCE OF TRUTH)`);
    const gap = parseFloat((alpacaNet - sumCorrected).toFixed(2));
    console.log(`   Corrected vs Alpaca:  gap ${money(gap)}  ${Math.abs(gap) < 1 ? OK + ' reconciled' : WARN + ' residual - see estimate rows above'}`);
  } else {
    console.log(`   Alpaca equity:        (unavailable offline - run in cloud to compare against +$182.18)`);
  }
  console.log('');

  // ── Build the Alpaca equity snapshot for the dashboard headline ──────────
  const snapshot = {
    equity:         alpacaOk && alpacaEquity != null ? parseFloat(alpacaEquity.toFixed(2)) : null,
    startingEquity: STARTING_ALPACA_USD,
    netPnl:         alpacaOk && alpacaEquity != null ? parseFloat((alpacaEquity - STARTING_ALPACA_USD).toFixed(2)) : null,
    source:         'alpaca',
    mode,
    asOf:           new Date().toISOString(),
    reconciledRecords: matchedCount,
    estimateRecords:   estimateCount,
  };

  // ── Write or dry-run ─────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log(`${OK} DRY-RUN complete. No files written. Re-run with --write to persist.`);
    console.log('     Files that WOULD change:');
    console.log('       - closed-positions-sid.json  (P&L rewritten + pnl_source stamped)');
    console.log('       - sid-account.json           (realizedPnl/accountUsd/tradeCount re-derived)');
    console.log('       - alpaca-account-sid.json    (real Alpaca equity snapshot, NEW)');
    return;
  }

  // WRITE mode — guard: refuse to overwrite good records with all-estimates.
  if (!alpacaOk) {
    console.log(`${FAIL} --write refused: no live Alpaca connection, so every record would be an`);
    console.log(`       estimate and nothing would be corrected. Run --write ONLY in the cloud`);
    console.log(`       (sid-reconcile.yml) where the ALPACA_* secrets exist. Aborting.`);
    process.exit(1);
  }

  fs.writeFileSync(CLOSED_PATH, JSON.stringify(corrected, null, 2));
  console.log(`${OK} Wrote ${corrected.length} corrected record(s) to closed-positions-sid.json`);

  const newAccount = {
    ...(account || {}),
    accountUsd:  parseFloat((STARTING_LEDGER_USD + sumCorrected).toFixed(2)),
    startingUsd: STARTING_LEDGER_USD,
    realizedPnl: sumCorrected,
    tradeCount:  corrected.length,
    lastUpdated: new Date().toISOString().slice(0, 10),
    mode:        account?.mode || (mode === 'live' ? 'live' : 'paper'),
    reconciledFromAlpaca: true,
    reconciledAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(newAccount, null, 2));
  console.log(`${OK} Re-derived sid-account.json: realizedPnl ${money(sumCorrected)}  tradeCount ${corrected.length}  accountUsd $${newAccount.accountUsd}`);

  fs.writeFileSync(ALPACA_SNAP_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`${OK} Wrote alpaca-account-sid.json: equity $${snapshot.equity}  netPnl ${money(snapshot.netPnl)}`);

  console.log('');
  console.log(`${OK} WRITE complete.`);
}

main().catch(err => {
  console.error(`${FAIL} Reconciliation crashed: ${err.stack || err.message}`);
  process.exit(1);
});
