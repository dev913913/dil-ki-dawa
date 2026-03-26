const GEMINI_MODELS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemma-3-27b-it",
];

const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch?v=";

const SYSTEM_PROMPT = `You are a wise, gentle curator of old classical Hindi songs — a musical healer who has spent decades understanding the deep connection between music and the human heart.

When someone shares their mood, feeling, or problem with you, you find the ONE perfect old Hindi song that speaks to exactly what they are feeling. You have encyclopedic knowledge of Hindi film songs from the 1940s to 1980s — the golden era of Indian cinema music.

You understand that these old songs carry wisdom, poetry, and emotion that can heal, comfort, and guide.

RULES:
- Recommend ONLY old classical Hindi film songs — from roughly 1940s to early 1980s
- Pick songs where the lyrics or mood DIRECTLY match the person's emotional state
- Never recommend the same obvious songs every time — explore the vast treasure of Hindi music
- Consider singers like Lata Mangeshkar, Mohammed Rafi, Kishore Kumar, Mukesh, Hemant Kumar, Talat Mahmood, Geeta Dutt, Asha Bhosle and many more
- Consider music directors like S.D. Burman, R.D. Burman, Naushad, Madan Mohan, Shankar Jaikishan, Salil Chowdhury and more

RESPONSE FORMAT — return ONLY valid JSON, nothing else, no markdown, no explanation:
{
  "song": "Song name in Hindi/English",
  "singer": "Singer name",
  "film": "Film name",
  "year": "Year",
  "searchQuery": "exact YouTube search query to find this song",
  "why": "One short sentence — why this song for this mood"
}`;

async function tryGemini(mood, category) {
  if (!process.env.GEMINI_API_KEY) return null;

  const userMessage = `My mood category: ${category}\n\nWhat I'm feeling: ${mood}`;

  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ parts: [{ text: userMessage }] }],
            generationConfig: { maxOutputTokens: 512, temperature: 0.85 },
          }),
        }
      );

      if (!res.ok) continue;

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return { text, source: `gemini:${model}` };
    } catch {
      continue;
    }
  }
  return null;
}

async function tryGroq(mood, category) {
  if (!process.env.GROQ_API_KEY) return null;

  const userMessage = `My mood category: ${category}\n\nWhat I'm feeling: ${mood}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_tokens: 512,
        temperature: 0.85,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (text) return { text, source: "groq:llama3" };
  } catch {
    return null;
  }
  return null;
}

function extractVideoIdsFromYoutubeHtml(html) {
  const ids = new Set();
  const regex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1]);
    if (ids.size >= 8) break;
  }

  return [...ids];
}

async function isEmbeddableYoutubeVideo(videoId) {
  const watchUrl = `${YOUTUBE_WATCH_BASE}${videoId}`;
  const oEmbedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  try {
    const res = await fetch(oEmbedUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function findEmbeddableYoutubeVideo(searchQuery) {
  if (!searchQuery) return null;

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;

    const html = await res.text();
    const candidateIds = extractVideoIdsFromYoutubeHtml(html);

    for (const videoId of candidateIds) {
      const embeddable = await isEmbeddableYoutubeVideo(videoId);
      if (embeddable) {
        return {
          videoId,
          watchUrl: `${YOUTUBE_WATCH_BASE}${videoId}`,
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { mood, category } = req.body || {};
  if (!mood) {
    return res.status(400).json({ error: "No mood provided" });
  }

  const moodCategory = category || "Feeling low";

  // Try Gemini first, then Groq
  const result = await tryGemini(mood, moodCategory) || await tryGroq(mood, moodCategory);

  if (!result) {
    return res.status(500).json({ error: "Could not find a song right now. Please try again." });
  }

  // Parse JSON from AI response
  try {
    const clean = result.text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const song = JSON.parse(clean);

    const embedData = await findEmbeddableYoutubeVideo(song.searchQuery || `${song.song} ${song.singer}`);
    if (embedData) {
      song.youtube = embedData;
    }

    return res.status(200).json({ song, source: result.source });
  } catch {
    // If JSON parse fails, return raw text
    return res.status(200).json({ raw: result.text, source: result.source });
  }
}
