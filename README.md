# Whisper Live

Cloudflare Pages + Pages Functions + PWA for realtime transcription and translation with OpenAI `gpt-realtime-translate`.

## What It Does

- Runs as a mobile-first PWA on iPhone and iPad Safari.
- Uses WebRTC for low-latency microphone audio.
- Sends the OpenAI API key only from Cloudflare Pages Functions.
- Shows live transcript and translation text.
- Switches between English-only transcription, English-to-Japanese translation, and Japanese-to-English translation.
- Keeps the live view to the latest few lines while retaining a full transcript panel.
- Autosaves the current transcript on-device during recording.
- Keeps saved transcript history on-device with per-item download and delete controls.
- Requests screen wake lock while recording when the browser supports it.
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

- `Transcript` mode uses a `gpt-realtime-translate` session with English output, so Whisper is not used in the active browser flow.
- Translation modes use the primary `gpt-realtime-translate` session's input transcript for source text first.
- If primary input transcript events do not arrive, the app starts a source-language `gpt-realtime-translate` fallback session.
- Realtime events are scoped by session id and channel role so stale events from a previous mode cannot update the current view.
- Transcripts are kept only in the browser session. They are not stored server-side.
- Autosaved transcripts are stored only on the current device and are cleared by the `Clear` button.
- Transcript history is stored only on the current device and can be deleted item-by-item or all at once.
- Screen wake lock reduces accidental auto-lock during recording, but manual lock or browser backgrounding can still stop capture.
- Transcript mode watches microphone activity and reconnects the Realtime translation session if audio resumes but transcript events stop arriving.
- The initial transcription delay is `low`. If you want faster partials, try `minimal`; if you want steadier accuracy, try `medium`, `high`, or `xhigh` in `functions/api/session.ts`.
