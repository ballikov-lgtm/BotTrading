/**
 * voice-claude.js — Conversational voice interface to Claude
 *
 * SETUP (one-time):
 *   1. Get an Anthropic API key → https://console.anthropic.com
 *      Add to .env:  ANTHROPIC_API_KEY=sk-ant-...
 *
 *   2. Run it:  node voice-claude.js
 *
 * OPTIONAL — ElevenLabs (much more natural voice, free tier: 10k chars/month):
 *   1. Sign up → https://elevenlabs.io  (free)
 *   2. Copy your API key from profile settings
 *   3. Add to .env:  ELEVENLABS_API_KEY=your_key_here
 *   4. Also install mpv (free) so it can play audio:
 *      https://mpv.io/installation/ — just drop mpv.exe somewhere in your PATH
 *   Without mpv it falls back to Windows built-in speech automatically.
 *
 * COMMANDS:
 *   clear   — wipe conversation memory and start fresh
 *   exit    — quit
 *   Ctrl+C  — quit
 */

import 'dotenv/config';
import readline from 'readline';
import fetch from 'node-fetch';
import fs from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import os from 'os';

// ── Config ─────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY   || '';
const ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY  || '';
// Default voice: Charlotte (warm, natural British female).
// Find other voice IDs at https://elevenlabs.io/voice-library
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'XB0fDUnXU5powFXDhCwa';

const USE_ELEVENLABS = !!ELEVENLABS_KEY;

if (!ANTHROPIC_KEY) {
  console.error('\n\x1b[31m❌  ANTHROPIC_API_KEY not set in .env\x1b[0m');
  console.error('    Get a key at https://console.anthropic.com');
  console.error('    Then add this line to your .env file:');
  console.error('    ANTHROPIC_API_KEY=sk-ant-...\n');
  process.exit(1);
}

// ── Colours ────────────────────────────────────────────────────────────────────
const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const BLUE  = s => `\x1b[34m${s}\x1b[0m`;
const MUTED = s => `\x1b[90m${s}\x1b[0m`;
const BOLD  = s => `\x1b[1m${s}\x1b[0m`;
const RED   = s => `\x1b[31m${s}\x1b[0m`;

// ── Conversation history (persists across turns) ───────────────────────────────
const history = [];

// ── Clean text for speech (strip markdown) ────────────────────────────────────
function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, 'see the code on screen')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Windows SAPI TTS (built-in, no setup needed) ──────────────────────────────
function speakSAPI(text) {
  const clean = cleanForSpeech(text);
  const tmp = path.join(os.tmpdir(), 'voice-claude-sapi.txt');
  fs.writeFileSync(tmp, clean, 'utf-8');
  const script = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$s.Rate = 1; $s.Volume = 100;',
    `$s.Speak([System.IO.File]::ReadAllText('${tmp.replace(/\\/g, '\\\\')}'));`,
  ].join(' ');
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
  });
}

// ── ElevenLabs TTS (higher quality, needs API key + mpv) ──────────────────────
let _cachedPlayer = undefined;
function findAudioPlayer() {
  if (_cachedPlayer !== undefined) return _cachedPlayer;
  for (const p of ['mpv', 'ffplay', 'vlc']) {
    const r = spawnSync(p, ['--version'], { stdio: 'pipe', shell: true });
    if (r.status === 0) { _cachedPlayer = p; return p; }
  }
  _cachedPlayer = null;
  return null;
}

async function speakElevenLabs(text) {
  const clean = cleanForSpeech(text);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: clean,
          model_id: 'eleven_turbo_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3 },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 150)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = path.join(os.tmpdir(), 'voice-claude-el.mp3');
    fs.writeFileSync(tmp, buf);

    const player = findAudioPlayer();
    if (!player) {
      console.log(MUTED('  [No audio player found — using Windows TTS instead]'));
      console.log(MUTED('  Install mpv for ElevenLabs voice: https://mpv.io/installation/'));
      speakSAPI(text);
      return;
    }

    const args =
      player === 'mpv'    ? ['--no-video', '--really-quiet', tmp]
    : player === 'ffplay' ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmp]
    : player === 'vlc'    ? ['--play-and-exit', '--no-video', '-q', tmp]
    : [tmp];

    spawnSync(player, args, { stdio: 'ignore', shell: true });
  } catch (e) {
    console.log(MUTED(`  [ElevenLabs error — falling back to Windows TTS: ${e.message}]`));
    speakSAPI(text);
  }
}

function speak(text) {
  return USE_ELEVENLABS ? speakElevenLabs(text) : speakSAPI(text);
}

// ── Claude API ─────────────────────────────────────────────────────────────────
async function askClaude(userMessage) {
  history.push({ role: 'user', content: userMessage });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: [
        'You are having a natural spoken voice conversation.',
        'Keep every reply concise and conversational — like you are speaking, not writing.',
        'Two to four sentences is ideal for most responses.',
        'Never use markdown formatting, bullet points, headers, or code blocks unless the user specifically asks for code.',
        'Speak naturally. If you need to give a list, say it as a sentence: "You could try X, Y, or Z."',
      ].join(' '),
      messages: history,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const reply = data.content?.[0]?.text?.trim() || '(no response)';
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Main loop ──────────────────────────────────────────────────────────────────
console.log(BOLD('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(BOLD('  Voice Claude'));
console.log(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(MUTED(`  Voice:    ${USE_ELEVENLABS ? 'ElevenLabs (high quality)' : 'Windows built-in TTS'}`));
console.log(MUTED('  Type your message and press Enter.'));
console.log(MUTED('  Commands: clear · exit\n'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let busy = false;

const prompt = () => process.stdout.write(BLUE('You: '));

rl.on('line', async raw => {
  const line = raw.trim();
  if (!line) { prompt(); return; }
  if (busy)  { return; } // ignore input while Claude is responding / speaking

  if (line.toLowerCase() === 'exit' || line.toLowerCase() === 'quit') {
    console.log(MUTED('\nGoodbye.\n'));
    rl.close();
    process.exit(0);
  }

  if (line.toLowerCase() === 'clear') {
    history.length = 0;
    console.log(MUTED('  Conversation cleared — fresh start.\n'));
    prompt();
    return;
  }

  busy = true;
  process.stdout.write(MUTED('  Thinking...\r'));

  try {
    const reply = await askClaude(line);
    process.stdout.write('              \r'); // clear "Thinking..."
    console.log(GREEN('Claude: ') + reply + '\n');
    await speak(reply);
  } catch (e) {
    process.stdout.write('              \r');
    console.log(RED(`  Error: ${e.message}\n`));
  }

  busy = false;
  prompt();
});

rl.on('close', () => {
  console.log(MUTED('\nGoodbye.\n'));
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(MUTED('\nGoodbye.\n'));
  process.exit(0);
});

prompt();
