/**
 * SID — Railway CRON runner (v2.6.0)
 * ==================================
 *
 * ONE CYCLE, THEN EXIT. There is deliberately NO setInterval here: this service
 * is driven by Railway's own **Cron Schedule** field (service Settings → Cron
 * Schedule), which starts the start command on a crontab expression and bills
 * only for execution time. See SID/RAILWAY-DEPLOY.md for the UI steps.
 *
 * WHY THIS EXISTS
 * ---------------
 * GitHub Actions scheduled crons are best-effort and have been landing ~3 hours
 * late for SID (14:35 -> ~18:15, 18:35 -> ~21:10 UTC). On 2026-09-09 IBM's TP2
 * ripened in the last ~35 minutes of the session and the next run landed 21:06
 * UTC — after the close — so the exit was refused and slipped. v2.6.0's
 * queue-for-open exits fix the "after the close" half; this runner fixes the
 * "the run never lands when it should" half by giving SID a scheduler that
 * Railway documents as varying "by a few minutes" rather than by hours.
 *
 * WHY CRON AND NOT AN ALWAYS-ON LOOP
 * ----------------------------------
 *   • Cost: a daily-bar strategy needs seconds of work per cycle. An always-on
 *     Node worker resident 24/7 would add a multiple of the whole current
 *     Railway bill; a cron service bills execution time.
 *   • Overlap safety for free: Railway "does not automatically terminate
 *     deployments. As a result, if a previous execution is still running when
 *     the next scheduled execution is due, Railway will skip the new cron job."
 *     So this runner cannot race ITSELF. (It can still race a GitHub Actions
 *     run — see CONCURRENCY below.)
 *   • Each execution is exactly what sid.yml already does (pull state -> run the
 *     bot once -> push state -> exit), so there is no novel scheduler, crash-
 *     recovery or memory profile to get wrong, and no in-process DST handling.
 * The always-on loop remains the documented FALLBACK — see RAILWAY-DEPLOY.md
 * § "If Railway cron proves unreliable".
 *
 * CYCLE SHAPE
 * -----------
 *   1. Assert every required env var is present (hard-fail, names only, never a
 *      value and never a `|| '<literal>'` fallback).
 *   2. Pull the current state + config files from the state branch (default
 *      `main`) through the GitHub Contents API, remembering each file's sha.
 *   3. Ask Alpaca's /v2/clock whether the market is open — NEVER a hardcoded
 *      market calendar, so US DST and holidays are the broker's problem.
 *        open   -> FULL cycle (entries may fire)
 *        closed -> CHEAP cycle (SID_EXITS_ONLY=true): positions are reconciled
 *                  and a ripe exit is still QUEUED for the next open, but the
 *                  112-ticker Yahoo entry scan is skipped — an entry would be
 *                  refused out of hours anyway.
 *        unreadable -> CHEAP cycle (never enter blind).
 *   4. Run `node bot-sid.js` once.
 *   5. Push back only the state files WE changed, sha-aware, with a re-pull and
 *      one retry on conflict.
 *   6. Exit 0 if the cycle completed. A non-zero exit is reserved for a
 *      CONFIGURATION failure, so it shows up as a failed Railway run rather than
 *      being hidden.
 *
 * CONCURRENCY (Phase 1 runs this ALONGSIDE the sid.yml crons)
 * ----------------------------------------------------------
 * Local state can be stale, so correctness cannot rest on it. The hard guard is
 * at the BROKER: every v2.6.0 queued exit carries a deterministic
 * client_order_id (`SID-<SYM>-<tag>-<YYYYMMDD>[-a<n>]`) and every entry carries
 * `<prefix>-entry` (prefix = symbol + signal date + side), so a concurrent
 * second submission is rejected by Alpaca as a duplicate instead of
 * double-selling or double-buying. See SID/CLAUDE.md § v2.6.0 for the full
 * per-path audit, including the two residual risks that are documented rather
 * than fixed.
 *
 * STATE BRANCH IS `main`, NOT Ironclad's `logs` BRANCH — sid-dashboard.yml
 * builds the dashboard from main, so SID state has to land there.
 *
 * ⚠ This file is SID-owned. Ironclad's `railway-runner.js` and the root
 * `railway.json` are a SEPARATE service and must not be touched.
 */

