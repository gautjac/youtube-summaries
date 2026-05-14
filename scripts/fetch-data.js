#!/usr/bin/env node
/**
 * fetch-data.js — pre-build step.
 *
 * Pulls the channel catalog from Firestore and writes src/data/channels.json
 * so the Astro build has the latest channel metadata baked in. Mirrors
 * podcast-summaries/scripts/fetch-data.js.
 *
 * Reads:
 *   FIREBASE_API_KEY env var (public web key, also in .env)
 *
 * Writes:
 *   src/data/channels.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || '';
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || 'charlotte-dashboard';
const COLLECTION = process.env.YT_CHANNELS_COLLECTION || 'youtube_channels';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

if (!FIREBASE_API_KEY) {
  console.error('❌ FIREBASE_API_KEY env var is required. Set it in .env or the Netlify build env.');
  process.exit(1);
}

function parseDoc(doc) {
  const id = doc.name?.split('/').pop() || '';
  const f = doc.fields || {};
  const str = k => f[k]?.stringValue || '';
  const num = k => f[k]?.integerValue != null ? parseInt(f[k].integerValue, 10) : null;
  const bool = k => !!f[k]?.booleanValue;
  return {
    id, // UC...
    name: str('name') || id,
    handle: str('handle'),
    description: str('description'),
    icon: str('icon'),
    url: str('url'),
    feedUrl: str('feedUrl') || (id.startsWith('UC') ? `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` : ''),
    minLengthSec: num('minLengthSec') || 300,
    skipReuploads: bool('skipReuploads'),
    voiceId: str('voiceId'),
    addedAt: str('addedAt'),
  };
}

async function fetchChannels() {
  const url = `${FIRESTORE_BASE}/${COLLECTION}?key=${FIREBASE_API_KEY}&pageSize=300`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404 || res.status === 403) {
      console.warn(`  ⚠️  Firestore collection "${COLLECTION}" not found or unreadable (HTTP ${res.status}). Writing empty catalog.`);
      return [];
    }
    throw new Error(`Failed to fetch channels: ${res.status}`);
  }
  const data = await res.json();
  const docs = data.documents || [];
  return docs.map(parseDoc).sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  console.log('Fetching channel catalog from Firestore...');
  const channels = await fetchChannels();
  console.log(`  Found ${channels.length} channel(s)`);

  const outputPath = join(__dirname, '../src/data/channels.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify({ channels }, null, 2));
  console.log(`  Written to ${outputPath}`);
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
