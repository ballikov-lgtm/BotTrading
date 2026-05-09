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
model    = whisper.load_model("base")
result   = model.transcribe(wav_file, fp16=False)  # fp16=False needed on Windows CPU
print(result["text"].strip())
