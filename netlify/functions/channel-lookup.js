/**
 * channel-lookup.js — resolve a YouTube channel input to a UC... id + metadata.
 *
 * Accepts ?query=<anything>: a full channel URL, an /@handle URL, a bare
 * "@handle", or an existing UC... id. Returns a structured object the
 * "+ Add channel" UI can write to Firestore directly.
 *
 * Strategy:
 *   1. If input contains a UC... id already, use it.
 *   2. Otherwise, fetch https://www.youtube.com/<input> and scrape the
 *      canonical channelId, name, description, and thumbnail from the
 *      embedded ytInitialData / metadata blob.
 *
 * No YouTube Data API. No OAuth. No quota.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function fetchWithTimeout(url, { timeoutMs = 6000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'youtube-summaries/1.0 (+netlify)',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function findChannelIdInHtml(html) {
  // Order matters: prefer the page's own canonical/external id over any
  // `channelId` JSON match, which can refer to related-channel chips, sub
  // counts, or comment-author embeds.
  const patterns = [
    /<link[^>]+rel="canonical"[^>]+href="https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/,
    /<link[^>]+href="https?:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"[^>]+rel="canonical"/,
    /<meta itemprop="identifier" content="(UC[A-Za-z0-9_-]{22})"/,
    /<meta itemprop="channelId" content="(UC[A-Za-z0-9_-]{22})"/,
    /"externalId":"(UC[A-Za-z0-9_-]{22})"/,
    /"externalChannelId":"(UC[A-Za-z0-9_-]{22})"/,
    /channel_id=(UC[A-Za-z0-9_-]{22})/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function findFieldInHtml(html, key) {
  // "key":"value" with JSON-escape tolerance.
  const re = new RegExp(`"${key}":"((?:\\\\"|[^"])*?)"`);
  const m = html.match(re);
  if (!m) return '';
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, ' ').trim();
}

function findChannelName(html) {
  // <meta itemprop="name"> and <meta property="og:title"> are server-rendered
  // and refer to the channel itself — much more reliable than the first
  // "title" JSON match (which is often the active tab's label).
  const itemprop = html.match(/<meta itemprop="name" content="([^"]+)"/);
  if (itemprop) return itemprop[1];
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (og) return og[1];
  return findFieldInHtml(html, 'title');
}

function findChannelDescription(html) {
  const og = html.match(/<meta property="og:description" content="([^"]+)"/);
  if (og) return og[1];
  const itemprop = html.match(/<meta itemprop="description" content="([^"]+)"/);
  if (itemprop) return itemprop[1];
  return findFieldInHtml(html, 'description');
}

function findAvatarUrl(html) {
  // <link rel="image_src"> is the cleanest channel-avatar pointer.
  const linkImg = html.match(/<link rel="image_src" href="([^"]+)"/);
  if (linkImg) return linkImg[1];
  const ogImg = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (ogImg) return ogImg[1];
  // Fall back to the JSON avatar blob.
  const m = html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/);
  if (m) return m[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
  return '';
}

function normalizeInput(raw) {
  const q = raw.trim();
  if (!q) return null;

  // Already a UC... id?
  const ucMatch = q.match(/(UC[A-Za-z0-9_-]{22})/);
  if (ucMatch) return { kind: 'ucid', value: ucMatch[1] };

  // Full URL?
  let url;
  try { url = new URL(q); } catch {}
  if (url && /youtube\.com$/i.test(url.hostname.replace(/^www\./, ''))) {
    return { kind: 'url', value: url.toString() };
  }

  // Handle (with or without @)
  if (q.startsWith('@')) {
    return { kind: 'handle', value: `https://www.youtube.com/${q}` };
  }
  // Best-effort: treat as a handle prefix or path
  return { kind: 'path', value: `https://www.youtube.com/${q.replace(/^\/+/, '')}` };
}

function findHandle(html) {
  const canonical = html.match(/"canonicalChannelUrl":"https:\/\/www\.youtube\.com\/(@[A-Za-z0-9_.-]+)"/);
  if (canonical) return canonical[1];
  const og = html.match(/<meta property="og:url" content="https?:\/\/www\.youtube\.com\/(@[A-Za-z0-9_.-]+)"/);
  if (og) return og[1];
  const ph = html.match(/"vanityChannelUrl":"http[^"]+\/(@[A-Za-z0-9_.-]+)"/);
  if (ph) return ph[1];
  return '';
}

async function lookupByUrl(url) {
  const res = await fetchWithTimeout(url, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const html = await res.text();

  const channelId = findChannelIdInHtml(html);
  if (!channelId) throw new Error('could not find UC channelId on page');

  return {
    channelId,
    name: findChannelName(html) || channelId,
    description: findChannelDescription(html),
    avatar: findAvatarUrl(html),
    handle: findHandle(html),
  };
}

async function lookupByUcid(ucid) {
  const res = await fetchWithTimeout(`https://www.youtube.com/channel/${ucid}`, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`fetch channel page → ${res.status}`);
  const html = await res.text();
  return {
    channelId: ucid,
    name: findChannelName(html) || ucid,
    description: findChannelDescription(html),
    avatar: findAvatarUrl(html),
    handle: findHandle(html),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  try {
    const query = (event.queryStringParameters?.query || '').trim();
    if (!query) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'query is required' }),
      };
    }

    const target = normalizeInput(query);
    if (!target) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'could not parse input' }),
      };
    }

    const info = target.kind === 'ucid'
      ? await lookupByUcid(target.value)
      : await lookupByUrl(target.value);

    // If we couldn't scrape a handle but the user pasted one, keep it.
    if (!info.handle && target.kind === 'handle') {
      const m = query.match(/(@[A-Za-z0-9_.-]+)/);
      if (m) info.handle = m[1];
    }

    const payload = {
      id: info.channelId,
      name: info.name,
      handle: info.handle,
      icon: info.avatar,
      description: info.description.slice(0, 500),
      url: info.handle
        ? `https://www.youtube.com/${info.handle}`
        : `https://www.youtube.com/channel/${info.channelId}`,
      feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${info.channelId}`,
    };

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error('channel-lookup error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'lookup failed' }),
    };
  }
};
