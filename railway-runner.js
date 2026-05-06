import { execSync }  from 'child_process';
import fetch          from 'node-fetch';
import fs             from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const OWNER        = 'ballikov-lgtm';
const REPO         = 'BotTrading';
const INTERVAL_MS  = 15 * 60 * 1000;   // 15 minutes

// Files to pull FROM GitHub before each bot run (so the bot has fresh state)
const PULL_FILES = [
  'open-positions-ironclad.json',
  'closed-positions-ironclad.json',
  'trades-ironclad.csv',
  'cooldown-ironclad.json',
  'ironclad-log.json',
  'hype-state.json',
  'research-signals.json',   // written by research.js on GitHub Actions
  'rules-ironclad.json',
];

// Files to push TO GitHub after each bot run (keeps dashboard + state in sync)
const PUSH_FILES = [
  'open-positions-ironclad.json',
  'closed-positions-ironclad.json',
  'trades-ironclad.csv',
  'cooldown-ironclad.json',
  'ironclad-log.json',
  'hype-state.json',
];

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

async function pullFile(filename) {
  try {
    const data = await githubRequest('GET', `/repos/${OWNER}/${REPO}/contents/${filename}`);
    if (data.content) {
      fs.writeFileSync(filename, Buffer.from(data.content, 'base64').toString('utf8'));
      console.log(`  ↓ ${filename}`);
    }
  } catch (e) {
    // File may not exist yet on first run — that's fine
    console.log(`  ↓ ${filename} — not found, skipping`);
  }
}

async function pushFile(filename) {
  if (!fs.existsSync(filename)) return;
  try {
    const content = fs.readFileSync(filename, 'utf8');
    const encoded = Buffer.from(content).toString('base64');

    // Get current SHA (required by GitHub API to update an existing file)
    const existing = await githubRequest('GET', `/repos/${OWNER}/${REPO}/contents/${filename}`);
    const sha      = existing.sha || null;

    const body = {
      message: `Ironclad state ${new Date().toISOString().slice(0, 16)} UTC [skip ci]`,
      content: encoded,
    };
    if (sha) body.sha = sha;

    const result = await githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${filename}`, body);
    if (result.content) {
      console.log(`  ↑ ${filename}`);
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
  for (const f of PULL_FILES) await pullFile(f);

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

  // 4. Push updated state back to GitHub (keeps dashboard live)
  console.log('\n── Pushing state to GitHub ──');
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
