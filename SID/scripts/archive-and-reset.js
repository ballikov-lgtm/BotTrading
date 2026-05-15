/**
 * archive-and-reset.js — Preserve paper-trading history before going live.
 *
 * Use case: you've been paper-trading SID on Alpaca for weeks, decided
 * to flip to live trading with real money. You want to:
 *
 *   1. Preserve all paper trades, positions, account history, and CSV
 *      logs into a timestamped archive folder.
 *   2. Reset the active files to a clean slate so live tracking starts
 *      from zero with your real starting balance.
 *
 * What gets archived (originals copied, not moved):
 *
 *   SID/closed-positions-sid.json   ->  archive/{date}/closed-positions-sid.json
 *   SID/open-positions-sid.json     ->  archive/{date}/open-positions-sid.json
 *   SID/sid-account.json            ->  archive/{date}/sid-account.json
 *   SID/trades-sid.csv              ->  archive/{date}/trades-sid.csv
 *   SID/sid-log.json                ->  archive/{date}/sid-log.json
 *
 * After archive, the live files are reset:
 *
 *   closed-positions-sid.json  ->  []
 *   open-positions-sid.json    ->  []
 *   sid-account.json           ->  { accountUsd: <NEW_STARTING>, ... }
 *   trades-sid.csv             ->  header line only
 *   sid-log.json               ->  []
 *
 * The archive folder is also annotated with a metadata.json describing
 * what era this was (e.g. "paper-trading 2026-05-15 -> 2026-08-15") so
 * the dashboard can group + label them correctly later.
 *
 * USAGE:
 *   cd SID
 *   node scripts/archive-and-reset.js --confirm --starting-balance=10000 --label="paper-trading"
 *
 *   Flags (all required to prevent accidents):
 *     --confirm                   acknowledge this will reset live state
 *     --starting-balance=<usd>    the new starting balance for the reset
 *     --label=<text>              short label for the archive (e.g. "paper-trading")
 *
 *   Optional:
 *     --dry-run                   print what would happen, don't actually do it
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const SID_DIR    = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(SID_DIR, 'archive');

// ─── Files to archive + reset ──────────────────────────────────────────
const FILES = [
  { name: 'closed-positions-sid.json', resetValue: '[]\n' },
  { name: 'open-positions-sid.json',   resetValue: '[]\n' },
  { name: 'sid-log.json',              resetValue: '[]\n' },
];
const CSV_FILE = {
  name: 'trades-sid.csv',
  resetValue: 'Date,Time,Exchange,Symbol,Side,Shares,Entry Price,Stop Loss,Total USD,Risk USD,Risk %,Signal Date,Order ID,Mode,Strategy\n',
};
const ACCOUNT_FILE = 'sid-account.json';

// ─── Arg parsing ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { confirm: false, dryRun: false, startingBalance: null, label: null };
  for (const a of argv.slice(2)) {
    if (a === '--confirm') args.confirm = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--starting-balance=')) args.startingBalance = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--label=')) args.label = a.split('=')[1];
  }
  return args;
}

// ─── Main ──────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);

  if (!args.confirm) {
    console.error('REFUSE: --confirm is required. This script resets live state.');
    console.error('Example: node scripts/archive-and-reset.js --confirm --starting-balance=10000 --label="paper-trading"');
    process.exit(2);
  }
  if (!args.startingBalance || isNaN(args.startingBalance) || args.startingBalance <= 0) {
    console.error('REFUSE: --starting-balance=<usd> is required (must be a positive number).');
    process.exit(2);
  }
  if (!args.label || !args.label.match(/^[a-z0-9_-]+$/i)) {
    console.error('REFUSE: --label=<text> is required (alphanumeric + dash + underscore only).');
    process.exit(2);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const archiveSubdir = path.join(ARCHIVE_DIR, `${todayIso}_${args.label}`);

  console.log('━━ SID Archive + Reset ━━\n');
  console.log(`Source:  ${SID_DIR}`);
  console.log(`Archive: ${archiveSubdir}`);
  console.log(`New starting balance: $${args.startingBalance.toFixed(2)}`);
  console.log(`Label: ${args.label}`);
  console.log(`Mode:  ${args.dryRun ? 'DRY RUN (no changes)' : 'LIVE'}\n`);

  // 1) Snapshot pre-state for the metadata file
  let preAccount = null;
  try {
    preAccount = JSON.parse(fs.readFileSync(path.join(SID_DIR, ACCOUNT_FILE), 'utf8'));
  } catch {}
  let preTradeCount = 0;
  try {
    const closed = JSON.parse(fs.readFileSync(path.join(SID_DIR, 'closed-positions-sid.json'), 'utf8'));
    if (Array.isArray(closed)) preTradeCount = closed.length;
  } catch {}

  // 2) Create archive folder + copy files
  if (!args.dryRun) {
    fs.mkdirSync(archiveSubdir, { recursive: true });
  }

  const allFiles = [...FILES, CSV_FILE, { name: ACCOUNT_FILE, resetValue: null }];
  for (const f of allFiles) {
    const src = path.join(SID_DIR, f.name);
    if (!fs.existsSync(src)) {
      console.log(`  - ${f.name}: missing, skip`);
      continue;
    }
    const dest = path.join(archiveSubdir, f.name);
    if (args.dryRun) {
      console.log(`  - ${f.name}: would copy to ${path.relative(SID_DIR, dest)}`);
    } else {
      fs.copyFileSync(src, dest);
      console.log(`  - ${f.name}: archived (${fs.statSync(src).size} bytes)`);
    }
  }

  // 3) Write metadata
  const metadata = {
    archived_at: new Date().toISOString(),
    label: args.label,
    note: `Snapshot taken before reset to live trading (new starting balance $${args.startingBalance.toFixed(2)}).`,
    pre_reset_state: {
      account: preAccount,
      closed_trade_count: preTradeCount,
    },
  };
  if (!args.dryRun) {
    fs.writeFileSync(
      path.join(archiveSubdir, 'metadata.json'),
      JSON.stringify(metadata, null, 2),
    );
  }
  console.log(`\n  metadata.json written (${preTradeCount} historical trades preserved)`);

  // 4) Reset active files
  console.log('\nResetting active files...');
  for (const f of FILES) {
    if (!args.dryRun) fs.writeFileSync(path.join(SID_DIR, f.name), f.resetValue);
    console.log(`  - ${f.name}: reset to ${args.dryRun ? '(would write)' : 'empty'}`);
  }
  if (!args.dryRun) fs.writeFileSync(path.join(SID_DIR, CSV_FILE.name), CSV_FILE.resetValue);
  console.log(`  - ${CSV_FILE.name}: reset to header-only`);

  const newAccount = {
    accountUsd:    args.startingBalance,
    startingUsd:   args.startingBalance,
    realizedPnl:   0,
    tradeCount:    0,
    lastUpdated:   todayIso,
  };
  if (!args.dryRun) {
    fs.writeFileSync(path.join(SID_DIR, ACCOUNT_FILE), JSON.stringify(newAccount, null, 2));
  }
  console.log(`  - ${ACCOUNT_FILE}: reset to $${args.startingBalance.toFixed(2)} starting balance`);

  console.log('\nDone.');
  console.log(`Archive saved at: ${archiveSubdir}`);
  if (args.dryRun) console.log('\n(DRY RUN — no files were actually modified.)');
}

main();
