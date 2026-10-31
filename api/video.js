import { guard } from "./_lib/guard.js";
import { LIMITS, clean } from "./_lib/song.js";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  // Skips YouTube's cookie-consent interstitial that breaks scraping from the EU.
  Cookie: "CONSENT=YES+1; SOCS=CAI",
};

// oEmbed answers 200 only for videos that exist AND allow embedding.
async function isEmbeddable(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Preferred: official API (set YOUTUBE_API_KEY). Reliable and respects "embeddable".
async function searchWithApi(query) {
  const params = new URLSearchParams({
    part: "id",
    type: "video",
    videoEmbeddable: "true",
    videoSyndicated: "true",
    maxResults: "3",
    q: query,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    headers: { "x-goog-api-key": process.env.YOUTUBE_API_KEY },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`youtube api HTTP ${res.status}`);
  const data = await res.json();
  const id = (data?.items || []).map((i) => i?.id?.videoId).find((v) => VIDEO_ID.test(v || ""));
  return id || null;
}

// Fallback: read the public search page. Fragile by nature, so it is time-boxed.
async function searchByScraping(query) {
  const res = await fetch(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(4000) }
  );
  if (!res.ok) throw new Error(`youtube search HTTP ${res.status}`);
  const html = await res.text();

  const ids = [];
  for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)) {
    if (!ids.includes(m[1])) ids.push(m[1]);
    if (ids.length >= 5) break;
  }

  // Check all candidates at once, then keep the best-ranked one that works.
  const checks = await Promise.all(ids.map((id) => isEmbeddable(id)));
  const index = checks.findIndex(Boolean);
  return index >= 0 ? ids[index] : null;
}

export default async function handler(req, res) {
  if (!guard(req, res, { method: "GET", name: "video", limit: 40, windowMs: 60_000 })) return;

  const raw = Array.isArray(req.query?.q) ? req.query.q[0] : req.query?.q;
  const query = clean(raw, LIMITS.query);
  if (!query) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Missing search text.", code: "bad_input" });
  }

  let videoId = null;
  try {
    if (process.env.YOUTUBE_API_KEY) {
      try {
        videoId = await searchWithApi(query);
      } catch (err) {
        console.error(`video: ${err?.message || err}`);
      }
    }
    if (!videoId) videoId = await searchByScraping(query);
  } catch (err) {
    console.error(`video: ${err?.message || err}`);
  }

  // Cache good answers at the CDN so repeat searches cost nothing.
  res.setHeader(
    "Cache-Control",
    videoId
      ? "public, s-maxage=86400, stale-while-revalidate=604800"
      : "public, s-maxage=60"
  );
  return res.status(200).json({ videoId });
}
