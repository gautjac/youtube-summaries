#!/usr/bin/env node
/**
 * check-channels.cjs — Step 1 of the YouTube ingestion pipeline.
 *
 * Reads the channel list from src/data/channels.json (synced from Firestore
 * by `npm run fetch`), hits each channel's public RSS feed, filters out
 * shorts/livestreams/short videos/per-channel re-uploads, and writes a
 * queue for summarize-queue.cjs to process.
 *
 * No AI, no transcripts — just deterministic feed checking. Completes in
 * < 2 minutes regardless of subscription count.
 *
 * Usage: node scripts/check-channels.cjs
 *
 * Writes: scripts/video-queue.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, spawnSync } = require('child_process');

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const QUEUE_FILE = path.join(__dirname, 'video-queue.json');
const TRACKER_FILE = process.env.YT_TRACKER_FILE
  || path.join(__dirname, 'video-tracker.json');
const VIDEOS_FILE = path.join(ROOT, 'src/data/videos.json');
const CHANNELS_FILE = path.join(ROOT, 'src/data/channels.json');

// Only ingest videos newer than this date (avoids backfill storms when a
// new channel is added).
const SINCE_DATE = new Date(process.env.YT_SINCE_DATE || '2026-05-14T00:00:00Z');

// Default minimum length (seconds) if a channel doesn't specify one.
const DEFAULT_MIN_LENGTH = 5 * 60;

// Max videos per channel per run. Keeps the queue bounded.
const MAX_PER_CHANNEL = 3;

// ─── HELPERS ────────────────────────────────────────────────────────────────

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects: ' + url));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'youtube-summaries/1.0 (+https://yt-jac.netlify.app)',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 20000,
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

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function extractText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return decodeEntities(
    m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim()
  );
}

function extractAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1] : '';
}

// YouTube channel feeds use <entry> not <item>.
function parseEntries(xml) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const videoId = extractText(block, 'yt:videoId');
    const channelId = extractText(block, 'yt:channelId');
    const title = extractText(block, 'title');
    const published = extractText(block, 'published');
    const updated = extractText(block, 'updated');
    const author = extractText(block, 'name');
    const description = extractText(block, 'media:description');
    const link = extractAttr(block, 'link', 'href');
    const thumb = extractAttr(block, 'media:thumbnail', 'url');
    if (!videoId || !title) continue;
    entries.push({
      videoId,
      channelId,
      title,
      published,
      updated,
      author,
      description,
      link: link || `https://www.youtube.com/watch?v=${videoId}`,
      thumb: thumb || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    });
  }
  return entries;
}

function loadTracker() {
  try {
    return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
  } catch {
    return { seenVideoIds: {}, lastChecked: {} };
  }
}

function saveTracker(tracker) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
}

function loadChannels() {
  try {
    return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')).channels || [];
  } catch {
    return [];
  }
}

function loadExistingVideoIds() {
  try {
    const data = JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8'));
    return new Set((data.videos || []).map(v => v.videoId).filter(Boolean));
  } catch {
    return new Set();
  }
}

function whichSync(bin) {
  try { return execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim(); } catch { return ''; }
}

// Get duration, livestream status, and short-form flag for a video.
// Prefers yt-dlp's Innertube metadata (reliable on CI; the watch-page HTML
// gets HTTP 429'd from GitHub Actions runner IPs). Falls back to scraping
// the watch page when yt-dlp isn't on PATH or returns nothing useful.
// Returns { durationSec, isLive, isShort } or null on total failure.
async function fetchVideoMeta(videoId) {
  // ─── Path A: yt-dlp metadata JSON ─────────────────────────────────────
  const ytdlp = whichSync('yt-dlp');
  if (ytdlp) {
    const args = [
      '-j', '--skip-download', '--no-warnings',
      '--extractor-args', 'youtube:player_client=android',
    ];
    if (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) {
      args.push('--cookies', process.env.YT_COOKIES_FILE);
    }
    args.push(`https://www.youtube.com/watch?v=${videoId}`);
    const result = spawnSync(ytdlp, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.stdout) {
      try {
        const d = JSON.parse(result.stdout);
        const durationSec = typeof d.duration === 'number' ? Math.round(d.duration) : null;
        const liveStatus = d.live_status || (d.is_live ? 'is_live' : null);
        const isLive = liveStatus === 'is_live' || liveStatus === 'is_upcoming' || liveStatus === 'post_live';
        // yt-dlp exposes a few short-form signals: webpage_url contains /shorts/,
        // or the format width/height ratio is portrait with duration < 60s.
        const url = d.webpage_url || d.original_url || '';
        const portrait = (d.width && d.height && d.height > d.width);
        const isShort = /\/shorts\//.test(url) ||
          (durationSec !== null && durationSec < 60 && portrait) ||
          (durationSec !== null && durationSec < 60);
        return { durationSec, isLive, isShort };
      } catch (err) {
        // fall through to HTML scrape
      }
    }
  }

  // ─── Path B: watch-page HTML scrape (works locally; flaky on CI) ─────
  let html;
  try {
    html = await fetchUrl(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
  } catch (err) {
    console.log(`     ⚠️  meta fetch failed (${err.message})`);
    return null;
  }
  let durationSec = null;
  const lenMatch = html.match(/"lengthSeconds":"(\d+)"/);
  if (lenMatch) durationSec = parseInt(lenMatch[1], 10);
  const isLive =
    /"isLive":true/.test(html) ||
    /"isLiveContent":true/.test(html) ||
    /"isUpcoming":true/.test(html);
  const isShort = /\/shorts\//.test(html.slice(0, 50000)) ||
    (durationSec !== null && durationSec < 60);
  return { durationSec, isLive, isShort };
}

function isReuploadTitle(title) {
  if (!title) return false;
  const t = title.toUpperCase();
  if (/\bBEST OF\b/.test(t)) return true;
  if (/\bCOMPILATION\b/.test(t)) return true;
  if (/\bMEGA[ -]?MIX\b/.test(t)) return true;
  if (/\bMARATHON\b/.test(t)) return true;
  if (/^\s*20\d{2}\b/.test(t)) return true; // year-only prefix
  return false;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch {
    return '';
  }
}

function slugDate(iso) {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📺  YouTube Channel Checker — starting\n');

  const channels = loadChannels();
  if (!channels.length) {
    console.log('No channels in src/data/channels.json. Add one via the live site,');
    console.log('then run `npm run fetch` to pull the catalog from Firestore.');
    fs.writeFileSync(QUEUE_FILE, JSON.stringify({
      checkedAt: new Date().toISOString(), videos: []
    }, null, 2));
    return;
  }

  const tracker = loadTracker();
  const existingIds = loadExistingVideoIds();
  const queue = [];

  for (const channel of channels) {
    const chId = channel.id || channel.channelId;
    const chName = channel.name || chId;
    process.stdout.write(`  ${chName} … `);

    if (!chId || !chId.startsWith('UC')) {
      console.log('✗ no UC channel id');
      continue;
    }

    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}`;
    let xml;
    try {
      xml = await fetchUrl(feedUrl);
    } catch (err) {
      console.log(`✗ feed error: ${err.message}`);
      continue;
    }

    const entries = parseEntries(xml);
    if (!entries.length) {
      console.log('⚠️  no entries');
      continue;
    }

    tracker.seenVideoIds = tracker.seenVideoIds || {};
    tracker.lastChecked = tracker.lastChecked || {};
    tracker.lastChecked[chId] = new Date().toISOString();
    const seenSet = new Set(tracker.seenVideoIds[chId] || []);

    const candidates = [];
    for (const entry of entries) {
      if (seenSet.has(entry.videoId)) continue;
      if (existingIds.has(entry.videoId)) continue;
      const pub = entry.published ? new Date(entry.published) : null;
      if (pub && pub < SINCE_DATE) continue;
      candidates.push(entry);
    }

    if (!candidates.length) {
      console.log('✓ up to date');
      // Refresh the seen set to cover the latest entries even when none
      // pass the queue filter, so we don't re-evaluate them next run.
      for (const e of entries) seenSet.add(e.videoId);
      tracker.seenVideoIds[chId] = [...seenSet].slice(-50);
      continue;
    }

    let added = 0;
    const skipReuploads = !!channel.skipReuploads;
    const minLen = Number(channel.minLengthSec) || DEFAULT_MIN_LENGTH;

    for (const entry of candidates.slice(0, MAX_PER_CHANNEL * 3)) {
      // Title-based filters can be evaluated without a network call, so
      // we can confidently mark seen and move on.
      if (skipReuploads && isReuploadTitle(entry.title)) {
        seenSet.add(entry.videoId);
        continue;
      }

      const meta = await fetchVideoMeta(entry.videoId);
      // Transient failure — don't mark seen, so a future run can retry.
      // (Previously this branch silently dropped videos forever after one
      //  CI rate-limit blip.)
      if (!meta) continue;

      // From here on we successfully evaluated the video, so mark seen
      // regardless of whether it passes filters.
      seenSet.add(entry.videoId);

      if (meta.isLive) continue;
      if (meta.isShort) continue;
      if (meta.durationSec !== null && meta.durationSec < minLen) continue;

      queue.push({
        videoId: entry.videoId,
        channelId: chId,
        channelName: chName,
        title: entry.title,
        date: formatDate(entry.published),
        dateSlug: slugDate(entry.published),
        published: entry.published,
        description: entry.description,
        durationSec: meta.durationSec,
        link: entry.link,
        thumb: entry.thumb,
        audioFile: `/audio/${chId}-${entry.videoId}.mp3`,
      });

      added++;
      if (added >= MAX_PER_CHANNEL) break;
    }

    tracker.seenVideoIds[chId] = [...seenSet].slice(-50);

    if (added) console.log(`🆕 ${added} new`);
    else console.log('✓ none after filters');
  }

  saveTracker(tracker);

  fs.writeFileSync(QUEUE_FILE, JSON.stringify({
    checkedAt: new Date().toISOString(),
    videos: queue,
  }, null, 2));

  if (!queue.length) {
    console.log('\n✅ No new videos to process.');
    return;
  }

  console.log(`\n✅ Queue written: ${queue.length} video(s) ready for summarization`);
  queue.forEach(v => console.log(`   • [${v.channelName}] ${v.title}`));
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
