# YouTube Summaries

Personalized AI-generated summaries of new videos from tracked YouTube channels, with TTS audio.

Sibling of [podcast-summaries](https://github.com/gautjac/podcast-summaries) — same shape, same `profile.md`, same `FOR_YOU_INSTRUCTION`.

**Live:** https://yt-jac.netlify.app

## Stack

- Astro static site, deployed on Netlify (auto on push to `main`)
- Firestore for channel catalog + watched state (project `charlotte-dashboard`)
- Cloudflare R2 for audio + thumbnails (reuses the `podcast-app` bucket under `youtube/` prefix)
- Anthropic Claude (Haiku 4.5) for summary + For You
- Edge-TTS for audio narration
- Transcripts via YouTube timedtext → `yt-dlp` → Whisper (capped at 90 min)

## Environment

Create a `.env` in the repo root (gitignored):

```
FIREBASE_API_KEY=...          # Public web key (matches the one embedded in the Astro pages)
NETLIFY_AUTH_TOKEN=...
NETLIFY_SITE_ID=...
ANTHROPIC_API_KEY=...         # For summarize-queue
OPENAI_API_KEY=...            # Optional — only for Whisper fallback when captions are missing
R2_ENDPOINT=...
R2_BUCKET=podcast-app
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
PUBLIC_AUDIO_BASE=https://pub-<hash>.r2.dev   # Public R2 URL prefix
PUBLIC_THUMB_BASE=https://pub-<hash>.r2.dev   # Same bucket, different prefix
```

Optional Whisper tuning:

```
WHISPER_MAX_DURATION_SEC=5400    # Skip Whisper above 90 min
WHISPER_CPP_BIN=/opt/homebrew/bin/whisper-cli   # Local whisper.cpp (free)
WHISPER_CPP_MODEL=/path/to/ggml-small.en.bin
YT_SKIP_WHISPER=1                # Skip Whisper entirely
```

## Development

```bash
npm install
npm run dev          # Local dev server
npm run build        # Build (fetches channel catalog from Firestore first)
./deploy.sh          # Manual deploy
```

## Adding channels

1. Open the live site, click **Channels → + Add channel**.
2. Paste a channel URL, an `@handle`, or a `UC...` id. Click **Look up**.
3. Adjust the minimum video length and the skip-reuploads toggle.
4. Save. The catalog lives in Firestore — live immediately.

## Ingestion pipeline

```bash
node scripts/check-channels.cjs   # 1. Poll RSS, filter, write video-queue.json
node scripts/summarize-queue.cjs  # 2. Fetch transcripts + summarize + TTS + deploy
```

`check-channels.cjs` filters:
- Drops shorts (`/shorts/` URL or duration < 60s).
- Drops livestreams (`isLive`, `isUpcoming`, or `isLiveContent`).
- Drops videos shorter than each channel's `minLengthSec` (default 5 min).
- Drops obvious re-uploads (`BEST OF`, `COMPILATION`, year-prefixed titles) when the channel has `skipReuploads` set.

`summarize-queue.cjs` transcript fall-through:
1. YouTube `timedtext` (free, instant).
2. `yt-dlp --write-auto-sub` (robust fallback).
3. Whisper — local `whisper.cpp` if configured, else OpenAI Whisper API (~$0.006/min, capped).

## File layout

```
youtube-summaries/
├── src/
│   ├── data/{videos,channels}.json
│   └── pages/{index,channels,watched}.astro
├── scripts/
│   ├── check-channels.cjs
│   ├── summarize-queue.cjs
│   ├── transcript.cjs
│   ├── tts-edge.cjs       # copied from podcast-summaries
│   ├── voice-map.cjs
│   ├── r2-upload.cjs      # copied from podcast-summaries
│   ├── fetch-data.js
│   ├── profile.md         # copied from podcast-summaries
│   ├── video-queue.json   # transient
│   └── video-tracker.json # transient
├── netlify/functions/
│   └── channel-lookup.js
├── astro.config.mjs
├── netlify.toml
└── deploy.sh
```

## Firestore collections

- `youtube_channels/{UCxxxxxxxx}` — channel catalog. Fields: `name`, `handle`, `icon`, `description`, `url`, `feedUrl`, `minLengthSec`, `skipReuploads`, `voiceId`, `addedAt`.
- `youtube_watched/{videoId}` — per-video watched marker. Fields: `videoId`, `watchedAt`.

The two collections live alongside the podcast app's `podcasts` and `podcast_listened` in the same Firestore project.

### Firestore rules

Add these rules to `~/inkwell/firestore.rules` (or wherever the project's rules live) alongside the podcast app's rules:

```
match /youtube_channels/{channelId} {
  allow read, write: if true;
}
match /youtube_watched/{videoId} {
  allow read, write: if true;
}
```

Without these, the catalog reads return 403 and the watched page falls back to its empty state.
