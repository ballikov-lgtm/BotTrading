import { execSync }  from 'child_process';
import fetch          from 'node-fetch';
import fs             from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const OWNER        = 'ballikov-lgtm';
const REPO         = 'BotTrading';
const INTERVAL_MS  = 15 * 60 * 1000;   // 15 minutes

// State files — pulled from 'logs' branch (where the bot last saved them).
// This preserves cooldowns, open positions, trade history across runs.
const PULL_STATE_FILES = [
  'open-positions-ironclad.json',
  'closed-positions-ironclad.json',
  'trades-ironclad.csv',
  'cooldown-ironclad.json',
  'ironclad-log.json',
  'hype-state.json',
];

// Config files — pulled from 'main' branch (source of truth for strategy config).
const PULL_MAIN_FILES = [
  'research-signals.json',   // written by research.js on GitHub Actions → main
  'rules-ironclad.json',     // strategy config — only changes with code deploys
];

// Files to push TO GitHub after each run for visibility / dashboard.
// Pushed to the 'logs' branch — Railway only watches 'main', so this
// will NOT trigger a redeploy loop.
const PUSH_FILES = [
  'ironclad-log.json',
  'trades-ironclad.csv',
  'open-positions-ironclad.json',
  'closed-positions-ironclad.json',
  'hype-state.json',
  'cooldown-ironclad.json',
];
const LOGS_BRANCH = 'logs';

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function githubRequest(method, path, body = null) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function pullFile(filename, branch = 'main') {
  try {
    const data = await githubRequest('GET', `/repos/${OWNER}/${REPO}/contents/${filename}?ref=${branch}`);
    if (!data.content) return;

    const remoteContent = Buffer.from(data.content, 'base64').toString('utf8');

    // For closed-positions JSON files: MERGE remote + local so we never lose
    // close data that was written locally but not yet pushed (e.g. after a push conflict).
    // Remote entries come first; local-only entries (pending push) are preserved.
    if (filename.startsWith('closed-positions') && filename.endsWith('.json') && fs.existsSync(filename)) {
      try {
        const localPositions  = JSON.parse(fs.readFileSync(filename, 'utf8'));
        const remotePositions = JSON.parse(remoteContent);
        const merged          = new Map();
        for (const p of remotePositions) merged.set(p.id, p);
        for (const p of localPositions)  merged.set(p.id, p);  // local overrides if id matches
        const mergedArr = [...merged.values()];
        if (mergedArr.length > remotePositions.length) {
          fs.writeFileSync(filename, JSON.stringify(mergedArr, null, 2));
          console.log(`  ↓ ${filename} (${branch}) — merged ${remotePositions.length} remote + ${mergedArr.length - remotePositions.length} local-only = ${mergedArr.length} total`);
          return;
        }
      } catch { /* merge failed — fall through to plain overwrite */ }
    }

    fs.writeFileSync(filename, remoteContent);
    console.log(`  ↓ ${filename} (${branch})`);
  } catch (e) {
    // File may not exist yet on first run — that's fine
    console.log(`  ↓ ${filename} — not found on ${branch}, skipping`);
  }
}

async function pushFile(filename, branch = LOGS_BRANCH) {
  if (!fs.existsSync(filename)) return;
  try {
    const content = fs.readFileSync(filename, 'utf8');
    const encoded = Buffer.from(content).toString('base64');

    // Get current SHA from the target branch (required by GitHub API to update)
    const existing = await githubRequest('GET',
      `/repos/${OWNER}/${REPO}/contents/${filename}?ref=${branch}`);
    const sha = existing.sha || null;

    const body = {
      message: `Railway log ${new Date().toISOString().slice(0, 16)} UTC`,
      content: encoded,
      branch,
    };
    if (sha) body.sha = sha;

    const result = await githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${filename}`, body);
    if (result.content) {
      console.log(`  ↑ ${filename} → ${branch}`);
    } else {
      console.log(`  ⚠ Push issue for ${filename}: ${JSON.stringify(result).slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`  ⚠ Could not push ${filename}: ${e.message}`);
  }
}

// ── Bot runner ────────────────────────────────────────────────────────────────

async function runCycle() {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  console.log(`\n${'═'.repeat(54)}`);
  console.log(`  Railway run — ${ts}`);
  console.log(`${'═'.repeat(54)}`);

  // 1. Pull latest state from GitHub
  console.log('\n── Pulling state from GitHub ──');
  for (const f of PULL_STATE_FILES) await pullFile(f, LOGS_BRANCH);  // live state from logs branch
  for (const f of PULL_MAIN_FILES)  await pullFile(f, 'main');        // config from main

  // 2. Run Ironclad bot
  console.log('\n── Running Ironclad ──');
  try {
    execSync('node bot-ironclad.js', { stdio: 'inherit' });
  } catch (e) {
    console.log(`Ironclad error (exit ${e.status}): ${e.message}`);
  }

  // 3. Run HYPE position manager (piggybacks the same cycle)
  console.log('\n── Running HYPE manager ──');
  try {
    execSync('node bot-hype-manager.js', { stdio: 'inherit' });
  } catch (e) {
    console.log(`HYPE manager error: ${e.message}`);
  }

  // 4. Push state to 'logs' branch for visibility (safe — Railway watches 'main' only)
  console.log('\n── Pushing state to logs branch ──');
  for (const f of PUSH_FILES) await pushFile(f);

  console.log(`\n✓ Cycle complete. Next run in ${INTERVAL_MS / 60000} minutes.\n`);
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (!GITHUB_TOKEN) {
  console.error('ERROR: GITHUB_TOKEN env var is not set. State sync will fail.');
}

console.log('Ironclad Railway runner started.');
console.log(`Interval: every ${INTERVAL_MS / 60000} minutes`);

// Run immediately on startup, then on interval
runCycle();
setInterval(runCycle, INTERVAL_MS);
