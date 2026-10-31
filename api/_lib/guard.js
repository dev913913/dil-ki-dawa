// Shared request protection for the API routes.
// Files starting with "_" inside /api are NOT exposed as routes by Vercel.

const buckets = new Map();
const MAX_KEYS = 5000;

export function getClientIp(req) {
  const h = req.headers || {};
  if (h["x-real-ip"]) return String(h["x-real-ip"]).trim();
  if (h["x-forwarded-for"]) return String(h["x-forwarded-for"]).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function prune(now) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.reset) buckets.delete(key);
  }
  if (buckets.size >= MAX_KEYS) buckets.clear(); // hard safety valve
}

// Best-effort, per-server-instance limiter. It stops casual abuse and loops;
// for strong protection also enable Vercel Firewall rate limiting.
export function rateLimit(req, { name, limit, windowMs }) {
  const now = Date.now();
  const key = `${name}:${getClientIp(req)}`;
  let bucket = buckets.get(key);

  if (!bucket || now >= bucket.reset) {
    if (buckets.size >= MAX_KEYS) prune(now);
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  return {
    ok: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)),
  };
}

// Browsers send an Origin header on cross-site requests. Reject other sites.
export function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true; // same-origin GET, or a non-browser client
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Checks method, origin and rate limit. Returns true when the request may
 * continue; otherwise it has already answered the client and the handler must stop.
 * `extra` is merged into the 429 body (used to keep the care flag on errors).
 */
export function guard(req, res, { method, name, limit, windowMs, extra = {} }) {
  if (req.method !== method) {
    res.setHeader("Allow", method);
    res.status(405).json({ error: "Method not allowed.", code: "method" });
    return false;
  }

  if (!isSameOrigin(req)) {
    res.status(403).json({ error: "Request not allowed.", code: "origin" });
    return false;
  }

  const rl = rateLimit(req, { name, limit, windowMs });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({
      error: "Too many requests. Please wait a minute and try again.",
      code: "rate_limited",
      ...extra,
    });
    return false;
  }

  return true;
}
