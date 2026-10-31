import { guard } from "./_lib/guard.js";
import {
  LIMITS,
  SYSTEM_PROMPT,
  buildUserMessage,
  clean,
  looksLikeCrisis,
  parseInput,
  parseSong,
} from "./_lib/song.js";

// Models can be changed from Vercel env vars without touching code:
//   GEMINI_MODELS="gemini-2.5-flash,gemini-2.5-flash-lite"   GROQ_MODEL="llama-3.1-8b-instant"
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const TOTAL_BUDGET_MS = 8500; // stays under Vercel's default 10s limit
const PER_CALL_MAX_MS = 4000; // cap for every attempt except the last
const LAST_CALL_MAX_MS = 4500;
const RESERVE_FOR_LAST_MS = 2500; // always keep this much time for the final backup
const MIN_CALL_MS = 1200;

/** Asks one Gemini model for a song; resolves to the reply text or throws. */
async function callGemini(model, userMessage, timeoutMs) {
  const generationConfig = {
    maxOutputTokens: 1024,
    temperature: 0.9,
    responseMimeType: "application/json",
  };
  // 2.5 Flash models "think" by default, which eats the token budget.
  if (/^gemini-2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    }
  );

  if (!res.ok) throw new Error(`gemini ${model} HTTP ${res.status}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error(`gemini ${model} empty reply`);
  return parts
    .filter((p) => typeof p?.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

/** Asks Groq (backup) for a song; resolves to the reply text or throws. */
async function callGroq(userMessage, timeoutMs) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 700,
      temperature: 0.9,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) throw new Error(`groq HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/** POST /api/chat: validates input, asks the AI providers in order, returns one checked song. */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Local distress check. It does not depend on any AI call, so it is computed first
  // and included in EVERY reply (success, rate limit, outage, not configured).
  const needsCare = looksLikeCrisis(clean(req.body?.userText ?? req.body?.mood, LIMITS.userText));

  if (!guard(req, res, { method: "POST", name: "chat", limit: 12, windowMs: 60_000, extra: { needsCare } })) return;

  const parsed = parseInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error, code: "bad_input" });
  const input = parsed.value;

  const attempts = [];
  if (process.env.GEMINI_API_KEY) {
    for (const model of GEMINI_MODELS) {
      attempts.push({ label: `gemini:${model}`, run: (ms, msg) => callGemini(model, msg, ms) });
    }
  }
  if (process.env.GROQ_API_KEY) {
    attempts.push({ label: `groq:${GROQ_MODEL}`, run: (ms, msg) => callGroq(msg, ms) });
  }

  if (!attempts.length) {
    console.error("chat: no GEMINI_API_KEY or GROQ_API_KEY configured");
    return res.status(503).json({
      error: "The song finder is not set up yet. Please try again later.",
      code: "not_configured",
      needsCare,
    });
  }

  const userMessage = buildUserMessage(input);
  const started = Date.now();

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const isLast = i === attempts.length - 1;
    const left = TOTAL_BUDGET_MS - (Date.now() - started);

    // A slow earlier model must never starve the last backup of its turn.
    const available = isLast ? left : left - RESERVE_FOR_LAST_MS;
    if (available < MIN_CALL_MS) {
      if (isLast) break;
      continue;
    }
    const timeoutMs = Math.min(isLast ? LAST_CALL_MAX_MS : PER_CALL_MAX_MS, available);

    try {
      const text = await attempt.run(timeoutMs, userMessage);
      const result = parseSong(text);
      if (!result) {
        console.error(`chat: ${attempt.label} returned unusable output`);
        continue;
      }

      return res.status(200).json({ song: result.song, needsCare: needsCare || result.needsCare });
    } catch (err) {
      // Log the reason, never the user's text or any key.
      console.error(`chat: ${attempt.label} failed: ${err?.message || err}`);
    }
  }

  return res.status(502).json({
    error: "Could not find a song right now. Please try again in a moment.",
    code: "unavailable",
    needsCare,
  });
}
