import { guard } from "./_lib/guard.js";
import {
  SYSTEM_PROMPT,
  buildUserMessage,
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
const PER_CALL_MAX_MS = 5500;
const MIN_CALL_MS = 1500;

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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!guard(req, res, { method: "POST", name: "chat", limit: 12, windowMs: 60_000 })) return;

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
    });
  }

  const userMessage = buildUserMessage(input);
  const started = Date.now();

  for (const attempt of attempts) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < MIN_CALL_MS) break;

    try {
      const text = await attempt.run(Math.min(PER_CALL_MAX_MS, left), userMessage);
      const result = parseSong(text);
      if (!result) {
        console.error(`chat: ${attempt.label} returned unusable output`);
        continue;
      }

      const needsCare = result.needsCare || looksLikeCrisis(input.userText);
      return res.status(200).json({ song: result.song, needsCare });
    } catch (err) {
      // Log the reason, never the user's text or any key.
      console.error(`chat: ${attempt.label} failed: ${err?.message || err}`);
    }
  }

  return res.status(502).json({
    error: "Could not find a song right now. Please try again in a moment.",
    code: "unavailable",
  });
}