import { execFileSync } from 'child_process';
import fetch            from 'node-fetch';
import fs               from 'fs';
import path             from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

/** Ships with bot-sid.js — keep in lockstep with BOT_VERSION. */
export const RUNNER_VERSION = 'v2.6.0';

// ── Configuration (NO credential values, NO literal fallbacks) ───────────────

// `SID_GITHUB_TOKEN` is preferred so the SID service can hold its own token
// independently of the Ironclad service in the same Railway project; plain
// `GITHUB_TOKEN` is accepted for convenience. Neither has a default — a missing
// token is a hard failure, never a silent degrade.
const GITHUB_TOKEN = process.env.SID_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const OWNER        = process.env.GITHUB_OWNER || 'ballikov-lgtm';
const REPO         = process.env.GITHUB_REPO  || 'BotTrading';
const BRANCH       = process.env.SID_STATE_BRANCH || 'main';
const DRY_PUSH     = process.env.SID_RUNNER_DRY_PUSH === 'true';

// State files the bot WRITES. Mirrors the `git add` list in
// .github/workflows/sid.yml so the two runners keep the same books.
//   `merge` — how to resolve a push conflict (remote moved under us):
//     'byId'       append-only array keyed on `id` (remote first, local wins on a tie)
//     'csvAppend'  header + union of data lines (remote order, then local-only)
//     'local'      our file wins, logged loudly — we just acted at the broker,
//                  so our view is the one that reflects reality
const STATE_FILES = [
  { p: 'SID/open-positions-sid.json',    merge: 'local'     },
  { p: 'SID/closed-positions-sid.json',  merge: 'byId'      },
  { p: 'SID/pending-approvals-sid.json', merge: 'byId'      },
  { p: 'SID/trades-sid.csv',             merge: 'csvAppend' },
  { p: 'SID/sid-account.json',           merge: 'local'     },
  { p: 'SID/sid-log.json',               merge: 'local'     },
  { p: 'SID/alpaca-account-sid.json',    merge: 'local'     },
  { p: 'SID/alpaca-account-live-sid.json', merge: 'local'   },
];

// Read-only config pulled so a cron execution always runs the CURRENT universe
// even if a redeploy was skipped by watch paths. Never pushed.
const CONFIG_FILES = [
  'SID/watchlist-sid.json',
  'SID/event-dates.json',
  'SID/asset-classification.json',
  'SID/rules-sid.json',
];

const pulled = new Map();   // repoPath -> { sha, content|null }

// ── Env assertion ────────────────────────────────────────────────────────────

/**
 * Hard-fail on a missing required variable, reporting NAMES ONLY.
 * Never prints, logs or defaults a credential value.
 */
function assertEnv() {
  const missing = [];
  if (!GITHUB_TOKEN) missing.push('SID_GITHUB_TOKEN (or GITHUB_TOKEN)');
  if (!process.env.ALPACA_KEY_ID)     missing.push('ALPACA_KEY_ID');
  if (!process.env.ALPACA_SECRET_KEY) missing.push('ALPACA_SECRET_KEY');
  if (!process.env.SID_TRADING_MODE)  missing.push('SID_TRADING_MODE');

  if (missing.length) {
    console.error('\n[SID-RAILWAY] FATAL — required environment variable(s) not set:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nSet them on the SID Railway service (Variables tab). See SID/RAILWAY-DEPLOY.md.');
    console.error('Refusing to run: without Alpaca credentials the bot silently degrades to dry_run and');
    console.error('would manage NOTHING while appearing to succeed, and without a GitHub token every');
    console.error('cycle would start from stale state and lose its own writes.');
    process.exit(1);
  }

  const mode = String(process.env.SID_TRADING_MODE).toLowerCase().trim();
  if (!['dry_run', 'paper', 'live'].includes(mode)) {
    console.error(`[SID-RAILWAY] FATAL — SID_TRADING_MODE is not one of dry_run | paper | live.`);
    process.exit(1);
  }
  if (mode === 'live' && !process.env.SID_LIVE_CONFIRMED) {
    console.error('[SID-RAILWAY] FATAL — SID_TRADING_MODE=live without SID_LIVE_CONFIRMED.');
    console.error('A half-configured live service is worse than a failed run: the executor would');
    console.error('silently downgrade to paper while the schedule looks healthy. Set both or neither.');
    process.exit(1);
  }
  console.log(`[SID-RAILWAY] SID Railway cron runner ${RUNNER_VERSION}`);
  console.log(`[SID-RAILWAY] Mode: ${mode.toUpperCase()}  state branch: ${BRANCH}  repo: ${OWNER}/${REPO}`);
  if (DRY_PUSH) console.log('[SID-RAILWAY] SID_RUNNER_DRY_PUSH=true — state will NOT be pushed this cycle.');
}

