# Whisper Live

Cloudflare Pages + Pages Functions + PWA for English realtime transcription with OpenAI `gpt-realtime-whisper`.

## What It Does

- Runs as a mobile-first PWA on iPhone and iPad Safari.
- Uses WebRTC for low-latency microphone audio.
- Sends the OpenAI API key only from Cloudflare Pages Functions.
- Shows live transcript deltas and final transcript lines.
- Switches between English-only transcription and English-to-Japanese live translation.
- Keeps the live view to the latest few lines while retaining a full transcript panel.
- Supports copy, clear, and `.txt` download.

## Local Setup

```powershell
npm install
npm run build
```

For local browser UI work:

```powershell
npm run dev
```

The Vite dev server uses HTTPS because iOS/Safari requires a secure context for microphone access outside of `localhost`.

For local end-to-end testing with the Cloudflare Function:

```powershell
copy .dev.vars.example .dev.vars
# Put your real OpenAI API key in .dev.vars
npx wrangler pages dev dist
```

Build first so `dist` exists, then open the local Wrangler URL.

## Cloudflare Pages Deploy

1. Create a Cloudflare Pages project from this repository.
2. Use these build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
3. Add a Pages environment variable or secret:
   - `OPENAI_API_KEY`
4. Deploy, then open the HTTPS Pages URL on iPhone/iPad Safari.
5. Use Safari share menu, then `Add to Home Screen`, to install it as a PWA.

## Notes

- `Transcript` mode is English-only through `audio.input.transcription.language: "en"`.
- `Translate` mode uses `gpt-realtime-translate` for Japanese and a parallel `gpt-realtime-whisper` session for the English source text.
- Transcripts are kept only in the browser session. They are not stored server-side.
- The initial transcription delay is `low`. If you want faster partials, try `minimal`; if you want steadier accuracy, try `medium`, `high`, or `xhigh` in `functions/api/session.ts`.
