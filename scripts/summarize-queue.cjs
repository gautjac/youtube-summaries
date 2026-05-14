#!/usr/bin/env node
/**
 * summarize-queue.cjs — Step 2 of the YouTube ingestion pipeline.
 *
 * Reads video-queue.json written by check-channels.cjs, fetches a transcript
 * for each video (captions → yt-dlp → Whisper), calls Anthropic to generate
 * a summary + For You note, runs Edge-TTS for the narration, uploads audio
 * and thumbnail to R2, appends to src/data/videos.json, then deploys.
 *
 * Usage: node scripts/summarize-queue.cjs
 *
 * Mirrors podcast-summaries/scripts/summarize-queue.cjs and reuses its
 * profile.md (split into core + feedback) and FOR_YOU_INSTRUCTION verbatim
 * so both apps speak with one voice.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { generateAudioFromText, joinForTTS } = require('./tts-edge.cjs');
const { voiceForChannel } = require('./voice-map.cjs');
const { getClient: getR2Client, uploadFile: uploadToR2 } = require('./r2-upload.cjs');
const { fetchTranscript } = require('./transcript.cjs');

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE = path.join(__dirname, 'video-queue.json');
const VIDEOS_FILE = path.join(ROOT, 'src/data/videos.json');
const AUDIO_DIR = path.join(ROOT, 'public/audio');
const THUMBS_DIR = path.join(ROOT, 'public/images/thumbs');
const PROFILE_FILE = path.join(__dirname, 'profile.md');
const IS_CI = !!process.env.CI;

// ─── LISTENER PROFILE ───────────────────────────────────────────────────────
// Identical split logic to podcast-summaries. The profile.md is a copy so the
// two apps can evolve independently if needed, but they share a starting voice.

function loadListenerProfile() {
  let raw = '';
  try {
    raw = fs.readFileSync(PROFILE_FILE, 'utf8');
  } catch {
    return {
      core: 'Jac — a creative director / musician / builder in Atlantic Canada interested in AI tools, productivity, creativity, technology, and current events.',
      feedback: '',
    };
  }
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '').trim();
  const lines = stripped.split('\n');
  let feedbackLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Feedback\b/i.test(lines[i])) { feedbackLine = i; break; }
  }
  if (feedbackLine === -1) return { core: stripped, feedback: '' };
  const core = lines.slice(0, feedbackLine).join('\n').trim();
  const feedbackBody = lines.slice(feedbackLine + 1).join('\n').trim();
  const isPlaceholder = /^\(nothing yet|^\(empty|^$/i.test(feedbackBody);
  return { core, feedback: isPlaceholder ? '' : feedbackBody };
}

const { core: LISTENER_PROFILE_CORE, feedback: LISTENER_FEEDBACK } = loadListenerProfile();

// ─── FOR-YOU INSTRUCTION — copied from podcast-summaries verbatim ───────────

const FOR_YOU_INSTRUCTION = `Write a concise "For You" note (2–4 sentences) that helps the viewer decide whether this video is worth their time and surfaces the single sharpest insight from it.

Anchor the note in the viewer's general interests and way of thinking — the "What I care about" and "What lights me up" sections of the profile below are your primary signal for tone and relevance. A note grounded in those sections is always better than a forced project tie-in.

The viewer's listed projects are context only. Do NOT force references to them. Name a project only when the video is unmistakably, specifically about that exact problem space — not when you can construct a clever-sounding link. If you are reaching for a project connection, skip it entirely; don't mention any project at all.

Things that indicate you are reaching (avoid all of these):
- Starting the note with the viewer's name ("Jac, ...")
- Starting with the creator's name or the video title
- Phrases like "is the inverse of," "maps directly onto," "maps cleanly to," "this speaks to," "this connects to your work on," "cuts to the heart of," "this video might resonate with," "sits at the intersection of"
- Name-dropping a project when the connection is clever rather than obvious
- Generic "you might find this interesting" filler
- Copying the opening, structure, or rhythm of any previous For You note
- Restating the video summary — the summary already exists right above

What a good note does:
- Picks one specific insight, not a recap
- Gives a crisp, honest read on whether it's worth the viewer's full attention, skippable, or worth thirty seconds for one thing in particular
- Uses a varied opening — different notes should NOT all start with "The ..."
- Feels like a friend saying "here's the one thing worth your time in this video"`;

// ─── KEYS / SECRETS ─────────────────────────────────────────────────────────

let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
if (!ANTHROPIC_API_KEY) {
  const candidates = [
    path.join(process.env.HOME || '', '.openclaw/secrets/anthropic.env'),
  ];
  for (const p of candidates) {
    try {
      const env = fs.readFileSync(p, 'utf8');
      const m = env.match(/ANTHROPIC_API_KEY=(.+)/);
      if (m) { ANTHROPIC_API_KEY = m[1].trim(); break; }
    } catch {}
  }
}

const r2Client = getR2Client();
console.log(r2Client ? '📦 R2 uploads enabled' : '📦 R2 uploads disabled (R2_* env vars not set)');

// ─── HELPERS ────────────────────────────────────────────────────────────────

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
      timeout: 90000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(bodyStr);
    req.end();
  });
}

function getBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getBinary(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function stripHtml(html = '', maxChars = 0) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
  return maxChars > 0 ? text.slice(0, maxChars) : text;
}

function loadVideos() {
  try {
    return JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8'));
  } catch {
    return { videos: [] };
  }
}

function saveVideos(data) {
  const tmp = VIDEOS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, VIDEOS_FILE);
}

function nextId(data) {
  const ids = (data.videos || []).map(v => v.id).filter(id => typeof id === 'number');
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function isDuplicate(data, videoId) {
  return (data.videos || []).some(v => v.videoId === videoId);
}

// Remove a videoId from the check-channels tracker so it gets retried on
// the next run. Called when a video fails the transcript step — we don't
// want a transient failure to make us blacklist the video forever.
const TRACKER_FILE = path.join(__dirname, 'video-tracker.json');
function unseenInTracker(channelId, videoId) {
  let tracker;
  try { tracker = JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8')); }
  catch { return; }
  const list = tracker.seenVideoIds?.[channelId];
  if (!Array.isArray(list)) return;
  const idx = list.indexOf(videoId);
  if (idx === -1) return;
  list.splice(idx, 1);
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
}

function getRecentForYouNotes(data, count = 6) {
  return (data.videos || [])
    .slice(0, count)
    .map(v => (v.forYou || '').trim())
    .filter(Boolean);
}

function renderListeningContext(recentNotes) {
  if (!recentNotes || recentNotes.length === 0) return '';
  const lines = recentNotes.map((n, i) => `${i + 1}. ${n}`);
  return `<previous_for_you_notes>\nHere are the last few "For You" notes you wrote for this viewer. Avoid repeating their openings, transitions, or turns of phrase — find a fresh angle.\n${lines.join('\n\n')}\n</previous_for_you_notes>`;
}

function buildVideoText(video, summary, forYou) {
  const sections = [
    video.channelName,
    video.title,
    stripHtml(summary || ''),
    forYou ? 'For You' : null,
    forYou ? stripHtml(forYou) : null,
  ];
  return joinForTTS(sections);
}

// Trim a long transcript to a budget. Keep the beginning and end intact —
// most YouTube videos top-and-tail the substance. For videos that fit, no-op.
function trimTranscript(text, maxChars = 60000) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.65));
  const tail = text.slice(-Math.floor(maxChars * 0.30));
  return head + '\n\n[... transcript trimmed for length ...]\n\n' + tail;
}

// ─── SUMMARY GENERATION ─────────────────────────────────────────────────────

async function generateSummary(video, transcript, listeningContext = '') {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const trimmed = trimTranscript(transcript || '');

  const prompt = `You are summarizing a YouTube video for a personal video summary app. The summary will be read aloud via TTS — aim for 5–7 minutes of spoken content (roughly 800–1100 words of plain text once HTML tags are stripped).

Channel: ${video.channelName}
Video title: ${video.title}
Date: ${video.date}
Duration: ${video.durationSec ? Math.round(video.durationSec / 60) + ' minutes' : 'unknown'}
RSS description: ${video.description || '(none)'}

<transcript>
${trimmed}
</transcript>

Write a rich, engaging summary in HTML (no <html>/<body> tags, just inner HTML).

Structure it as:
1. An overview section (3–4 sentences giving real context and why this video matters, use <p> tags)
2. <h3>Key Takeaways</h3> with a <ul> list of 6–8 specific, substantive points — each one a full sentence with enough detail to stand alone (use <li> tags)
3. <h3>Deeper Dive</h3> — 2–3 paragraphs expanding on the most interesting or surprising aspects of the video (use <p> tags)
4. One memorable quote from the video if there is one (use <blockquote>)

Then write the "For You" note following these rules:

${FOR_YOU_INSTRUCTION}

<viewer_profile>
${LISTENER_PROFILE_CORE}
</viewer_profile>
${LISTENER_FEEDBACK ? `
<viewer_feedback>
The viewer has written the following feedback about previous For You notes. Treat this as direct, high-priority instructions from them. Follow it strictly — it overrides other guidance when there's a conflict.

${LISTENER_FEEDBACK}
</viewer_feedback>
` : ''}${listeningContext ? '\n' + listeningContext + '\n' : ''}
Respond with EXACTLY this format and nothing else — no preamble, no JSON, no markdown code fences:

===SUMMARY===
<the HTML summary here>
===FORYOU===
<the plain-text "For You" note here>
===END===

The two heading lines (===SUMMARY===, ===FORYOU===, ===END===) must appear verbatim on their own lines so the parser can split on them. Don't put quotes around the content. Don't escape anything. The content between markers is taken as-is.`;

  const data = await post(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    {
      model: 'claude-haiku-4-5',
      max_tokens: 2400,
      messages: [{ role: 'user', content: prompt }],
    }
  );

  const text = data.content?.[0]?.text || '';
  return parseDelimitedResponse(text);
}

function parseDelimitedResponse(text) {
  const summaryMatch = text.match(/^[ \t]*={3,}\s*SUMMARY\s*={3,}[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*={3,}\s*FOR\s*YOU\s*={3,}/im);
  const forYouMatch = text.match(/^[ \t]*={3,}\s*FOR\s*YOU\s*={3,}[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*={3,}\s*END\s*={3,}|\s*$)/im);
  if (summaryMatch && forYouMatch) {
    return { summary: summaryMatch[1].trim(), forYou: forYouMatch[1].trim() };
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed && parsed.summary != null && parsed.forYou != null) return parsed;
    } catch {}
  }
  throw new Error('Could not parse Claude response. First 300 chars: ' + text.slice(0, 300).replace(/\s+/g, ' '));
}

// ─── AUDIO + THUMBNAIL ──────────────────────────────────────────────────────

const MIN_AUDIO_SIZE = 700 * 1024;

async function generateAudio(text, outputPath, options = {}) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= MIN_AUDIO_SIZE) return true;
  if (fs.existsSync(outputPath)) {
    console.log(`   ⚠️  Stale audio detected (${Math.round(fs.statSync(outputPath).size / 1024)}KB), regenerating…`);
    fs.unlinkSync(outputPath);
  }
  try {
    await generateAudioFromText(text, outputPath, options);
    return true;
  } catch (e) {
    console.error('   Edge-TTS failed:', e.message);
    return false;
  }
}

async function downloadThumbnail(videoId) {
  // YouTube doesn't always have maxresdefault — fall back through the
  // standard ladder.
  const urls = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  ];
  for (const url of urls) {
    try {
      const buf = await getBinary(url);
      if (buf.length > 5000) return buf;
    } catch {}
  }
  return null;
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('✍️  YouTube Summarizer — starting\n');

  if (!fs.existsSync(QUEUE_FILE)) {
    console.log('No queue file found. Run check-channels.cjs first.');
    return;
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const videos = queue.videos || [];
  if (!videos.length) {
    console.log('Queue is empty — nothing to summarize.');
    return;
  }

  console.log(`Processing ${videos.length} video(s)…\n`);

  const data = loadVideos();
  if (!Array.isArray(data.videos)) data.videos = [];

  const recentNotes = getRecentForYouNotes(data, 6);
  const listeningContext = renderListeningContext(recentNotes);
  console.log(`Loaded ${recentNotes.length} previous For You notes for variety guidance.\n`);

  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

  let added = 0;

  for (const v of videos) {
    console.log(`📝 ${v.channelName}: "${v.title}"`);

    if (isDuplicate(data, v.videoId)) {
      console.log('   ⏭️  Already in DB, skipping\n');
      continue;
    }

    // 1. Transcript
    let transcriptInfo = null;
    process.stdout.write('   Fetching transcript… ');
    try {
      transcriptInfo = await fetchTranscript(v.videoId, {
        durationSec: v.durationSec,
        skipWhisper: !!process.env.YT_SKIP_WHISPER,
      });
      console.log(`✓ ${transcriptInfo.source} · ${transcriptInfo.text.length} chars`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      console.log('   ⏭️  Skipping — no transcript means no summary.');
      // Self-heal: remove the videoId from the tracker so the next run
      // retries it. Without this, a transient transcript failure (rate
      // limit, bot wall, etc.) would mark the video as seen-forever via
      // check-channels.cjs and we'd never get a summary for it.
      unseenInTracker(v.channelId, v.videoId);
      console.log('   ↩  unmarked seen for retry next run.\n');
      continue;
    }

    // 2. Summary + For You (with one retry)
    let summary = '';
    let forYou = '';
    let summaryOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        process.stdout.write(attempt === 1 ? '   Generating summary… ' : '   Retrying summary… ');
        const result = await generateSummary(v, transcriptInfo.text, listeningContext);
        summary = result.summary;
        forYou = result.forYou;
        console.log('✓');
        summaryOk = true;
        break;
      } catch (err) {
        console.log(`✗ ${err.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!summaryOk) {
      console.log('   ⏭️  Skipping after summary failure.\n');
      continue;
    }

    // 3. Audio
    const audioPath = path.join(AUDIO_DIR, path.basename(v.audioFile));
    const voice = voiceForChannel(v.channelId);
    const ttsText = buildVideoText(v, summary, forYou);
    const spokenChars = stripHtml(summary).length + stripHtml(forYou || '').length;
    process.stdout.write(`   Generating audio (${voice})… `);
    const audioExists = await generateAudio(ttsText, audioPath, { voice });
    console.log(audioExists ? `✓ (~${Math.round((spokenChars / 15) / 60 * 10) / 10} min)` : '✗');

    // 4. Thumbnail
    process.stdout.write('   Downloading thumbnail… ');
    const thumbBuf = await downloadThumbnail(v.videoId);
    const thumbLocalPath = thumbBuf ? path.join(THUMBS_DIR, `${v.videoId}.jpg`) : null;
    if (thumbBuf && thumbLocalPath) {
      fs.writeFileSync(thumbLocalPath, thumbBuf);
      console.log(`✓ (${Math.round(thumbBuf.length / 1024)}KB)`);
    } else {
      console.log('✗');
    }

    // 5. R2 uploads
    if (r2Client) {
      if (audioExists) {
        process.stdout.write('   Uploading audio to R2… ');
        try {
          const result = await uploadToR2(r2Client, audioPath, `youtube/audio/${path.basename(audioPath)}`);
          console.log(result.uploaded ? '✓' : '⏭  (already present)');
        } catch (err) {
          console.log(`✗ ${err.message}`);
        }
      }
      if (thumbLocalPath) {
        process.stdout.write('   Uploading thumb to R2… ');
        try {
          const result = await uploadToR2(r2Client, thumbLocalPath, `youtube/thumbs/${v.videoId}.jpg`, {
            contentType: 'image/jpeg',
          });
          console.log(result.uploaded ? '✓' : '⏭  (already present)');
        } catch (err) {
          console.log(`✗ ${err.message}`);
        }
      }
    }

    // 6. Append to DB
    // Paths are stored as R2-relative keys (no leading slash). The Astro
    // URL builder prepends PUBLIC_AUDIO_BASE / PUBLIC_THUMB_BASE at render.
    const audioKey = `youtube/audio/${path.basename(v.audioFile)}`;
    const thumbKey = thumbLocalPath ? `youtube/thumbs/${v.videoId}.jpg` : v.thumb;

    const record = {
      id: nextId(data),
      videoId: v.videoId,
      channelId: v.channelId,
      channelName: v.channelName,
      title: v.title,
      date: v.date,
      published: v.published,
      durationSec: v.durationSec || null,
      link: v.link,
      thumb: thumbKey,
      summary,
      forYou,
      audioFile: audioKey,
      audioExists,
      transcriptSource: transcriptInfo.source,
    };
    data.videos.unshift(record);
    saveVideos(data);
    added++;
    console.log(`   ✅ Added as video #${record.id}\n`);
  }

  // Clear queue
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ checkedAt: queue.checkedAt, videos: [] }, null, 2));

  if (!added) {
    console.log('Nothing new added.');
    return;
  }

  if (IS_CI) {
    console.log(`\n✅ Added ${added} video(s). CI mode — skipping local build/deploy.`);
    return;
  }

  console.log(`\n✅ Added ${added} video(s). Building and deploying…`);
  try {
    execSync('bash deploy.sh', { cwd: ROOT, stdio: 'inherit' });
    console.log('\n🚀 Deployed!');
  } catch (err) {
    console.error('Deploy failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  LISTENER_PROFILE_CORE,
  LISTENER_FEEDBACK,
  FOR_YOU_INSTRUCTION,
  generateSummary,
  stripHtml,
};

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ Fatal error:', err);
    process.exit(1);
  });
}
