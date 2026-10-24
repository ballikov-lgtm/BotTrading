/**
 * SID — Railway CRON runner (v2.6.1)
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
 * v2.6.1 — WHY ENTRIES NOW ONLY HAPPEN AT THE CLOSE
 * -------------------------------------------------
 * `bot-sid.js` defines an entry as `entry = close` (:2512). The strategy enters
 * on the SIGNAL BAR'S CLOSE, so every mid-session run is judging an UNFINISHED
 * daily bar: the RSI, the MACD direction and the entry price are all computed
 * from whatever the last trade happened to be at that moment. Measured on three
 * real SID entries, the price the bot booked as "the close" was 0.48% / 0.49% /
 * 0.03% away from that day's actual close — and on a trade whose stop sits ~2.7%
 * below entry, half a percent is ~18% of the risk unit.
 *
 * The scheduling half is worse. Over the 25 trading days to 2026-10-23, SEVEN
 * (28%) had NO sid.yml run land inside market hours at all — every run arrived
 * after the 20:00 UTC close, where the executor refuses every order. MCD is the
 * measured miss: `detectEntrySignal` returns LONG on both the 2026-10-05 and the
 * 2026-10-08 bar, and on BOTH days every run landed after the close
 * (05 Oct: 21:34 / 22:53 / 00:17 · 08 Oct: 20:01 / 21:27 / 23:31 UTC).
 *
 * So: the only faithful moment to act on an entry is the last few minutes of the
 * session. A cycle that starts inside the CLOSE WINDOW (default the final 20
 * minutes) WAITS until T-minus ENTRY_SUBMIT_OFFSET_MIN (default 3 minutes) and
 * only then runs the bot, so the bar it evaluates is effectively the closing bar.
 * Every other cycle manages exits and does NOT scan for entries.
 *
 * Both numbers are env-overridable (`SID_CLOSE_WINDOW_MIN`,
 * `SID_ENTRY_SUBMIT_OFFSET_MIN`) because the right offset is an empirical
 * question — a full in-hours bot run measured 51s of 112-ticker scan, ~60s
 * end-to-end, so T-3 leaves ~2x headroom, but if Yahoo ever slows, moving to
 * T-15 must be a variable change and not a redeploy of new logic.
 *
 * THE WINDOW COMES FROM THE BROKER, NOT A HARDCODED HOUR. It is derived from
 * `/v2/clock`'s `next_close` for the CURRENT session, so the November DST switch
 * and the half-day sessions (e.g. 2026-11-27 closes 13:00 ET) are the broker's
 * problem. ET is read with the SAME discipline as
 * `alpaca-executor.js#etMinutesOfDay`: the offset must be -04:00 or -05:00, so a
 * future API change to `Z` makes the window UNREADABLE (-> no entry scan) rather
 * than silently reading UTC digits as Eastern.
 *
 * EXITS ARE UNTOUCHED by this release. They can ripen intraday, they are already
 * handled every cycle, and v2.6.0's queue-for-open covers the out-of-hours case.
 * ENTRIES ARE STILL NEVER QUEUED for the next open — a signal must be evaluated
 * against a fresh bar, which is precisely what the close window achieves.
 *
 * CYCLE SHAPE
 * -----------
 *   1. Assert every required env var is present (hard-fail, names only, never a
 *      value and never a `|| '<literal>'` fallback).
 *   2. Ask Alpaca's /v2/clock whether the market is open and how long is left in
 *      the session — NEVER a hardcoded market calendar, so US DST and holidays
 *      are the broker's problem.
 *        open, inside the close window -> WAIT to T-3, re-read the clock, then
 *                  FULL cycle (position management + entry scan)
 *        open, outside the window      -> CHEAP cycle (SID_EXITS_ONLY=true)
 *        closed                        -> CHEAP cycle: positions are reconciled
 *                  and a ripe exit is still QUEUED for the next open, but the
 *                  112-ticker Yahoo entry scan is skipped — an entry would be
 *                  refused out of hours anyway.
 *        unreadable                    -> CHEAP cycle (never enter blind).
 *   3. Pull the current state + config files from the state branch (default
 *      `main`) through the GitHub Contents API, remembering each file's sha.
 *      DELIBERATELY AFTER THE WAIT: pulling first and then sleeping 17 minutes
 *      would run the bot against state up to 17 minutes stale, which a
 *      concurrent GitHub Actions run could have moved under us.
 *   4. Run `node bot-sid.js` once.
 *   5. Push back only the state files WE changed, sha-aware, with a re-pull and
 *      one retry on conflict.
 *   6. Exit 0 if the cycle completed. A non-zero exit is reserved for a
 *      CONFIGURATION failure, so it shows up as a failed Railway run rather than
 *      being hidden.
 *
 * WHAT HAPPENS TO THE CRON TICK THAT WOULD FIRE DURING THE WAIT
 * ------------------------------------------------------------
 * Railway "does not automatically terminate deployments. As a result, if a
 * previous execution is still running when the next scheduled execution is due,
 * Railway will skip the new cron job." On a 15-minute cron with a 20-minute
 * window the waiting cycle spans at most ONE intervening tick, and THAT TICK IS
 * SKIPPED.
 * That is harmless, and is in fact the overlap guard doing its job:
 *   • the skipped tick would have been an EXIT cycle, and the waiting cycle runs
 *     exit management itself when it wakes — still in-hours, only later;
 *   • SID's exits are daily-bar triggers (RSI 50, SMA50/200 touch), so
 *     evaluating them at T-3 is strictly MORE faithful than at T-17;
 *   • intraday protection never depended on the bot: the stop is a resting GTC
 *     order at the broker for the whole wait;
 *   • anything still ripe after the bell is queued for the next open by the
 *     first post-close tick (v2.6.0).
 * It also means the window can never produce two entry scans in one session: if
 * the window is widened to span several ticks, the first one claims the slot and
 * Railway skips the rest — which is useful redundancy, see RAILWAY-DEPLOY.md.
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
// The idiomatic Node promise-based delay. Deliberately NOT the global timer: this
// is ONE bounded await inside a single cycle, not a resident scheduler. The
// one-shot shape (no repeating timer, runCycle invoked exactly once behind a
// main-guard) is asserted by the v2.6.0 suite's L1/L1b and the v2.6.1 suite's
// P-group bounds the wait itself.
import { setTimeout as sleepMs } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

/** Ships with bot-sid.js — keep in lockstep with BOT_VERSION. */
export const RUNNER_VERSION = 'v2.6.1';

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

