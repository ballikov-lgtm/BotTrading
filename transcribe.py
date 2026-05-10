"""
transcribe.py — Local speech-to-text using OpenAI Whisper
Called by voice-claude.js with the path to a WAV file.
Prints the transcript to stdout.

First run: downloads the Whisper 'base' model (~145MB, one-time only).
"""
import sys
import whisper

if len(sys.argv) < 2:
    print("Usage: python transcribe.py <wav_file>", file=sys.stderr)
    sys.exit(1)

wav_file = sys.argv[1]

import os
if not os.path.exists(wav_file):
    print(f"ERROR: WAV file not found: {wav_file}", file=sys.stderr)
    sys.exit(1)

file_size = os.path.getsize(wav_file)
if file_size < 100:
    print(f"ERROR: WAV file is empty or too small ({file_size} bytes) — recording may have failed", file=sys.stderr)
    sys.exit(1)

model  = whisper.load_model("base")
result = model.transcribe(wav_file, fp16=False)
print(result["text"].strip())
