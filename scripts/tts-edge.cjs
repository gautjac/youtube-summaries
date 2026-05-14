#!/usr/bin/env node
/**
 * tts-edge.cjs — Edge-TTS adapter that exposes the same interface as the
 * old tts-openai-local.cjs so it slots into summarize-queue.cjs without
 * other code changes.
 *
 * Why Edge-TTS:
 *   - Free (uses Microsoft's Edge browser neural voices, no key required)
 *   - CPU-only, runs in seconds, comparable quality to OpenAI tts-1 nova
 *   - No quota / billing surprises
 *
 * Requires the Python `edge-tts` package on PATH:
 *   pipx install edge-tts        # local
 *   pip install edge-tts         # CI (workflow installs this)
 *
 * Defaults (override per-call via options arg, or globally via env):
 *   voice  'en-US-AvaMultilingualNeural'  (warm, conversational; default)
 *          env: EDGE_TTS_VOICE
 *   rate   '-3%'                           (slightly slower than the
 *                                          neural-voice default — easier
 *                                          to follow while walking)
 *          env: EDGE_TTS_RATE
 *   pitch  '+0Hz'
 *          env: EDGE_TTS_PITCH
 *   volume '+0%'
 *          env: EDGE_TTS_VOLUME
 *
 * Pauses: Edge-TTS uses Microsoft's free Edge browser endpoint, which
 * does NOT accept SSML — it would read <speak> and <break/> tags out
 * loud as literal text. For pause control, use plain text with periods
 * (sentence breaks) and paragraph breaks (`\n\n` for longer pauses).
 *
 * Helpers (exported):
 *   joinForTTS(parts)  — join an array of strings with paragraph breaks
 *                        for natural section pauses; ensures each part
 *                        ends with a period.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const DEFAULT_VOICE = process.env.EDGE_TTS_VOICE || 'en-US-AvaMultilingualNeural';
const DEFAULT_RATE = process.env.EDGE_TTS_RATE || '-3%';
const DEFAULT_PITCH = process.env.EDGE_TTS_PITCH || '+0Hz';
const DEFAULT_VOLUME = process.env.EDGE_TTS_VOLUME || '+0%';

// Resolve edge-tts from PATH; fall back to common pipx install locations
function findEdgeTts() {
  if (process.env.EDGE_TTS_BIN) return process.env.EDGE_TTS_BIN;
  try {
    return execSync('command -v edge-tts', { encoding: 'utf8' }).trim();
  } catch {}
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin/edge-tts'),
    '/opt/homebrew/bin/edge-tts',
    '/usr/local/bin/edge-tts',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('edge-tts not found. Install with: pipx install edge-tts');
}

// Join an array of section strings into a single TTS payload. Each
// non-empty part is trimmed, given a period if it doesn't already end
// in one, and joined with a blank line (`\n\n`) so Edge-TTS treats
// the boundary as a paragraph break and pauses noticeably between
// sections. Plain text only — no SSML.
function joinForTTS(parts) {
  return parts
    .map(p => (p == null ? '' : String(p).trim()))
    .filter(Boolean)
    .map(s => /[.!?…]$/.test(s) ? s : s + '.')
    .join('\n\n');
}

// chunkText kept for interface compatibility with the old OpenAI module.
// Edge-TTS has no documented hard text limit and handles 8K+ char inputs
// in one request, so we no-op and return the whole text as a single chunk.
function chunkText(text) {
  return [text];
}

async function generateAudioFromText(text, outputPath, options = {}) {
  const bin = findEdgeTts();
  const voice = options.voice || DEFAULT_VOICE;
  const rate = options.rate || DEFAULT_RATE;
  const pitch = options.pitch || DEFAULT_PITCH;
  const volume = options.volume || DEFAULT_VOLUME;

  // Write text to a temp file so we don't have to escape long strings
  // through the shell or stdin. Also handles SSML correctly — edge-tts
  // detects the leading <speak tag automatically.
  const tmpPath = path.join(
    os.tmpdir(),
    `edge-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  );
  fs.writeFileSync(tmpPath, text, 'utf8');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    // Use `--flag=value` syntax (not `--flag value`) so argparse never
    // mistakes a value starting with `-` (like '-3%') for another flag.
    // Python 3.12's argparse is stricter than 3.13/3.14 about this and
    // will reject `--rate -3%` outright.
    const args = [
      '-f', tmpPath,
      `--voice=${voice}`,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      `--volume=${volume}`,
      '--write-media', outputPath,
    ];
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(new Error(`Failed to spawn edge-tts: ${err.message}`));
    });
    proc.on('exit', code => {
      try { fs.unlinkSync(tmpPath); } catch {}
      if (code !== 0) {
        return reject(new Error(`edge-tts exited ${code}: ${stderr.trim().slice(0, 400)}`));
      }
      try {
        const stat = fs.statSync(outputPath);
        if (stat.size < 2000) {
          return reject(new Error(`edge-tts produced suspiciously small file (${stat.size} bytes). stderr: ${stderr.slice(0, 200)}`));
        }
        resolve({ chunks: 1, bytes: stat.size, voice, rate });
      } catch (err) {
        reject(err);
      }
    });
  });
}

module.exports = {
  chunkText,
  generateAudioFromText,
  findEdgeTts,
  joinForTTS,
  DEFAULT_VOICE,
  DEFAULT_RATE,
};

// CLI usage for quick testing:
//   node scripts/tts-edge.cjs "some text" /tmp/out.mp3
//   node scripts/tts-edge.cjs "some text" /tmp/out.mp3 en-US-BrianMultilingualNeural
if (require.main === module) {
  const text = process.argv[2];
  const out = process.argv[3];
  const voice = process.argv[4];
  if (!text || !out) {
    console.error('Usage: node scripts/tts-edge.cjs "text" /path/to/output.mp3 [voice]');
    process.exit(1);
  }
  generateAudioFromText(text, out, voice ? { voice } : {})
    .then(info => console.log(JSON.stringify({ ok: true, ...info })))
    .catch(err => { console.error(err.message); process.exit(1); });
}
