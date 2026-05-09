/**
 * voice-claude.js — Fully voice-to-voice conversation with Claude
 *
 * TEXT MODE:  Type your message → press Enter → George responds aloud
 * VOICE MODE: Press Enter on a blank line → speak → press Enter to stop → George responds
 *
 * Commands: clear | exit | Ctrl+C
 *
 * Requires in .env:
 *   ANTHROPIC_API_KEY    — from console.anthropic.com
 *   ELEVENLABS_API_KEY   — from elevenlabs.io
 *   ELEVENLABS_VOICE_ID  — voice ID (defaults to George)
 */

import { config } from 'dotenv';
config({ override: true });
import readline from 'readline';
import fetch from 'node-fetch';
import fs from 'fs';
import { spawnSync, spawn } from 'child_process';
import path from 'path';
import os from 'os';

// ── Config ─────────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY   || '';
const ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George
const USE_ELEVENLABS   = !!ELEVENLABS_KEY;

const WAV_FILE  = path.join(os.tmpdir(), 'voice-claude-recording.wav');
const STOP_FILE = path.join(os.tmpdir(), 'voice-claude-stop.txt');
const PS1_FILE  = path.join(os.tmpdir(), 'voice-claude-record.ps1');

if (!ANTHROPIC_KEY) {
  console.error('\n\x1b[31m❌  ANTHROPIC_API_KEY not set in .env\x1b[0m');
  process.exit(1);
}

// ── Colours ────────────────────────────────────────────────────────────────────
const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const BLUE   = s => `\x1b[34m${s}\x1b[0m`;
const MUTED  = s => `\x1b[90m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;

// ── Conversation history ───────────────────────────────────────────────────────
const history = [];

// ── Clean text for speech ─────────────────────────────────────────────────────
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

// ── Windows SAPI TTS fallback ─────────────────────────────────────────────────
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
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────
function buildWavBuffer(pcmData, sampleRate = 22050, channels = 1, bitsPerSample = 16) {
  const dataSize = pcmData.length;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);           buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);           buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);      buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);buf.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34); buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);pcmData.copy(buf, 44);
  return buf;
}

async function speakElevenLabs(text) {
  const clean = cleanForSpeech(text);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}?output_format=pcm_22050`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          model_id: 'eleven_turbo_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.3 },
        }),
      }
    );
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 150)}`);

    const wav = buildWavBuffer(Buffer.from(await res.arrayBuffer()), 22050);
    const tmp = path.join(os.tmpdir(), 'voice-claude-el.wav');
    fs.writeFileSync(tmp, wav);

    const script = `Add-Type -AssemblyName System.Windows.Forms; $p = New-Object System.Media.SoundPlayer('${tmp.replace(/\\/g, '\\\\')}'); $p.PlaySync();`;
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  } catch (e) {
    console.log(MUTED(`  [TTS error — using Windows voice: ${e.message}]`));
    speakSAPI(text);
  }
}

function speak(text) {
  return USE_ELEVENLABS ? speakElevenLabs(text) : speakSAPI(text);
}

// ── Microphone recording via PowerShell MCI ───────────────────────────────────
function startRecording() {
  // Clean up any previous stop signal
  try { fs.unlinkSync(STOP_FILE); } catch {}

  // Write the PowerShell recording script to a temp file
  const wavEscaped  = WAV_FILE.replace(/\\/g, '\\\\');
  const stopEscaped = STOP_FILE.replace(/\\/g, '\\\\');

  const ps1 = `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class MCI {
    [DllImport("winmm.dll")]
    public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int retLen, System.IntPtr hwnd);
}
"@
[MCI]::mciSendString("open new Type waveaudio Alias rec", `$null, 0, [IntPtr]::Zero)
[MCI]::mciSendString("record rec", `$null, 0, [IntPtr]::Zero)
while (-not (Test-Path "${stopEscaped}")) { Start-Sleep -Milliseconds 100 }
[MCI]::mciSendString("stop rec", `$null, 0, [IntPtr]::Zero)
[MCI]::mciSendString("save rec ${wavEscaped}", `$null, 0, [IntPtr]::Zero)
[MCI]::mciSendString("close rec", `$null, 0, [IntPtr]::Zero)
`.trim();

  fs.writeFileSync(PS1_FILE, ps1, 'utf-8');

  return spawn('powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_FILE
  ], { stdio: 'ignore' });
}

