import "./styles.css";

type AppState = "idle" | "requesting-mic" | "connecting" | "recording" | "stopping" | "error";
type AppMode = "transcript" | "translate";

type RealtimeEvent =
  | {
      type: "conversation.item.input_audio_transcription.delta";
      item_id?: string;
      content_index?: number;
      delta?: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      item_id?: string;
      content_index?: number;
      transcript?: string;
    }
  | {
      type: "session.input_transcript.delta";
      delta?: string;
    }
  | {
      type: "session.output_transcript.delta";
      delta?: string;
    }
  | {
      type: "error";
      error?: {
        message?: string;
      };
    }
  | {
      type: string;
    };

interface FinalLine {
  itemId: string;
  text: string;
  completedAt: number;
}

interface TranslationSecretResponse {
  endpoint: string;
  clientSecret:
    | string
    | {
        value?: string;
      };
}

interface SessionResources {
  mode: AppMode;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  stream: MediaStream;
}

const statusCopy: Record<AppState, string> = {
  idle: "Ready",
  "requesting-mic": "Waiting for microphone",
  connecting: "Connecting",
  recording: "Recording",
  stopping: "Finalizing",
  error: "Needs attention"
};

const modeCopy: Record<AppMode, { title: string; helper: string; badge: string }> = {
  transcript: {
    title: "English realtime transcript",
    helper: "Tap start, allow the microphone, and speak English.",
    badge: "OpenAI Realtime Whisper"
  },
  translate: {
    title: "English to Japanese live translation",
    helper: "Tap start, speak English, and watch Japanese translation appear.",
    badge: "OpenAI Realtime Translate"
  }
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p id="modeBadge" class="eyebrow">OpenAI Realtime Whisper</p>
        <h1>Whisper Live</h1>
      </div>
      <span id="statusBadge" class="status-badge" data-state="idle">Ready</span>
    </header>

    <section class="mode-panel" aria-labelledby="modeTitle">
      <div>
        <p class="eyebrow">Mode</p>
        <h2 id="modeTitle">Output</h2>
      </div>
      <div class="mode-toggle" role="radiogroup" aria-label="Output mode">
        <label>
          <input type="radio" name="mode" value="transcript" checked />
          <span>Transcript</span>
        </label>
        <label>
          <input type="radio" name="mode" value="translate" />
          <span>Translate</span>
        </label>
      </div>
    </section>

    <section class="recorder" aria-labelledby="recorderTitle">
      <div class="meter" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
      </div>
      <div>
        <h2 id="recorderTitle">English realtime transcript</h2>
        <p id="helperText">Tap start, allow the microphone, and speak English.</p>
      </div>
      <button id="recordButton" class="record-button" type="button">
        <span class="record-dot" aria-hidden="true"></span>
        <span id="recordButtonText">Start</span>
      </button>
    </section>

    <section class="transcript-panel" aria-labelledby="liveTitle">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Live</p>
          <h2 id="liveTitle">Transcript</h2>
        </div>
        <div class="actions">
          <button id="copyButton" type="button">Copy</button>
          <button id="downloadButton" type="button">Download</button>
          <button id="clearButton" type="button">Clear</button>
        </div>
      </div>

      <div id="transcriptView">
        <div id="liveLine" class="live-line is-empty" aria-live="polite">Live words will appear here.</div>
        <ol id="finalList" class="final-list" aria-label="Final transcript lines"></ol>
        <p id="emptyState" class="empty-state">No final transcript yet.</p>
      </div>

      <div id="translationView" class="translation-view" hidden>
        <article class="translation-column">
          <p class="eyebrow">English</p>
          <div id="sourceLine" class="translation-text is-empty" aria-live="polite">English source will appear here.</div>
        </article>
        <article class="translation-column">
          <p class="eyebrow">Japanese</p>
          <div id="translationLine" class="translation-text is-empty" aria-live="polite">日本語訳がここに表示されます。</div>
        </article>
      </div>
    </section>
  </main>
`;

const modeBadge = getElement<HTMLParagraphElement>("modeBadge");
const recorderTitle = getElement<HTMLHeadingElement>("recorderTitle");
const recordButton = getElement<HTMLButtonElement>("recordButton");
const recordButtonText = getElement<HTMLSpanElement>("recordButtonText");
const statusBadge = getElement<HTMLSpanElement>("statusBadge");
const helperText = getElement<HTMLParagraphElement>("helperText");
const liveLine = getElement<HTMLDivElement>("liveLine");
const finalList = getElement<HTMLOListElement>("finalList");
const emptyState = getElement<HTMLParagraphElement>("emptyState");
const copyButton = getElement<HTMLButtonElement>("copyButton");
const downloadButton = getElement<HTMLButtonElement>("downloadButton");
const clearButton = getElement<HTMLButtonElement>("clearButton");
const transcriptView = getElement<HTMLDivElement>("transcriptView");
const translationView = getElement<HTMLDivElement>("translationView");
const sourceLine = getElement<HTMLDivElement>("sourceLine");
const translationLine = getElement<HTMLDivElement>("translationLine");
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];

let state: AppState = "idle";
let appMode: AppMode = "transcript";
let session: SessionResources | null = null;
let finalLines = new Map<string, FinalLine>();
let liveDeltas = new Map<string, string>();
let sourceText = "";
let translatedText = "";
let stopTimer: number | undefined;

recordButton.addEventListener("click", () => {
  if (state === "recording") {
    void stopRecording();
    return;
  }

  if (state === "idle" || state === "error") {
    void startRecording();
  }
});

for (const input of modeInputs) {
  input.addEventListener("change", () => {
    if (!input.checked || state === "recording" || state === "connecting" || state === "requesting-mic") {
      return;
    }

    setMode(input.value === "translate" ? "translate" : "transcript");
  });
}

copyButton.addEventListener("click", () => {
  void copyTranscript();
});

downloadButton.addEventListener("click", downloadTranscript);

clearButton.addEventListener("click", () => {
  clearTranscript();
});

window.addEventListener("beforeunload", () => {
  closeSession();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app still works online if service worker registration is unavailable.
    });
  });
}

setMode("transcript");

async function startRecording() {
  setState("requesting-mic");
  setHelper("Allow microphone access when Safari asks.");

  try {
    closeSession();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    setState("connecting");
    setHelper("Opening a secure realtime session.");

    const pc = new RTCPeerConnection();
    const dc = pc.createDataChannel("oai-events");

    for (const track of stream.getAudioTracks()) {
      pc.addTrack(track, stream);
    }

    dc.addEventListener("open", () => {
      setState("recording");
      setHelper(
        appMode === "translate"
          ? "Speak naturally. English and Japanese text will stream below."
          : "Speak naturally. Tap stop to finalize the current transcript."
      );
    });

    dc.addEventListener("message", (event) => {
      handleRealtimeEvent(event.data);
    });

    dc.addEventListener("error", () => {
      showError("Realtime data channel reported an error.");
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        showError("Realtime connection was interrupted.");
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdp = offer.sdp;
    if (!sdp) {
      throw new Error("Browser did not create an SDP offer.");
    }

    const answerSdp =
      appMode === "translate" ? await createTranslationAnswer(sdp) : await createTranscriptAnswer(sdp);

    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });

    session = { mode: appMode, pc, dc, stream };
  } catch (error) {
    closeSession();
    showError(error instanceof Error ? error.message : "Could not start recording.");
  }
}

async function createTranscriptAnswer(sdp: string) {
  const response = await fetch("/api/session?mode=transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp"
    },
    body: sdp
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    throw new Error(readApiError(answerSdp));
  }

  return answerSdp;
}

async function createTranslationAnswer(sdp: string) {
  const sessionResponse = await fetch("/api/session?mode=translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ targetLanguage: "ja" })
  });

  const sessionBody = await sessionResponse.text();
  if (!sessionResponse.ok) {
    throw new Error(readApiError(sessionBody));
  }

  const translationSession = JSON.parse(sessionBody) as TranslationSecretResponse;
  const clientSecret =
    typeof translationSession.clientSecret === "string"
      ? translationSession.clientSecret
      : translationSession.clientSecret.value;

  if (!translationSession.endpoint || !clientSecret) {
    throw new Error("Translation session did not include a client secret.");
  }

  const sdpResponse = await fetch(translationSession.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: sdp
  });

  const answerSdp = await sdpResponse.text();
  if (!sdpResponse.ok) {
    throw new Error(answerSdp || "Translation call setup failed.");
  }

  return answerSdp;
}

async function stopRecording() {
  if (!session) {
    setState("idle");
    return;
  }

  setState("stopping");
  setHelper("Finalizing the last words.");

  for (const track of session.stream.getAudioTracks()) {
    track.stop();
  }

  if (session.dc.readyState === "open") {
    session.dc.send(
      JSON.stringify({
        type: session.mode === "translate" ? "session.close" : "input_audio_buffer.commit"
      })
    );
  }

  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    closeSession();
    setState("idle");
    setHelper("Ready for another take.");
  }, 1600);
}

function handleRealtimeEvent(payload: string) {
  let event: RealtimeEvent;

  try {
    event = JSON.parse(payload) as RealtimeEvent;
  } catch {
    return;
  }

  if (isErrorEvent(event)) {
    showError(event.error?.message ?? "Realtime API returned an error.");
    return;
  }

  if (isTranscriptDeltaEvent(event)) {
    const key = lineKey(event.item_id, event.content_index);
    liveDeltas.set(key, `${liveDeltas.get(key) ?? ""}${event.delta ?? ""}`);
    renderTranscript();
    return;
  }

  if (isTranscriptCompletedEvent(event)) {
    const key = lineKey(event.item_id, event.content_index);
    const transcript = (event.transcript ?? liveDeltas.get(key) ?? "").trim();

    if (transcript) {
      finalLines.set(key, {
        itemId: key,
        text: transcript,
        completedAt: Date.now()
      });
    }

    liveDeltas.delete(key);
    renderTranscript();
    return;
  }

  if (isTranslationInputDeltaEvent(event)) {
    sourceText += event.delta ?? "";
    renderTranscript();
    return;
  }

  if (isTranslationOutputDeltaEvent(event)) {
    translatedText += event.delta ?? "";
    renderTranscript();
  }
}

function isErrorEvent(event: RealtimeEvent): event is Extract<RealtimeEvent, { type: "error" }> {
  return event.type === "error";
}

function isTranscriptDeltaEvent(
  event: RealtimeEvent
): event is Extract<RealtimeEvent, { type: "conversation.item.input_audio_transcription.delta" }> {
  return event.type === "conversation.item.input_audio_transcription.delta";
}

function isTranscriptCompletedEvent(
  event: RealtimeEvent
): event is Extract<RealtimeEvent, { type: "conversation.item.input_audio_transcription.completed" }> {
  return event.type === "conversation.item.input_audio_transcription.completed";
}

function isTranslationInputDeltaEvent(
  event: RealtimeEvent
): event is Extract<RealtimeEvent, { type: "session.input_transcript.delta" }> {
  return event.type === "session.input_transcript.delta";
}

function isTranslationOutputDeltaEvent(
  event: RealtimeEvent
): event is Extract<RealtimeEvent, { type: "session.output_transcript.delta" }> {
  return event.type === "session.output_transcript.delta";
}

function renderTranscript() {
  if (appMode === "translate") {
    const source = sourceText.trim();
    const translation = translatedText.trim();
    sourceLine.textContent = source || "English source will appear here.";
    translationLine.textContent = translation || "日本語訳がここに表示されます。";
    sourceLine.classList.toggle("is-empty", !source);
    translationLine.classList.toggle("is-empty", !translation);
    return;
  }

  const liveText = [...liveDeltas.values()].join(" ").trim();
  liveLine.textContent = liveText || "Live words will appear here.";
  liveLine.classList.toggle("is-empty", !liveText);

  const lines = [...finalLines.values()].sort((a, b) => a.completedAt - b.completedAt);
  finalList.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line.text;
      item.dataset.itemId = line.itemId;
      return item;
    })
  );

  emptyState.hidden = lines.length > 0;
}

function setMode(nextMode: AppMode) {
  appMode = nextMode;
  modeBadge.textContent = modeCopy[nextMode].badge;
  recorderTitle.textContent = modeCopy[nextMode].title;
  transcriptView.hidden = nextMode === "translate";
  translationView.hidden = nextMode === "transcript";

  for (const input of modeInputs) {
    input.checked = input.value === nextMode;
  }

  clearTranscript();
  setHelper(modeCopy[nextMode].helper);
}

function setState(nextState: AppState) {
  state = nextState;
  statusBadge.textContent = statusCopy[nextState];
  statusBadge.dataset.state = nextState;
  recordButton.dataset.state = nextState;

  const isBusy = nextState === "requesting-mic" || nextState === "connecting" || nextState === "stopping";
  recordButton.disabled = isBusy;
  recordButtonText.textContent = nextState === "recording" ? "Stop" : "Start";

  for (const input of modeInputs) {
    input.disabled = nextState !== "idle" && nextState !== "error";
  }
}

function setHelper(message: string) {
  helperText.textContent = message;
}

function showError(message: string) {
  setState("error");
  setHelper(message);
}

function closeSession() {
  window.clearTimeout(stopTimer);

  if (!session) {
    return;
  }

  for (const track of session.stream.getTracks()) {
    track.stop();
  }

  if (session.dc.readyState !== "closed") {
    session.dc.close();
  }

  session.pc.close();
  session = null;
}

function clearTranscript() {
  finalLines = new Map();
  liveDeltas = new Map();
  sourceText = "";
  translatedText = "";
  renderTranscript();
}

async function copyTranscript() {
  const transcript = getTranscriptText();

  if (!transcript) {
    setHelper("Nothing to copy yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(transcript);
    setHelper("Transcript copied.");
  } catch {
    setHelper("Copy is unavailable in this browser.");
  }
}

function downloadTranscript() {
  const transcript = getTranscriptText();

  if (!transcript) {
    setHelper("Nothing to download yet.");
    return;
  }

  const blob = new Blob([transcript, "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const suffix = appMode === "translate" ? "translation" : "transcript";
  link.href = url;
  link.download = `whisper-live-${suffix}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function getTranscriptText() {
  if (appMode === "translate") {
    const source = sourceText.trim();
    const translation = translatedText.trim();

    if (!source && !translation) {
      return "";
    }

    return [`English:\n${source || "(empty)"}`, `Japanese:\n${translation || "(empty)"}`].join("\n\n");
  }

  return [...finalLines.values()]
    .sort((a, b) => a.completedAt - b.completedAt)
    .map((line) => line.text)
    .join("\n")
    .trim();
}

function readApiError(text: string) {
  try {
    const data = JSON.parse(text) as { error?: string; detail?: unknown };
    const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    return detail || data.error || "Session request failed.";
  } catch {
    return text || "Session request failed.";
  }
}

function lineKey(itemId: string | undefined, contentIndex: number | undefined) {
  return `${itemId ?? "unknown"}:${contentIndex ?? 0}`;
}

function getElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }

  return element as T;
}
