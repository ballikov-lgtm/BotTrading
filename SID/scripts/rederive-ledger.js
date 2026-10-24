/**
 * Re-derive sid-account.json from the on-disk records — using the BOT'S OWN
 * `deriveLedger()`, never a hand-rolled copy of the arithmetic.
 *
 * WHY: since v2.4.1 the ledger is derived from records rather than accumulated
 * (`realizedPnl` = SUM(closed records of this mode) + SUM(in-flight TP1 partials
 * on still-open positions of this mode); `tradeCount` = distinct closed records
 * of this mode; `accountUsd` = startingUsd + realizedPnl). The bot re-derives it
 * on every close, so it self-heals on the next run — but after an out-of-band
 * data correction (e.g. scripts/fix-pypl-leg2-2026-09-05.js) the ledger is stale
 * until then, and it is what position sizing reads. This applies the derivation
 * immediately.
 *
 * Paper/live stay segregated: only the ledger's own mode is summed.
 *
 *   node scripts/rederive-ledger.js            # dry-run (DEFAULT)
 *   node scripts/rederive-ledger.js --write    # persist
 *
 * ASCII-only console output (cp1252 machine — see SID/CLAUDE.md).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { deriveLedger } from '../bot-sid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT_PATH = path.join(__dirname, '..', 'sid-account.json');

const WRITE = process.argv.includes('--write');
const OK = '[OK]', ARROW = '->';
const money = n => ((Number(n) || 0) >= 0 ? '+' : '-') + '$' + Math.abs(Number(n) || 0).toFixed(2);

const account = JSON.parse(fs.readFileSync(ACCOUNT_PATH, 'utf8'));
const mode = String(account.mode || 'paper').toLowerCase();
const startingUsd = account.startingUsd ?? 10000;
const { realizedPnl, tradeCount } = deriveLedger(mode);
const accountUsd = parseFloat((startingUsd + realizedPnl).toFixed(2));

console.log(`== Re-derive SID ledger (${mode.toUpperCase()}) ==`);
console.log(`   Mode: ${WRITE ? 'WRITE' : 'DRY-RUN (default)'}`);
console.log(`   realizedPnl  ${money(account.realizedPnl)}  ${ARROW}  ${money(realizedPnl)}`);
console.log(`   tradeCount   ${account.tradeCount}  ${ARROW}  ${tradeCount}`);
console.log(`   accountUsd   $${Number(account.accountUsd).toFixed(2)}  ${ARROW}  $${accountUsd.toFixed(2)}`);

if (!WRITE) {
  console.log(`${OK} DRY-RUN complete. Nothing written.`);
} else {
  account.realizedPnl = realizedPnl;
  account.tradeCount  = tradeCount;
  account.accountUsd  = accountUsd;
  account.startingUsd = startingUsd;
  account.lastUpdated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(account, null, 2));
  console.log(`${OK} Wrote sid-account.json`);
}