function stopRecording(proc) {
  return new Promise(resolve => {
    proc.on('exit', resolve);
    fs.writeFileSync(STOP_FILE, 'stop');
  });
}

// ── Whisper Speech-to-Text (local, free, via Python) ─────────────────────────
const TRANSCRIBE_PY = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'transcribe.py');

function transcribe(wavFile) {
  // First run downloads the Whisper model (~145MB) — takes a minute, one-time only
  const result = spawnSync('python', [TRANSCRIBE_PY, wavFile], {
    encoding: 'utf-8',
    timeout: 60000,  // 60s — first run needs time to download the model
  });
  if (result.status !== 0) {
    throw new Error(`Whisper error: ${(result.stderr || '').slice(0, 200)}`);
  }
  return (result.stdout || '').trim();
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
        'Never use markdown, bullet points, headers, or code blocks unless the user asks for code.',
        'Speak naturally. Give lists as sentences: "You could try X, Y, or Z."',
      ].join(' '),
      messages: history,
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data  = await res.json();
  const reply = data.content?.[0]?.text?.trim() || '(no response)';
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Main ───────────────────────────────────────────────────────────────────────
console.log(BOLD('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(BOLD('  Voice Claude'));
console.log(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(MUTED(`  Voice:      ${USE_ELEVENLABS ? 'ElevenLabs — George' : 'Windows built-in TTS'}`));
console.log(MUTED('  Text mode:  type your message → Enter'));
console.log(MUTED('  Voice mode: blank Enter → speak → Enter to stop'));
console.log(MUTED('  Commands:   clear · exit\n'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// State: 'idle' | 'recording' | 'processing'
let state      = 'idle';
let recordProc = null;

const prompt = () => {
  if (state === 'idle') process.stdout.write(BLUE('You: '));
};

rl.on('line', async raw => {
  const line = raw.trim();

  // ── Stop recording ────────────────────────────────────────────────────────
  if (state === 'recording') {
    state = 'processing';
    process.stdout.write(MUTED('  Transcribing...\r'));
    await stopRecording(recordProc);

    try {
      const spoken = transcribe(WAV_FILE);
      if (!spoken) {
        process.stdout.write('                  \r');
        console.log(MUTED('  (nothing heard — try again)\n'));
        state = 'idle';
        prompt();
        return;
      }

      process.stdout.write('                  \r');
      console.log(YELLOW('You said: ') + spoken + '\n');

      process.stdout.write(MUTED('  Thinking...\r'));
      const reply = await askClaude(spoken);
      process.stdout.write('              \r');
      console.log(GREEN('Claude: ') + reply + '\n');
      await speak(reply);
    } catch (e) {
      process.stdout.write('                  \r');
      console.log(RED(`  Error: ${e.message}\n`));
    }

    state = 'idle';
    prompt();
    return;
  }

  // ── Ignore input while processing ─────────────────────────────────────────
  if (state === 'processing') return;

  // ── Start voice recording (blank Enter) ───────────────────────────────────
  if (!line) {
    if (!USE_ELEVENLABS) {
      console.log(MUTED('  (voice input needs ElevenLabs key — type your message instead)\n'));
      prompt();
      return;
    }
    state = 'recording';
    recordProc = startRecording();
    process.stdout.write(YELLOW('  🎤 Recording... press Enter when done\n'));
    return;
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  if (line.toLowerCase() === 'exit' || line.toLowerCase() === 'quit') {
    console.log(MUTED('\nGoodbye.\n'));
    rl.close(); process.exit(0);
  }

  if (line.toLowerCase() === 'clear') {
    history.length = 0;
    console.log(MUTED('  Conversation cleared — fresh start.\n'));
    prompt(); return;
  }

  // ── Text input ────────────────────────────────────────────────────────────
  state = 'processing';
  process.stdout.write(MUTED('  Thinking...\r'));

  try {
    const reply = await askClaude(line);
    process.stdout.write('              \r');
    console.log(GREEN('Claude: ') + reply + '\n');
    await speak(reply);
  } catch (e) {
    process.stdout.write('              \r');
    console.log(RED(`  Error: ${e.message}\n`));
  }

  state = 'idle';
  prompt();
});

rl.on('close', () => { console.log(MUTED('\nGoodbye.\n')); process.exit(0); });
process.on('SIGINT', () => { console.log(MUTED('\nGoodbye.\n')); process.exit(0); });

prompt();
