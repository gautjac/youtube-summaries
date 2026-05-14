#!/usr/bin/env node
/**
 * transcript.cjs — fetch the transcript for a YouTube video.
 *
 * Three-tier fall-through, fast to slow / free to paid:
 *   1. timedtext  — YouTube's own caption endpoint, scraped from the watch
 *                   page's `captionTracks` array. Free, instant, ~95% hit
 *                   rate for English-speaking channels.
 *   2. yt-dlp     — `yt-dlp --write-auto-sub --skip-download` writes a VTT
 *                   we then strip. Robust fallback when timedtext fails
 *                   (some videos hide their tracks behind player config).
 *                   Requires `yt-dlp` on PATH.
 *   3. whisper    — `yt-dlp -x` to mp3, then either the OpenAI Whisper API
 *                   (env OPENAI_API_KEY) or local whisper.cpp (env
 *                   WHISPER_CPP_BIN + WHISPER_CPP_MODEL). Last resort, slow.
 *
 * Returns { source, text, lang } or throws if every tier fails.
 *
 * Costs: tier 1+2 are free. Tier 3 is ~$0.006/min for OpenAI Whisper, free
 * locally. Whisper is capped at WHISPER_MAX_DURATION_SEC (default 5400 / 90m)
 * to prevent runaway costs on long videos.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const WHISPER_MAX_DURATION_SEC = Number(process.env.WHISPER_MAX_DURATION_SEC || 5400);

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects: ' + url));
    const req = https.get(url, {
      headers: { 'User-Agent': 'youtube-summaries/1.0', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 30000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return fetchUrl(res.headers.location, redirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function whichSync(bin) {
  try {
    return execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ─── TIER 1: timedtext ──────────────────────────────────────────────────────

async function tier1Timedtext(videoId) {
  const watchHtml = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}&hl=en`);

  // Locate the captionTracks array inside the embedded ytInitialPlayerResponse.
  const match = watchHtml.match(/"captionTracks":(\[.*?\])/);
  if (!match) throw new Error('no captionTracks in watch page');

  // Parse just enough of the JSON to get baseUrl + languageCode + kind.
  let tracks;
  try {
    tracks = JSON.parse(match[1]);
  } catch (err) {
    throw new Error('failed to parse captionTracks JSON');
  }
  if (!Array.isArray(tracks) || !tracks.length) {
    throw new Error('captionTracks empty');
  }

  // Prefer manually authored English; fall back to auto-generated English;
  // last-ditch, the first track of any language.
  const englishManual = tracks.find(t =>
    (t.languageCode || '').startsWith('en') && t.kind !== 'asr');
  const englishAuto = tracks.find(t =>
    (t.languageCode || '').startsWith('en'));
  const track = englishManual || englishAuto || tracks[0];
  if (!track || !track.baseUrl) throw new Error('no usable caption track');

  // Request the plaintext (`fmt=` omitted) flavor of the transcript. The
  // default response is the timedtext XML; that's easy to strip.
  // Note: YouTube has been progressively locking down direct timedtext
  // access (it often returns HTTP 200 with a 0-byte body for unauthenticated
  // clients). When that happens we fall through to yt-dlp, which uses an
  // InnerTube session that timedtext respects.
  const xml = await fetchUrl(track.baseUrl);
  if (!xml || xml.length < 30) throw new Error('timedtext returned empty body');
  const lines = [];
  const textRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = textRe.exec(xml)) !== null) {
    const t = decodeEntities(m[1])
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (t) lines.push(t);
  }
  const text = lines.join(' ').trim();
  if (!text) throw new Error('captions track empty');

  return { source: 'timedtext', text, lang: track.languageCode || 'en' };
}

// ─── TIER 2: yt-dlp auto-sub ────────────────────────────────────────────────

function vttToText(vtt) {
  const out = [];
  let lastLine = '';
  for (const rawLine of vtt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'WEBVTT') continue;
    if (/^\d+$/.test(line)) continue;
    if (/-->/.test(line)) continue;
    if (/^NOTE\b/.test(line)) continue;
    if (/^Kind:|^Language:|^STYLE/.test(line)) continue;
    const cleaned = line.replace(/<[^>]+>/g, '').trim();
    if (!cleaned) continue;
    // yt-dlp auto captions have heavy line duplication — collapse repeats.
    if (cleaned === lastLine) continue;
    out.push(cleaned);
    lastLine = cleaned;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Player clients to try, in order. YouTube's bot-detection blocks different
// clients in different ways from different IP ranges, so we iterate until
// one yields a non-empty .vtt:
//   - tv_embedded:  YouTube TV app; tends to bypass GHA bot-walls and
//                   serves full captions where android gets "Sign in".
//   - web_safari:   Mac Safari client; another reliable fallback.
//   - mweb:         mobile web; sometimes captions-only.
//   - android:      keeps working from residential IPs.
//   - ios:          last-ditch.
// Override via env YT_PLAYER_CLIENTS="tv_embedded,web_safari".
const PLAYER_CLIENTS = (process.env.YT_PLAYER_CLIENTS || 'tv_embedded,web_safari,mweb,android,ios')
  .split(',').map(s => s.trim()).filter(Boolean);

function runYtDlpSubtitles(ytdlp, videoId, client, dir) {
  const hasCookies = process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE);
  const args = [
    '--write-auto-sub', '--write-sub',
    '--sub-langs', 'en.*',
    // Prefer vtt but accept whatever's offered. Forcing vtt-only errors
    // with "Requested format is not available" when the authenticated
    // response only exposes srv3/ttml.
    '--sub-format', 'vtt/best',
    '--skip-download',
    '--no-warnings',
  ];
  // Cookies + a forced player_client tend to fight each other: the cookies
  // imply a session, the override picks a client that doesn't honor it,
  // and yt-dlp falls into "Requested format is not available". When we
  // have cookies, let yt-dlp pick the client itself (defaults to `web`,
  // which the cookies authenticate). Only force a client unauthenticated.
  if (!hasCookies) {
    args.push('--extractor-args', `youtube:player_client=${client}`);
  }
  if (hasCookies) {
    args.push('--cookies', process.env.YT_COOKIES_FILE);
  }
  args.push(
    '-o', path.join(dir, '%(id)s.%(ext)s'),
    `https://www.youtube.com/watch?v=${videoId}`,
  );
  const result = spawnSync(ytdlp, args, { encoding: 'utf8' });
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.vtt'));
  // Drop zero-byte files immediately — some clients write a stub vtt.
  const sized = files
    .map(f => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .filter(x => x.size > 200);
  return { sized, stderr: (result.stderr || '').slice(0, 300), exit: result.status };
}

async function tier2YtDlp(videoId) {
  const ytdlp = whichSync('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not on PATH');
  const hasCookies = process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE);

  // With cookies, yt-dlp's default web client gets the captions in one shot
  // (and the per-client cycling actually breaks it). Without cookies we
  // need the fallback chain to dodge per-client bot-walling.
  const clients = hasCookies ? ['default'] : PLAYER_CLIENTS;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-summ-'));
  const tries = [];
  try {
    for (const client of clients) {
      // Clean the dir between clients so we don't pick up leftover stubs.
      for (const f of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
      const { sized, stderr, exit } = runYtDlpSubtitles(ytdlp, videoId, client, dir);
      if (sized.length) {
        sized.sort((a, b) => a.f.length - b.f.length);
        const file = sized[0].f;
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const text = file.endsWith('.vtt')
          ? vttToText(raw)
          : subtitleToText(raw);
        if (text) return { source: `yt-dlp(${client})`, text, lang: 'en' };
        tries.push(`${client}: subtitle parsed empty`);
      } else {
        tries.push(`${client}: ${stderr.replace(/\n/g, ' ').slice(0, 120) || `exit ${exit}`}`);
      }
    }
    throw new Error(`all clients failed: ${tries.join(' | ')}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Generic subtitle-to-text for srv3 / ttml / json3 / other formats yt-dlp
// might write when vtt isn't available. Strips tags, collapses whitespace.
function subtitleToText(raw) {
  // JSON3 (YouTube native): { events: [{ segs: [{ utf8: "..." }] }] }
  if (raw.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const out = [];
      for (const ev of (j.events || [])) {
        for (const seg of (ev.segs || [])) {
          if (seg.utf8) out.push(seg.utf8);
        }
      }
      return out.join(' ').replace(/\s+/g, ' ').trim();
    } catch {}
  }
  // Anything XML-ish (srv3, ttml): strip tags
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── TIER 3: Whisper fallback ───────────────────────────────────────────────

async function downloadAudio(videoId, outPath) {
  const ytdlp = whichSync('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not on PATH (required for audio download)');
  const args = [
    '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=android',
  ];
  if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) {
    args.push('--cookies', process.env.YT_COOKIES_FILE);
  }
  args.push(
    '-o', outPath.replace(/\.mp3$/, '.%(ext)s'),
    `https://www.youtube.com/watch?v=${videoId}`,
  );
  const result = spawnSync(ytdlp, args, { encoding: 'utf8' });
  if (!fs.existsSync(outPath)) {
    throw new Error(`yt-dlp -x produced no mp3 (exit ${result.status}: ${(result.stderr || '').slice(0, 200)})`);
  }
}

async function whisperOpenAI(mp3Path) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const boundary = '----yt' + Math.random().toString(36).slice(2);
  const fileBuf = fs.readFileSync(mp3Path);

  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${path.basename(mp3Path)}"\r\n` +
    `Content-Type: audio/mpeg\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBuf, tail]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 600000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`Whisper HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
        try {
          const json = JSON.parse(text);
          resolve(json.text || '');
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Whisper request timed out')); });
    req.write(body);
    req.end();
  });
}

async function whisperLocal(mp3Path) {
  const bin = process.env.WHISPER_CPP_BIN || whichSync('whisper-cli') || whichSync('whisper');
  const model = process.env.WHISPER_CPP_MODEL;
  if (!bin || !model) throw new Error('local whisper not configured (WHISPER_CPP_BIN, WHISPER_CPP_MODEL)');

  const out = mp3Path + '.txt';
  const args = ['-m', model, '-f', mp3Path, '-otxt', '-of', mp3Path];
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`local whisper failed: ${(result.stderr || '').slice(0, 200)}`);
  }
  if (!fs.existsSync(out)) throw new Error('local whisper produced no .txt');
  return fs.readFileSync(out, 'utf8').replace(/\s+/g, ' ').trim();
}

async function tier3Whisper(videoId, durationSec) {
  if (durationSec && durationSec > WHISPER_MAX_DURATION_SEC) {
    throw new Error(`video duration ${durationSec}s exceeds WHISPER_MAX_DURATION_SEC=${WHISPER_MAX_DURATION_SEC}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-whisper-'));
  const mp3 = path.join(dir, `${videoId}.mp3`);
  try {
    await downloadAudio(videoId, mp3);

    let text = '';
    try {
      text = await whisperLocal(mp3);
    } catch (localErr) {
      // local whisper is opt-in; if it's not configured, fall through
      // to OpenAI quietly.
      try {
        text = await whisperOpenAI(mp3);
      } catch (cloudErr) {
        throw new Error(`whisper failed (local: ${localErr.message}; cloud: ${cloudErr.message})`);
      }
    }
    if (!text) throw new Error('whisper produced empty transcript');
    return { source: 'whisper', text, lang: 'en' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ─── PUBLIC ─────────────────────────────────────────────────────────────────

async function fetchTranscript(videoId, { durationSec, skipWhisper = false } = {}) {
  const errors = [];

  try {
    return await tier1Timedtext(videoId);
  } catch (err) {
    errors.push(`timedtext: ${err.message}`);
  }

  try {
    return await tier2YtDlp(videoId);
  } catch (err) {
    errors.push(`yt-dlp: ${err.message}`);
  }

  if (skipWhisper) {
    throw new Error(`no captions; whisper disabled. Errors: ${errors.join(' | ')}`);
  }

  try {
    return await tier3Whisper(videoId, durationSec);
  } catch (err) {
    errors.push(`whisper: ${err.message}`);
  }

  throw new Error(`no transcript produced. Errors: ${errors.join(' | ')}`);
}

module.exports = { fetchTranscript, tier1Timedtext, tier2YtDlp, tier3Whisper };

// CLI for quick testing:
//   node scripts/transcript.cjs <videoId>
if (require.main === module) {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error('Usage: node scripts/transcript.cjs <videoId>');
    process.exit(1);
  }
  fetchTranscript(videoId)
    .then(r => {
      console.log(`[${r.source} · ${r.lang}] ${r.text.length} chars`);
      console.log(r.text.slice(0, 500) + (r.text.length > 500 ? '…' : ''));
    })
    .catch(err => { console.error('Failed:', err.message); process.exit(1); });
}
