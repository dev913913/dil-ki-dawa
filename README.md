# ❤️ Dil Ki Dawa — Medicine for the Heart

Dil Ki Dawa suggests an **old Hindi film song** for how you feel.
Pick a mood or write a few words, and it finds a song, tells you why it fits, and plays it.

Live: https://dil-ki-dawa.vercel.app

> हर एहसास का एक गाना होता है। — Every feeling has a song.

## Features
- Mood chips + free text (blend several moods)
- AI song suggestion with singer, film, year and a one-line reason
- **Try another song** (remembers recent songs so it does not repeat)
- **Save favourites** (stored only in your own browser)
- YouTube player with a safe fallback link
- Gentle support note (Tele-MANAS 14416) if someone sounds in serious distress
- Keyboard and screen-reader friendly, mobile first

## How it is built
- Plain HTML, CSS, JavaScript (no build step)
- `api/chat.js` — validates input, asks Gemini (then Groq as backup), checks the answer
- `api/video.js` — finds an embeddable YouTube video, cached at the CDN
- `api/_lib/` — shared code (input rules, prompt, parsing, rate limit)
- `vercel.json` — security headers (CSP and more)

## Setup (Vercel → Settings → Environment Variables)
| Name | Needed? | What for |
|---|---|---|
| `GEMINI_API_KEY` | one of these two | main AI |
| `GROQ_API_KEY` | one of these two | backup AI |
| `YOUTUBE_API_KEY` | recommended | reliable video search (YouTube Data API v3) |
| `GEMINI_MODELS` | optional | e.g. `gemini-2.5-flash,gemini-2.5-flash-lite` |
| `GROQ_MODEL` | optional | default `llama-3.1-8b-instant` |

Model names change over time. If songs stop loading, update `GEMINI_MODELS` / `GROQ_MODEL` here; no code change needed.

## Safety notes
- Inputs are length-limited and treated as data, not instructions.
- AI output is validated and shown as plain text only.
- Basic per-IP rate limiting is built in. It works per server instance, so for strong protection also turn on **Vercel Firewall → Rate Limiting** for `/api/*`.
- Your words go to the AI provider to pick a song; the app does not store them.

## Tests
```
npm test
```
Covers input rules, AI-output parsing, distress detection, rate limiting and origin checks.

## Author
Dev Kumar

> "Jo dil mein hai, woh gaana ban jaata hai."