// ── GitHub Contents API ──────────────────────────────────────────────────────
// Deliberately the Contents API rather than the git CLI (the same choice
// Ironclad's runner made): no checkout, no credential helper, no rebase
// machinery, and each write is an explicit sha-guarded compare-and-set.

async function githubRequest(method, apiPath, body = null) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github+json',
      'User-Agent':    'sid-railway-runner',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, json };
}

/** Fetch one file's { sha, content } from the state branch. Missing file -> nulls. */
async function fetchRemote(repoPath) {
  const { status, ok, json } = await githubRequest(
    'GET', `/repos/${OWNER}/${REPO}/contents/${encodeURI(repoPath)}?ref=${encodeURIComponent(BRANCH)}`);
  if (status === 404) return { sha: null, content: null };
  if (!ok || !json?.content) {
    throw new Error(`GET ${repoPath} failed (HTTP ${status}): ${json?.message || 'no content'}`);
  }
  return { sha: json.sha, content: Buffer.from(json.content, 'base64').toString('utf8') };
}

/** Pull a file onto disk and remember what we pulled (sha + bytes). */
async function pullFile(repoPath, { remember = true } = {}) {
  const local = path.join(REPO_ROOT, repoPath);
  try {
    const { sha, content } = await fetchRemote(repoPath);
    if (content === null) {
      if (remember) pulled.set(repoPath, { sha: null, content: null });
      console.log(`  v ${repoPath} — not on ${BRANCH} yet (will be created on push if the bot writes it)`);
      return;
    }
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, content);
    if (remember) pulled.set(repoPath, { sha, content });
    console.log(`  v ${repoPath} (${content.length} bytes)`);
  } catch (err) {
    // A failed pull means we would run against the IMAGE's stale copy and could
    // then push it over newer cloud state. Abort the cycle instead.
    throw new Error(`State pull failed for ${repoPath}: ${err.message}`);
  }
}

// ── Conflict merges ──────────────────────────────────────────────────────────

function mergeById(remoteText, localText) {
  const r = JSON.parse(remoteText), l = JSON.parse(localText);
  if (!Array.isArray(r) || !Array.isArray(l)) throw new Error('mergeById expects arrays');
  const out = new Map();
  // Every real record has an `id` (closed records carry the broker order id;
  // pending approvals carry the deterministic `${symbol}-${signalDate}-${side}`).
  // A record WITHOUT one is keyed by its POSITION — deliberately the same key on
  // both sides, because `local` was derived from `remote` by this same cycle's
  // pull, so position i is the same record. Keeping them under one key means an
  // id-less record is neither dropped nor duplicated. Do not "fix" this into
  // separate remote/local position keys: that silently duplicates records.
  const key = (x, i) => (x && x.id != null) ? `id:${x.id}` : `pos:${i}`;
  r.forEach((x, i) => out.set(key(x, i), x));
  l.forEach((x, i) => out.set(key(x, i), x));   // local wins on a tie
  return JSON.stringify([...out.values()], null, 2);
}

function mergeCsvAppend(remoteText, localText) {
  const rl = remoteText.replace(/\r\n/g, '\n').split('\n');
  const ll = localText.replace(/\r\n/g, '\n').split('\n');
  const header = ll[0] || rl[0] || '';
  const seen = new Set();
  const rows = [];
  for (const line of [...rl.slice(1), ...ll.slice(1)]) {
    if (!line.trim() || seen.has(line)) continue;
    seen.add(line); rows.push(line);
  }
  return [header, ...rows].join('\n') + '\n';
}

