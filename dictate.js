/**
 * dictate.js — Whisper-powered dictation to clipboard
 *
 * Press Enter to start recording, Enter again to stop.
 * Whisper transcribes locally, the result is printed and copied to your clipboard.
 * Paste it (Ctrl+V) into Claude Code or anywhere else.
 *
 * Commands: exit | quit | Ctrl+C
 */

import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const WAV_FILE  = path.join(os.tmpdir(), 'dictate-recording.wav');
const STOP_FILE = path.join(os.tmpdir(), 'dictate-stop.txt');
const PS1_FILE  = path.join(os.tmpdir(), 'dictate-record.ps1');
const TRANSCRIBE_PY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcribe.py');

const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const MUTED  = s => `\x1b[90m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const BOLD   = s => `\x1b[1m${s}\x1b[0m`;

function startRecording() {
  try { fs.unlinkSync(STOP_FILE); } catch {}
  try { fs.unlinkSync(WAV_FILE);  } catch {}

  const wavEscaped  = WAV_FILE.replace(/\\/g, '/');
  const stopEscaped = STOP_FILE.replace(/\\/g, '/');

  const ps1 = `
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public class MCI {
    [DllImport("winmm.dll")]
    public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int retLen, System.IntPtr hwnd);
}
"@
[MCI]::mciSendString("open new Type waveaudio Alias rec", $null, 0, [IntPtr]::Zero)
[MCI]::mciSendString("record rec", $null, 0, [IntPtr]::Zero)
while (-not (Test-Path "${stopEscaped}")) { Start-Sleep -Milliseconds 100 }
[MCI]::mciSendString("stop rec", $null, 0, [IntPtr]::Zero)
[MCI]::mciSendString("save rec ${wavEscaped}", $null, 0, [IntPtr]::Zero)
[MCI]::mciSendString("close rec", $null, 0, [IntPtr]::Zero)
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

function transcribe(wavFile) {
  const result = spawnSync('python', [TRANSCRIBE_PY, wavFile], {
    encoding: 'utf-8',
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || 'unknown whisper error');
  }
  return (result.stdout || '').trim();
}

function copyToClipboard(text) {
  const r = spawnSync('clip', [], { input: text, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`clip.exe failed: ${r.stderr}`);
}

console.log(BOLD('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(BOLD('  Whisper Dictation → Clipboard'));
console.log(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(MUTED('  Press Enter to record · Enter again to stop'));
console.log(MUTED('  Transcript is copied to clipboard — paste with Ctrl+V'));
console.log(MUTED('  Commands: exit · quit · Ctrl+C\n'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let state = 'idle';
let recordProc = null;

const prompt = () => {
  if (state === 'idle') process.stdout.write(GREEN('▶ Ready — press Enter to record: '));
};

rl.on('line', async raw => {
  const line = raw.trim().toLowerCase();

  if (state === 'recording') {
    state = 'processing';
    process.stdout.write(MUTED('  Transcribing...\r'));
    await stopRecording(recordProc);

    try {
      const text = transcribe(WAV_FILE);
      process.stdout.write('                     \r');
      if (!text) {
        console.log(MUTED('  (nothing heard — try again)\n'));
      } else {
        copyToClipboard(text);
        console.log(YELLOW('Transcript: ') + text);
        console.log(MUTED('  ✓ Copied to clipboard\n'));
      }
    } catch (e) {
      process.stdout.write('                     \r');
      console.log(RED(`  Error: ${e.message}\n`));
    }

    state = 'idle';
    prompt();
    return;
  }

  if (state === 'processing') return;

  if (line === 'exit' || line === 'quit') {
    console.log(MUTED('\nGoodbye.\n'));
    rl.close();
    process.exit(0);
  }

  state = 'recording';
  recordProc = startRecording();
  process.stdout.write(YELLOW('  🎤 Recording... press Enter when done\n'));
});

rl.on('close', () => { console.log(MUTED('\nGoodbye.\n')); process.exit(0); });
process.on('SIGINT', () => { console.log(MUTED('\nGoodbye.\n')); process.exit(0); });

prompt();