// ── v2.6.1 close-window timing (NAMED, env-overridable — never a magic number) ─
//
// `intEnv` preserves a legitimate 0 (which `parseInt(x) || def` would clobber) —
// the same helper shape bot-sid.js uses for rearmCooldownLong. A 0 here is
// meaningful in BOTH knobs:
//   SID_CLOSE_WINDOW_MIN=0        -> the runner NEVER scans for entries. A
//                                    deliberate "exits only from Railway" switch.
//   SID_ENTRY_SUBMIT_OFFSET_MIN=0 -> scan as late as the clamp allows (the wait
//                                    still stops a minute short of the bell; see
//                                    planEntryWindow).
function intEnv(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** How close to the bell a cycle must start for it to be THE entry cycle. */
export const CLOSE_WINDOW_MIN = intEnv(process.env.SID_CLOSE_WINDOW_MIN, 20);

/**
 * Minutes before the close at which the entry scan is actually run.
 *
 * Why 3 and not 0: the bot needs time to finish. A full in-hours run measured
 * 51s of 112-ticker Yahoo scan and ~60s end-to-end on 2026-10-23, and the cycle
 * adds a state pull/push on top, so T-3 (180s) is ~2x headroom. Why not 15: the
 * later we look, the closer `entry = close` is to the real close. If Yahoo ever
 * slows this is the ONE number to raise.
 */
export const ENTRY_SUBMIT_OFFSET_MIN = intEnv(process.env.SID_ENTRY_SUBMIT_OFFSET_MIN, 3);

/**
 * Absolute ceiling on a single wait, in minutes. Belt-and-braces only: the wait
 * is already bounded by the window itself. This exists so a fat-fingered
 * SID_CLOSE_WINDOW_MIN=600 cannot pin the container for ten hours (and, with
 * Railway's overlap rule, starve every exit cycle behind it).
 */
export const MAX_ENTRY_WAIT_MIN = intEnv(process.env.SID_MAX_ENTRY_WAIT_MIN, 30);

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

  // v2.6.1 — say the timing out loud every cycle, and flag a degenerate config.
  // These are WARNINGS, never a hard fail: a mis-tuned window costs an entry
  // opportunity, which is not worth refusing to manage live positions over.
  console.log(`[SID-RAILWAY] Entries: close window ${CLOSE_WINDOW_MIN}m, scan at T-${ENTRY_SUBMIT_OFFSET_MIN}m, wait capped at ${MAX_ENTRY_WAIT_MIN}m.`);
  if (!(CLOSE_WINDOW_MIN > 0)) {
    console.log('[SID-RAILWAY] WARNING — SID_CLOSE_WINDOW_MIN is 0 or negative: this service will NEVER scan for entries.');
    console.log('              Exits are still managed every cycle. Unset the variable to restore the 20m default.');
  } else if (ENTRY_SUBMIT_OFFSET_MIN >= CLOSE_WINDOW_MIN) {
    console.log(`[SID-RAILWAY] WARNING — SID_ENTRY_SUBMIT_OFFSET_MIN (${ENTRY_SUBMIT_OFFSET_MIN}) >= SID_CLOSE_WINDOW_MIN (${CLOSE_WINDOW_MIN}):`);
    console.log('              the first in-window cycle scans immediately instead of waiting. Widen the window.');
  }
  if (ENTRY_SUBMIT_OFFSET_MIN < 0) {
    console.log('[SID-RAILWAY] WARNING — SID_ENTRY_SUBMIT_OFFSET_MIN is negative; it is treated as "scan as late as allowed".');
  }
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
  let pushed = 0, skipped = 0, failed = 0, dry = 0;
  for (const { p: repoPath, merge } of STATE_FILES) {
    const local = path.join(REPO_ROOT, repoPath);
    if (!fs.existsSync(local)) { skipped++; continue; }
    const localText = fs.readFileSync(local, 'utf8');
    const before    = pulled.get(repoPath);

    if (before && before.content !== null && before.content === localText) { skipped++; continue; }
    // v2.6.1 — a dry-push cycle sent NOTHING, so it must not be counted as
    // `pushed`. It is a skip, with `dry` recording what WOULD have gone.
    if (DRY_PUSH) { console.log(`  ~ ${repoPath} — CHANGED (dry push, not sent) -> skipped`); skipped++; dry++; continue; }

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
  console.log(`  -- state push: ${pushed} written, ${skipped} skipped${dry ? ` (${dry} of them dry-push)` : ''}, ${failed} failed --`);
  return { pushed, skipped, failed, dry };
}

// ── Market clock (broker, never a hardcoded calendar) ────────────────────────

/**
 * @returns {{ open: boolean|null, detail: string, raw: object|null }}
 *   open === null means the clock could not be read; the caller must then take
 *   the CHEAP path (never enter blind). `raw` is the untouched /v2/clock payload,
 *   which v2.6.1's planEntryWindow needs for `next_close`.
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
      raw: clock || null,
    };
  } catch (err) {
    return { open: null, detail: `clock unavailable: ${err.message}`, raw: null };
  }
}

// ── v2.6.1 — the CLOSE WINDOW, derived from the broker's own clock ───────────

/**
 * Eastern wall-clock fields parsed out of an Alpaca clock timestamp.
 *
 * SAME DISCIPLINE AS `alpaca-executor.js#etMinutesOfDay` (v2.6.0): Alpaca stamps
 * both `timestamp` and `next_close` with an ET offset (-04:00 in EDT, -05:00 in
 * EST), so the HH:MM digits are ALREADY Eastern wall-clock and the DST switch is
 * the broker's problem. **The offset is ASSERTED** precisely so that if Alpaca
 * ever changes the field to `Z` (UTC) we return null — and the caller takes the
 * safe no-entry branch — instead of silently reading UTC digits as Eastern.
 *
 * Not shared with the executor's helper on purpose: that one is a method bound to
 * a live executor's `this.clock` and only ever reads `timestamp`, while this one
 * must also parse `next_close` and expose the DATE so we can prove the close
 * belongs to the CURRENT session. The v2.6.1 suite asserts the two agree on the
 * same input in both offsets, so they cannot drift apart unnoticed.
 *
 * @param {string} ts  e.g. '2026-10-23T15:45:12.123456789-04:00'
 * @returns {{ minutes:number, isoDate:string, offset:string }|null}
 */
export function etFields(ts) {
  const s = typeof ts === 'string' ? ts.trim() : '';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(s);
  const o = /(-0[45]):00$/.exec(s);          // ET == UTC-4 (EDT) or UTC-5 (EST)
  if (!m || !o) return null;
  const hh = parseInt(m[2], 10), mm = parseInt(m[3], 10);
  if (!(hh >= 0 && hh <= 23) || !(mm >= 0 && mm <= 59)) return null;
  return { minutes: hh * 60 + mm, isoDate: m[1], offset: o[1] };
}

/**
 * Decide, from the broker's clock alone, whether THIS cycle is the entry cycle
 * and how long it should wait before looking.
 *
 * PURE. No clock of our own, no timezone library, no hardcoded session hours —
 * everything comes from the payload, which is why the November DST switch and the
 * half-day sessions (2026-11-27 closes 13:00 ET) need no code change at all.
 *
 * @param {object|null} clock  the /v2/clock payload
 * @param {object} [opts] {windowMin, offsetMin, maxWaitMin} — defaults are the
 *                        module constants; the suite injects its own.
 * @returns {{
 *   marketOpen: boolean, entryScan: boolean, waitMs: number, phase: string,
 *   nowEtMin: number|null, closeEtMin: number|null, minutesToClose: number|null,
 *   submitEtMin: number|null, detail: string
 * }}
 *   phase: 'closed' | 'clock_unreadable' | 'window_disabled' | 'past_close'
 *        | 'pre_window' | 'wait_then_scan' | 'scan_now'
 */
export function planEntryWindow(clock, opts = {}) {
  const windowMin  = Number.isFinite(opts.windowMin)  ? opts.windowMin  : CLOSE_WINDOW_MIN;
  const offsetMin  = Number.isFinite(opts.offsetMin)  ? opts.offsetMin  : ENTRY_SUBMIT_OFFSET_MIN;
  const maxWaitMin = Number.isFinite(opts.maxWaitMin) ? opts.maxWaitMin : MAX_ENTRY_WAIT_MIN;

  const no = (phase, detail, extra = {}) => ({
    marketOpen: clock?.is_open === true,
    entryScan: false, waitMs: 0, phase, detail,
    nowEtMin: null, closeEtMin: null, minutesToClose: null, submitEtMin: null,
    ...extra,
  });

  if (clock?.is_open !== true) {
    return no('closed', 'market closed — exits only, no entry scan');
  }

  const now   = etFields(clock.timestamp);
  const close = etFields(clock.next_close);
  if (!now || !close) {
    // An unparseable/unexpected-offset clock must never be guessed at.
    return no('clock_unreadable',
      'clock timestamp or next_close not readable as ET (-04:00/-05:00) — no entry scan this cycle');
  }
  if (now.isoDate !== close.isoDate) {
    // `is_open` says open, yet next_close belongs to another session. Impossible
    // for US equities; refuse rather than compute a window from the wrong day.
    return no('clock_unreadable',
      `next_close ${close.isoDate} is not the current session ${now.isoDate} — no entry scan this cycle`);
  }

  const nowEtMin       = now.minutes;
  const closeEtMin     = close.minutes;
  const minutesToClose = closeEtMin - nowEtMin;
  const base = { marketOpen: true, nowEtMin, closeEtMin, minutesToClose };

  if (minutesToClose <= 0) {
    return { ...base, entryScan: false, waitMs: 0, phase: 'past_close', submitEtMin: null,
      detail: `clock says open but the close is ${-minutesToClose}m in the past — no entry scan` };
  }
  if (!(windowMin > 0)) {
    return { ...base, entryScan: false, waitMs: 0, phase: 'window_disabled', submitEtMin: null,
      detail: 'SID_CLOSE_WINDOW_MIN=0 — entry scans are disabled on this service' };
  }
  if (minutesToClose > windowMin) {
    return { ...base, entryScan: false, waitMs: 0, phase: 'pre_window', submitEtMin: null,
      detail: `${minutesToClose}m to the close, outside the ${windowMin}m close window — exits only, no entry scan` };
  }

  // Inside the window. Target T-offsetMin, then clamp three ways:
  //   • the configured ceiling (MAX_ENTRY_WAIT_MIN),
  //   • minutesToClose - 1, so we ALWAYS wake at least a minute before the bell
  //     even if offsetMin is 0 — "never sleep past the close" is structural here,
  //     not a comment,
  //   • never negative.
  const submitEtMin = closeEtMin - offsetMin;
  const wantMin     = submitEtMin - nowEtMin;
  const waitMin     = Math.max(0, Math.min(wantMin, maxWaitMin, minutesToClose - 1));

  if (waitMin <= 0) {
    return { ...base, entryScan: true, waitMs: 0, phase: 'scan_now', submitEtMin,
      detail: `${minutesToClose}m to the close, already at/past T-${offsetMin} — scanning for entries NOW` };
  }
  return { ...base, entryScan: true, waitMs: waitMin * 60_000, phase: 'wait_then_scan', submitEtMin,
    detail: `${minutesToClose}m to the close — waiting ${waitMin}m to T-${offsetMin} so the bar being judged is effectively the closing bar` };
}

// ── v2.6.1 — the timing phase of a cycle (read clock, maybe wait, re-read) ───

/**
 * Resolve WHETHER this cycle scans for entries, waiting out the close window if
 * we are inside it.
 *
 * Dependencies are injected so the regression suite can execute THIS EXACT
 * control flow — including the mid-wait abort and the never-sleep-twice guard —
 * with a mocked clock and a fake sleep, rather than re-implementing it (a
 * re-implementation cannot prove the shipped code behaves this way).
 *
 * SAFETY PROPERTIES, all enforced here rather than hoped for:
 *   • The wait is bounded by planEntryWindow (window, MAX_ENTRY_WAIT_MIN, and
 *     minutesToClose-1), so it can never sleep past the bell.
 *   • The clock is RE-READ on waking. If the market closed, halted out, the early
 *     close moved or the clock became unreadable, entries are abandoned — never
 *     fired into a shut market.
 *   • It sleeps AT MOST ONCE per cycle. A backwards-moving broker clock scans
 *     immediately instead of waiting again.
 *
 * @returns {{ marketOpen:boolean, entryScan:boolean, phase:string, plan:object,
 *             clockDetail:string, waitedMs:number, sleeps:number }}
 */
async function resolveEntryWindow({
  readClock = readMarketClock,
  sleep     = sleepMs,
  log       = console.log,
  opts      = {},
} = {}) {
  const clock = await readClock();
  // `full` means THE MARKET IS OPEN. Since v2.6.1 that no longer implies an entry
  // scan: entries happen once a day, in the close window (plan.entryScan below).
  const full  = clock.open === true;
  log(`\n-- Market clock -- ${clock.detail}`);

  let plan = planEntryWindow(clock.raw, opts);
  log(full
    ? `   Market OPEN — ${plan.detail}`
    : `   Market CLOSED${clock.open === null ? ' (clock unreadable — treating as closed)' : ''} -> CHEAP cycle (SID_EXITS_ONLY): reconcile pending exits + queue ripe exits for the open, no entry scan`);

  let waitedMs = 0, sleeps = 0;

  // Inside the close window: WAIT to T-minus the submit offset so the bar the
  // strategy judges is effectively the closing bar.
  //
  // THE CRON TICK THAT WOULD FIRE DURING THIS WAIT IS SKIPPED BY RAILWAY (it
  // never starts a cron run while the previous one is Active). That is intended —
  // see the header block for why it costs nothing.
  if (plan.waitMs > 0) {
    const waitMin = Math.round(plan.waitMs / 60_000);
    log(`\n-- Close window -- waiting ${waitMin}m (to ET ${fmtEt(plan.submitEtMin)}, close ET ${fmtEt(plan.closeEtMin)}) before the entry scan`);
    log('   Exits are evaluated in the SAME run when the wait ends — still in-hours, and a daily-bar');
    log('   trigger read near the bell is strictly more faithful than one read 20m earlier. The resting');
    log('   broker stop protects the position throughout the wait.');
    waitedMs = plan.waitMs;
    await sleep(plan.waitMs);
    sleeps++;

    const after = await readClock();
    log(`\n-- Market clock (re-read after the wait) -- ${after.detail}`);
    const replan = planEntryWindow(after.raw, opts);
    if (!replan.entryScan) {
      // Market shut / halted / early close moved / clock went unreadable while we
      // slept. Skip entries outright rather than firing into a closed market.
      log(`   Entry scan ABANDONED — ${replan.detail}`);
    } else if (replan.waitMs > 0) {
      // The broker clock moved BACKWARDS. Never sleep twice in one cycle.
      log(`   Clock moved backwards (${replan.detail}) — not waiting again, scanning now`);
    } else {
      log(`   ${replan.detail}`);
    }
    plan = { ...replan, waitMs: 0 };
  }

  const entryScan = plan.entryScan === true;
  log(`\n-- Cycle type -- ${entryScan ? 'FULL (position management + ENTRY SCAN)' : 'CHEAP (SID_EXITS_ONLY — position management only)'} [${plan.phase}]`);

  return { marketOpen: full, entryScan, phase: plan.phase, plan,
           clockDetail: clock.detail, waitedMs, sleeps };
}

// ── One cycle ────────────────────────────────────────────────────────────────

async function runCycle() {
  const started = Date.now();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  SID Railway cron cycle — ${stamp}`);
  console.log(`${'='.repeat(62)}`);

  // 2. Decide the cycle type from the BROKER's clock, and do any close-window
  //    wait, BEFORE anything else — a waiting cycle must not pull state it will
  //    run against 17 minutes later.
  const win = await resolveEntryWindow();
  const marketOpen = win.marketOpen;
  const entryScan  = win.entryScan;
  const plan       = win.plan;

  // 3. Pull state + config from the state branch — AFTER any wait, so the bot
  //    runs against the freshest cloud state (a concurrent GitHub Actions run
  //    could have moved it while we slept).
  console.log(`\n-- Pulling state from ${OWNER}/${REPO}@${BRANCH} --`);
  for (const f of CONFIG_FILES) await pullFile(f, { remember: false });
  for (const { p } of STATE_FILES) await pullFile(p);

  // 4. Run the bot ONCE. A bot crash must not stop us pushing whatever state it
  //    already wrote (a booked exit must reach the cloud).
  console.log('\n-- Running bot-sid.js --');
  let botFailed = null;
  try {
    execFileSync(process.execPath, ['bot-sid.js'], {
      cwd:   __dirname,
      stdio: 'inherit',
      env:   { ...process.env, ...(entryScan ? {} : { SID_EXITS_ONLY: 'true' }) },
      timeout: 10 * 60 * 1000,
    });
  } catch (err) {
    botFailed = `exit ${err.status ?? 'n/a'}${err.signal ? ` signal ${err.signal}` : ''}: ${err.message}`;
    console.error(`\n[SID-RAILWAY] bot-sid.js did not exit cleanly — ${botFailed}`);
    console.error('[SID-RAILWAY] Continuing to the state push so nothing the bot DID write is lost.');
  }

  // 5. Push changed state back.
  console.log(`\n-- Pushing changed state to ${BRANCH} --`);
  const push = await pushState(stamp);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  // v2.6.1: a dry-push cycle used to report `pushed=N` for files it never sent.
  // It now reports them as skipped, with the dry count called out explicitly.
  const pushSummary = DRY_PUSH
    ? `pushed=0 skipped=${push.skipped} (dry push: ${push.dry} would have been written) failed=${push.failed}`
    : `pushed=${push.pushed} failed=${push.failed}`;
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  Cycle complete in ${secs}s — market=${marketOpen ? 'OPEN' : 'CLOSED'} cycle=${entryScan ? 'FULL' : 'CHEAP'} (${plan.phase}) bot=${botFailed ? 'FAILED' : 'ok'} ${pushSummary}`);
  console.log(`${'='.repeat(62)}\n`);
  return { botFailed, push, entryScan, phase: plan.phase };
}

/** ET minutes-of-day -> 'HH:MM' for logging. */
function fmtEt(min) {
  if (!Number.isFinite(min)) return '--:--';
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

export { runCycle, resolveEntryWindow, assertEnv, pushState, mergeById, mergeCsvAppend, resolveConflict, readMarketClock, STATE_FILES, CONFIG_FILES };
// v2.6.1 — `etFields` and `planEntryWindow` are exported above at their
// definitions (they are pure, and the regression suite drives them directly with
// mocked clocks in BOTH DST offsets), as are CLOSE_WINDOW_MIN /
// ENTRY_SUBMIT_OFFSET_MIN / MAX_ENTRY_WAIT_MIN.