function resolveConflict(repoPath, strategy, remoteText, localText) {
  try {
    if (strategy === 'byId')      return { text: mergeById(remoteText, localText), how: 'merged by id' };
    if (strategy === 'csvAppend') return { text: mergeCsvAppend(remoteText, localText), how: 'merged CSV rows' };
  } catch (err) {
    console.log(`  ! ${repoPath}: merge failed (${err.message}) — falling back to LOCAL`);
    return { text: localText, how: 'LOCAL (merge failed)' };
  }
  return { text: localText, how: 'LOCAL wins (we just acted at the broker)' };
}

// ── Push ─────────────────────────────────────────────────────────────────────

async function putFile(repoPath, text, sha, message) {
  const body = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch:  BRANCH,
    ...(sha ? { sha } : {}),
  };
  return githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURI(repoPath)}`, body);
}

/**
 * Push back only the files WE changed.
 *
 * Unchanged files are skipped entirely — that keeps quiet cycles from writing
 * anything at all, which both removes any chance of clobbering a concurrent
 * writer and stops a redeploy being triggered on every cron tick.
 */
async function pushState(commitStamp) {
  let pushed = 0, skipped = 0, failed = 0;
  for (const { p: repoPath, merge } of STATE_FILES) {
    const local = path.join(REPO_ROOT, repoPath);
    if (!fs.existsSync(local)) { skipped++; continue; }
    const localText = fs.readFileSync(local, 'utf8');
    const before    = pulled.get(repoPath);

    if (before && before.content !== null && before.content === localText) { skipped++; continue; }
    if (DRY_PUSH) { console.log(`  ^ ${repoPath} — CHANGED (dry push, not sent)`); pushed++; continue; }

    const message = `SID railway run ${commitStamp}`;
    let sha = before ? before.sha : null;
    let text = localText;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // Re-read the remote head so a conflict is detected BEFORE the PUT, not
      // only from a 409 — the sha we pulled may be minutes old.
      let head;
      try { head = await fetchRemote(repoPath); }
      catch (err) { console.log(`  ! ${repoPath}: could not re-read head (${err.message})`); head = null; }

      if (head && head.sha && before && before.sha && head.sha !== before.sha) {
        const { text: merged, how } = resolveConflict(repoPath, merge, head.content ?? '', localText);
        text = merged;
        console.log(`  ! ${repoPath}: remote moved under us (${before.sha.slice(0, 7)} -> ${head.sha.slice(0, 7)}) — ${how}`);
      }
      if (head) sha = head.sha;

      const res = await putFile(repoPath, text, sha, message);
      if (res.ok) { console.log(`  ^ ${repoPath} -> ${BRANCH}`); pushed++; break; }
      if (res.status === 409 && attempt === 1) {
        console.log(`  ! ${repoPath}: 409 conflict — re-reading and retrying once`);
        continue;
      }
      console.log(`  X ${repoPath}: push failed (HTTP ${res.status}) ${res.json?.message || ''}`);
      failed++;
      break;
    }
  }
  console.log(`  -- state push: ${pushed} written, ${skipped} unchanged, ${failed} failed --`);
  return { pushed, skipped, failed };
}

// ── Market clock (broker, never a hardcoded calendar) ────────────────────────

/**
 * @returns {{ open: boolean|null, detail: string }}
 *   open === null means the clock could not be read; the caller must then take
 *   the CHEAP path (never enter blind).
 */
async function readMarketClock() {
  try {
    const { AlpacaClient } = await import('./alpaca-client.js');
    const base = process.env.ALPACA_BASE_URL
      || (String(process.env.SID_TRADING_MODE).toLowerCase() === 'live'
            ? 'https://api.alpaca.markets'
            : 'https://paper-api.alpaca.markets');
    const client = new AlpacaClient({ baseUrl: base });
    const clock  = await client.getClock();   // read-only GET
    return {
      open: clock?.is_open === true,
      detail: `is_open=${clock?.is_open} now=${clock?.timestamp} next_open=${clock?.next_open} next_close=${clock?.next_close}`,
    };
  } catch (err) {
    return { open: null, detail: `clock unavailable: ${err.message}` };
  }
}

// ── One cycle ────────────────────────────────────────────────────────────────

async function runCycle() {
  const started = Date.now();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  SID Railway cron cycle — ${stamp}`);
  console.log(`${'='.repeat(62)}`);

  // 1. Pull state + config from the state branch.
  console.log(`\n-- Pulling state from ${OWNER}/${REPO}@${BRANCH} --`);
  for (const f of CONFIG_FILES) await pullFile(f, { remember: false });
  for (const { p } of STATE_FILES) await pullFile(p);

  // 2. Decide the cycle type from the BROKER's clock.
  const clock = await readMarketClock();
  const full  = clock.open === true;
  console.log(`\n-- Market clock -- ${clock.detail}`);
  console.log(full
    ? '   Market OPEN -> FULL cycle (position management + entry scan)'
    : `   Market CLOSED${clock.open === null ? ' (clock unreadable — treating as closed)' : ''} -> CHEAP cycle (SID_EXITS_ONLY): reconcile pending exits + queue ripe exits for the open, no entry scan`);

  // 3. Run the bot ONCE. A bot crash must not stop us pushing whatever state it
  //    already wrote (a booked exit must reach the cloud).
  console.log('\n-- Running bot-sid.js --');
  let botFailed = null;
  try {
    execFileSync(process.execPath, ['bot-sid.js'], {
      cwd:   __dirname,
      stdio: 'inherit',
      env:   { ...process.env, ...(full ? {} : { SID_EXITS_ONLY: 'true' }) },
      timeout: 10 * 60 * 1000,
    });
  } catch (err) {
    botFailed = `exit ${err.status ?? 'n/a'}${err.signal ? ` signal ${err.signal}` : ''}: ${err.message}`;
    console.error(`\n[SID-RAILWAY] bot-sid.js did not exit cleanly — ${botFailed}`);
    console.error('[SID-RAILWAY] Continuing to the state push so nothing the bot DID write is lost.');
  }

  // 4. Push changed state back.
  console.log(`\n-- Pushing changed state to ${BRANCH} --`);
  const push = await pushState(stamp);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  Cycle complete in ${secs}s — cycle=${full ? 'FULL' : 'CHEAP'} bot=${botFailed ? 'FAILED' : 'ok'} pushed=${push.pushed} failed=${push.failed}`);
  console.log(`${'='.repeat(62)}\n`);
  return { botFailed, push };
}

// ── Entry point ──────────────────────────────────────────────────────────────
//
// EXIT CODE POLICY. Railway skips a scheduled run while the previous one is
// still Active, and the docs do not promise a retry on a non-zero exit — so a
// non-zero exit buys nothing operationally and risks a restart loop
// (railway-sid.json therefore sets restartPolicyType NEVER).
//   exit 1  CONFIGURATION failure only (missing/invalid env) — must be loud and
//           visible as a failed run, because every cycle will fail until fixed.
//   exit 0  the cycle ran. A bot-level error inside the cycle is logged (and
//           Telegram-alerted by the bot itself) but does not fail the run; the
//           next cron tick retries, which is the correct behaviour for a
//           transient Yahoo/Alpaca hiccup.

// Only act when executed DIRECTLY (which is how Railway's start command invokes
// it). When imported — by the regression suite — skip the side effects so the
// pure helpers can be unit-tested. Same main-guard pattern as bot-sid.js and
// reconcile-account.js.
const _isDirectRun = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (_isDirectRun) {
  // `--version` is a side-effect-free liveness probe: it proves the module loads
  // and reports its version at RUNTIME without touching GitHub or Alpaca.
  if (process.argv.includes('--version')) {
    console.log(`SID Railway cron runner ${RUNNER_VERSION}`);
    process.exit(0);
  }

  assertEnv();

  runCycle()
    .then(() => process.exit(0))
    .catch(err => {
      // Reaching here means the CYCLE scaffolding failed (e.g. the state pull),
      // not the bot. Exit 0 anyway: the next tick re-pulls and retries, and a
      // non-zero exit cannot trigger a retry on Railway's cron.
      console.error(`[SID-RAILWAY] Cycle aborted: ${err.message}`);
      console.error('[SID-RAILWAY] No state was pushed. The next scheduled cycle retries from clean cloud state.');
      process.exit(0);
    });
}

export { runCycle, assertEnv, pushState, mergeById, mergeCsvAppend, resolveConflict, readMarketClock, STATE_FILES, CONFIG_FILES };
