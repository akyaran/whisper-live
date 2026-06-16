import "./styles.css";

type AppState = "idle" | "requesting-mic" | "connecting" | "recording" | "stopping" | "error";
type AppMode = "transcript" | "en-ja" | "ja-en";
type TranslationMode = Exclude<AppMode, "transcript">;

const APP_VERSION = "v0.8.1";
const AUTOSAVE_INTERVAL_MS = 60_000;
const TRANSCRIPT_WATCHDOG_INTERVAL_MS = 1_000;
const TRANSCRIPT_STALL_MS = 18_000;
const TRANSCRIPT_AUDIO_RECENT_MS = 4_000;
const TRANSCRIPT_RECONNECT_COOLDOWN_MS = 15_000;
const AUDIO_ACTIVITY_THRESHOLD = 0.012;
const DRAFT_DB_NAME = "whisper-live-drafts";
const DRAFT_STORE_NAME = "drafts";
const HISTORY_STORE_NAME = "history";
const DRAFT_ID = "current";
const DRAFT_STORAGE_KEY = "whisper-live-current-draft";
const HISTORY_STORAGE_KEY = "whisper-live-history";

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
      transcript?: string;
      text?: string;
    }
  | {
      type: "session.output_transcript.delta";
      delta?: string;
      transcript?: string;
      text?: string;
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
  sourcePc?: RTCPeerConnection;
  sourceDc?: RTCDataChannel;
}

interface AudioMonitor {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array;
  timer: number;
}

interface SavedTranscriptDraft {
  id: typeof DRAFT_ID;
  mode: AppMode;
  savedAt: number;
  finalLines: FinalLine[];
  liveText: string;
  sourceText: string;
  translatedText: string;
}

interface SavedTranscriptHistory {
  id: string;
  mode: AppMode;
  savedAt: number;
  text: string;
}

interface WakeLockSentinel extends EventTarget {
  released: boolean;
  release(): Promise<void>;
}

interface WakeLock {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: WakeLock;
};

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
    badge: "OpenAI Realtime Translate"
  },
  "en-ja": {
    title: "English to Japanese live translation",
    helper: "Tap start, speak English, and watch Japanese translation appear.",
    badge: "OpenAI Realtime Translate"
  },
  "ja-en": {
    title: "Japanese to English live translation",
    helper: "Tap start, speak Japanese, and watch English translation appear.",
    badge: "OpenAI Realtime Translate"
  }
};

const translationCopy: Record<TranslationMode, { sourceLabel: string; targetLabel: string; sourceEmpty: string; targetEmpty: string }> = {
  "en-ja": {
    sourceLabel: "English",
    targetLabel: "Japanese",
    sourceEmpty: "English source will appear here.",
    targetEmpty: "Japanese translation will appear here."
  },
  "ja-en": {
    sourceLabel: "Japanese",
    targetLabel: "English",
    sourceEmpty: "Japanese source will appear here.",
    targetEmpty: "English translation will appear here."
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
        <p id="modeBadge" class="eyebrow">OpenAI Realtime Translate</p>
        <div class="title-row">
          <h1>Whisper Live</h1>
          <span id="versionBadge" class="version-badge">v0.7.3</span>
        </div>
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
          <input type="radio" name="mode" value="en-ja" />
          <span>EN to JA</span>
        </label>
        <label>
          <input type="radio" name="mode" value="ja-en" />
          <span>JA to EN</span>
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
        <p id="sessionNote" class="session-note"></p>
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
          <button id="fullTextButton" type="button" aria-expanded="false">Full text</button>
          <button id="historyButton" type="button" aria-expanded="false">History</button>
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
          <p id="sourceLabel" class="eyebrow">English</p>
          <div id="sourceLine" class="translation-text is-empty" aria-live="polite">English source will appear here.</div>
        </article>
        <article class="translation-column">
          <p id="translationLabel" class="eyebrow">Japanese</p>
          <div id="translationLine" class="translation-text is-empty" aria-live="polite">Japanese translation will appear here.</div>
        </article>
      </div>

      <section id="fullTextPanel" class="full-text-panel" aria-label="Full transcript" hidden>
        <div class="full-text-header">
          <p class="eyebrow">Full text</p>
          <button id="closeFullTextButton" type="button">Close</button>
        </div>
        <pre id="fullTextContent"></pre>
      </section>

      <section id="historyPanel" class="history-panel" aria-label="Transcript history" hidden>
        <div class="history-header">
          <div>
            <p class="eyebrow">History</p>
            <h2>Saved transcripts</h2>
          </div>
          <div class="history-header-actions">
            <button id="clearHistoryButton" type="button">Delete all</button>
            <button id="closeHistoryButton" type="button">Close</button>
          </div>
        </div>
        <div id="historyList" class="history-list"></div>
      </section>
    </section>
  </main>
`;

const modeBadge = getElement<HTMLParagraphElement>("modeBadge");
const versionBadge = getElement<HTMLSpanElement>("versionBadge");
const recorderTitle = getElement<HTMLHeadingElement>("recorderTitle");
const recordButton = getElement<HTMLButtonElement>("recordButton");
const recordButtonText = getElement<HTMLSpanElement>("recordButtonText");
const statusBadge = getElement<HTMLSpanElement>("statusBadge");
const helperText = getElement<HTMLParagraphElement>("helperText");
const sessionNote = getElement<HTMLParagraphElement>("sessionNote");
const liveLine = getElement<HTMLDivElement>("liveLine");
const finalList = getElement<HTMLOListElement>("finalList");
const emptyState = getElement<HTMLParagraphElement>("emptyState");
const copyButton = getElement<HTMLButtonElement>("copyButton");
const downloadButton = getElement<HTMLButtonElement>("downloadButton");
const fullTextButton = getElement<HTMLButtonElement>("fullTextButton");
const historyButton = getElement<HTMLButtonElement>("historyButton");
const closeFullTextButton = getElement<HTMLButtonElement>("closeFullTextButton");
const closeHistoryButton = getElement<HTMLButtonElement>("closeHistoryButton");
const clearHistoryButton = getElement<HTMLButtonElement>("clearHistoryButton");
const clearButton = getElement<HTMLButtonElement>("clearButton");
const transcriptView = getElement<HTMLDivElement>("transcriptView");
const translationView = getElement<HTMLDivElement>("translationView");
const sourceLabel = getElement<HTMLParagraphElement>("sourceLabel");
const translationLabel = getElement<HTMLParagraphElement>("translationLabel");
const sourceLine = getElement<HTMLDivElement>("sourceLine");
const translationLine = getElement<HTMLDivElement>("translationLine");
const fullTextPanel = getElement<HTMLElement>("fullTextPanel");
const fullTextContent = getElement<HTMLPreElement>("fullTextContent");
const historyPanel = getElement<HTMLElement>("historyPanel");
const historyList = getElement<HTMLDivElement>("historyList");
const modeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];

let state: AppState = "idle";
let appMode: AppMode = "transcript";
let fullTextOpen = false;
let historyOpen = false;
let session: SessionResources | null = null;
let finalLines = new Map<string, FinalLine>();
let liveDeltas = new Map<string, string>();
let sourceText = "";
let translatedText = "";
let sourceTextEventSource: "input" | "output" | null = null;
let transcriptTextEventSource: "input" | "output" | null = null;
let stopTimer: number | undefined;
let autosaveTimer: number | undefined;
let transcriptWatchdogTimer: number | undefined;
let wakeLock: WakeLockSentinel | null = null;
let wakeLockActive = false;
let lastSavedAt = 0;
let activeHistorySaved = false;
let historyItems: SavedTranscriptHistory[] = [];
let audioMonitor: AudioMonitor | null = null;
let lastAudioActivityAt = 0;
let lastTranscriptEventAt = 0;
let lastTranscriptReconnectAt = 0;
let reconnectingTranscript = false;

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

    setMode(input.value === "en-ja" || input.value === "ja-en" ? input.value : "transcript");
  });
}

copyButton.addEventListener("click", () => {
  void copyTranscript();
});

downloadButton.addEventListener("click", downloadTranscript);

clearButton.addEventListener("click", () => {
  clearTranscript();
});

fullTextButton.addEventListener("click", () => {
  setFullTextOpen(!fullTextOpen);
});

historyButton.addEventListener("click", () => {
  setHistoryOpen(!historyOpen);
});

closeFullTextButton.addEventListener("click", () => {
  setFullTextOpen(false);
});

closeHistoryButton.addEventListener("click", () => {
  setHistoryOpen(false);
});

clearHistoryButton.addEventListener("click", () => {
  void clearTranscriptHistory();
});

window.addEventListener("beforeunload", () => {
  void saveTranscriptDraft();
  closeSession();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state === "recording") {
    void requestWakeLock();
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The app still works online if service worker registration is unavailable.
    });
  });
}

versionBadge.textContent = APP_VERSION;
setMode("transcript", { clear: false });
void restoreTranscriptDraft();
void loadTranscriptHistory();

async function startRecording() {
  setState("requesting-mic");
  setHelper("Allow microphone access when Safari asks.");
  activeHistorySaved = false;

  try {
    closeSession();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    setupAudioMonitor(stream);

    setState("connecting");
    setHelper("Opening a secure realtime session.");

    const { pc, dc } = createPeerConnection(stream);

    attachPrimaryRealtimeListeners(pc, dc, () => {
      setState("recording");
      setHelper(
        isTranslationMode(appMode)
          ? "Speak naturally. Source and translation text will stream below."
          : "Speak naturally. Tap stop to finalize the current transcript."
      );
      lastTranscriptEventAt = Date.now();
      lastTranscriptReconnectAt = 0;
      startAutosaveTimer();
      startTranscriptWatchdog();
      void requestWakeLock();
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdp = offer.sdp;
    if (!sdp) {
      throw new Error("Browser did not create an SDP offer.");
    }

    const answerSdp = await createTranslationAnswer(sdp, getPrimaryTranslationLanguage(appMode));

    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });

    session = { mode: appMode, pc, dc, stream };
    if (isTranslationMode(appMode)) {
      const sourceSession = await createParallelSourceTranslationSession(stream, getSourceLanguage(appMode));
      session.sourcePc = sourceSession.pc;
      session.sourceDc = sourceSession.dc;
    }
  } catch (error) {
    closeSession();
    showError(error instanceof Error ? error.message : "Could not start recording.");
  }
}

function attachPrimaryRealtimeListeners(pc: RTCPeerConnection, dc: RTCDataChannel, onOpen?: () => void) {
  dc.addEventListener("open", () => {
    onOpen?.();
  });

  dc.addEventListener("message", (event) => {
    handleRealtimeEvent(event.data);
  });

  dc.addEventListener("error", () => {
    showError("Realtime data channel reported an error.");
  });

  dc.addEventListener("close", () => {
    handleDataChannelClose("Realtime");
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      handleConnectionInterruption("Realtime");
    }
  });
}

function createPeerConnection(stream: MediaStream) {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("oai-events");

  for (const track of stream.getAudioTracks()) {
    pc.addTrack(track, stream);
  }

  return { pc, dc };
}

async function createTranslationAnswer(sdp: string, targetLanguage: "en" | "ja") {
  const sessionResponse = await fetch("/api/session?mode=translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ targetLanguage })
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

async function createParallelSourceTranslationSession(stream: MediaStream, language: "en" | "ja") {
  const { pc, dc } = createPeerConnection(stream);

  dc.addEventListener("message", (event) => {
    handleRealtimeEvent(event.data, "source");
  });

  dc.addEventListener("error", () => {
    showError("Source translation data channel reported an error.");
  });

  dc.addEventListener("close", () => {
    handleDataChannelClose("Source translation");
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      showError("Source translation connection was interrupted.");
    }
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  if (!offer.sdp) {
    throw new Error("Browser did not create a source translation SDP offer.");
  }

  const answerSdp = await createTranslationAnswer(offer.sdp, language);
  await pc.setRemoteDescription({
    type: "answer",
    sdp: answerSdp
  });

  return { pc, dc };
}

async function stopRecording() {
  if (!session) {
    setState("idle");
    return;
  }

  setState("stopping");
  setHelper("Finalizing the last words.");
  stopAutosaveTimer();
  stopTranscriptWatchdog();
  void saveTranscriptDraft();
  void releaseWakeLock();

  closeTranslationDataChannel(session.dc);
  closeTranslationDataChannel(session.sourceDc);

  for (const track of session.stream.getAudioTracks()) {
    track.stop();
  }

  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    void saveTranscriptDraft();
    void saveCurrentTranscriptToHistory();
    closeSession();
    setState("idle");
    setHelper("Ready for another take.");
  }, 1600);
}

function handleRealtimeEvent(payload: string, channel: "primary" | "source" = "primary") {
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
    lastTranscriptEventAt = Date.now();
    const key = lineKey(event.item_id, event.content_index);
    const delta = event.delta ?? "";

    if (isTranslationMode(appMode)) {
      if (channel === "source") {
        sourceText += delta;
        renderTranscript();
      }

      return;
    }

    liveDeltas.set(key, `${liveDeltas.get(key) ?? ""}${delta}`);
    renderTranscript();
    return;
  }

  if (isTranscriptCompletedEvent(event)) {
    lastTranscriptEventAt = Date.now();
    const key = lineKey(event.item_id, event.content_index);
    const transcript = (event.transcript ?? liveDeltas.get(key) ?? "").trim();

    if (isTranslationMode(appMode)) {
      return;
    }

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
    lastTranscriptEventAt = Date.now();
    const text = getRealtimeText(event);

    if (appMode === "transcript") {
      appendTranscriptText(text, "input");
      renderTranscript();
      return;
    }

    if (channel === "source" && isTranslationMode(appMode)) {
      appendSourceText(text, "input");
      renderTranscript();
    }

    return;
  }

  if (isTranslationOutputDeltaEvent(event)) {
    lastTranscriptEventAt = Date.now();
    const text = getRealtimeText(event);

    if (appMode === "transcript") {
      appendTranscriptText(text, "output");
      renderTranscript();
      return;
    }

    if (channel === "source") {
      appendSourceText(text, "output");
      renderTranscript();
      return;
    }

    if (!isTranslationMode(appMode)) {
      return;
    }

    translatedText += text;
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
  return event.type.includes("input_transcript") && event.type.includes("delta");
}

function isTranslationOutputDeltaEvent(
  event: RealtimeEvent
): event is Extract<RealtimeEvent, { type: "session.output_transcript.delta" }> {
  return event.type.includes("output_transcript") && event.type.includes("delta");
}

function getRealtimeText(event: RealtimeEvent) {
  const candidate = event as { delta?: string; transcript?: string; text?: string };
  return candidate.delta ?? candidate.transcript ?? candidate.text ?? "";
}

function appendTranscriptText(text: string, eventSource: "input" | "output") {
  if (!text) {
    return;
  }

  const key = "translate-transcript";

  if (transcriptTextEventSource && transcriptTextEventSource !== eventSource) {
    if (transcriptTextEventSource === "input") {
      return;
    }

    liveDeltas.delete(key);
  }

  transcriptTextEventSource = eventSource;
  liveDeltas.set(key, `${liveDeltas.get(key) ?? ""}${text}`);
}

function appendSourceText(text: string, eventSource: "input" | "output") {
  if (!text) {
    return;
  }

  if (sourceTextEventSource && sourceTextEventSource !== eventSource) {
    if (sourceTextEventSource === "input") {
      return;
    }

    sourceText = "";
  }

  sourceTextEventSource = eventSource;
  sourceText += text;
}

function closeTranslationDataChannel(dc: RTCDataChannel | undefined) {
  if (dc?.readyState !== "open") {
    return;
  }

  dc.send(
    JSON.stringify({
      type: "session.close"
    })
  );
}

function renderTranscript() {
  if (isTranslationMode(appMode)) {
    const copy = translationCopy[appMode];
    const source = sourceText.trim();
    const translation = translatedText.trim();
    sourceLine.textContent = source || copy.sourceEmpty;
    translationLine.textContent = translation || copy.targetEmpty;
    sourceLine.classList.toggle("is-empty", !source);
    translationLine.classList.toggle("is-empty", !translation);
    scrollToLatest(sourceLine);
    scrollToLatest(translationLine);
    renderFullText();
    return;
  }

  const liveText = [...liveDeltas.values()].join(" ").trim();
  liveLine.textContent = liveText || "Live words will appear here.";
  liveLine.classList.toggle("is-empty", !liveText);
  scrollToLatest(liveLine);

  const lines = [...finalLines.values()].sort((a, b) => a.completedAt - b.completedAt);
  finalList.replaceChildren(
    ...lines.slice(-5).map((line) => {
      const item = document.createElement("li");
      item.textContent = line.text;
      item.dataset.itemId = line.itemId;
      return item;
    })
  );

  emptyState.hidden = lines.length > 0;
  renderFullText();
}

function setMode(nextMode: AppMode, options: { clear: boolean } = { clear: true }) {
  appMode = nextMode;
  modeBadge.textContent = modeCopy[nextMode].badge;
  recorderTitle.textContent = modeCopy[nextMode].title;
  transcriptView.hidden = isTranslationMode(nextMode);
  translationView.hidden = nextMode === "transcript";

  if (isTranslationMode(nextMode)) {
    const copy = translationCopy[nextMode];
    sourceLabel.textContent = copy.sourceLabel;
    translationLabel.textContent = copy.targetLabel;
  }

  for (const input of modeInputs) {
    input.checked = input.value === nextMode;
  }

  if (options.clear) {
    clearTranscript();
  } else {
    renderTranscript();
  }

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

  updateSessionNote();
}

function setHelper(message: string) {
  helperText.textContent = message;
}

function showError(message: string) {
  setState("error");
  setHelper(message);
  stopAutosaveTimer();
  stopTranscriptWatchdog();
  void saveTranscriptDraft();
  void releaseWakeLock();
}

function handleDataChannelClose(label: string) {
  if (reconnectingTranscript) {
    return;
  }

  if (state === "recording" || state === "connecting" || state === "requesting-mic") {
    if (session?.mode === "transcript" && state === "recording") {
      void reconnectTranscriptSession(`${label} channel closed`);
      return;
    }

    showError(`${label} connection closed unexpectedly.`);
  }
}

function handleConnectionInterruption(label: string) {
  if (session?.mode === "transcript" && state === "recording") {
    void reconnectTranscriptSession(`${label} connection interrupted`);
    return;
  }

  showError(`${label} connection was interrupted.`);
}

function closeSession() {
  window.clearTimeout(stopTimer);
  stopAutosaveTimer();
  stopTranscriptWatchdog();
  stopAudioMonitor();
  void releaseWakeLock();

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

  if (session.sourceDc && session.sourceDc.readyState !== "closed") {
    session.sourceDc.close();
  }

  session.sourcePc?.close();
  session = null;
}

function clearTranscript() {
  finalLines = new Map();
  liveDeltas = new Map();
  sourceText = "";
  translatedText = "";
  sourceTextEventSource = null;
  transcriptTextEventSource = null;
  lastSavedAt = 0;
  renderTranscript();
  void clearTranscriptDraft();
}

function startAutosaveTimer() {
  stopAutosaveTimer();
  void saveTranscriptDraft();
  autosaveTimer = window.setInterval(() => {
    void saveTranscriptDraft();
  }, AUTOSAVE_INTERVAL_MS);
}

function stopAutosaveTimer() {
  window.clearInterval(autosaveTimer);
  autosaveTimer = undefined;
}

function startTranscriptWatchdog() {
  stopTranscriptWatchdog();

  if (isTranslationMode(appMode)) {
    return;
  }

  transcriptWatchdogTimer = window.setInterval(() => {
    checkTranscriptHealth();
  }, TRANSCRIPT_WATCHDOG_INTERVAL_MS);
}

function stopTranscriptWatchdog() {
  window.clearInterval(transcriptWatchdogTimer);
  transcriptWatchdogTimer = undefined;
}

function setupAudioMonitor(stream: MediaStream) {
  stopAudioMonitor();

  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    const data = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;

      for (const sample of data) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }

      const rms = Math.sqrt(sumSquares / data.length);
      if (rms > AUDIO_ACTIVITY_THRESHOLD) {
        lastAudioActivityAt = Date.now();
      }
    }, 250);

    audioMonitor = { context, source, analyser, data, timer };
  } catch {
    audioMonitor = null;
    lastAudioActivityAt = 0;
  }
}

function stopAudioMonitor() {
  if (!audioMonitor) {
    return;
  }

  window.clearInterval(audioMonitor.timer);
  audioMonitor.source.disconnect();
  void audioMonitor.context.close();
  audioMonitor = null;
  lastAudioActivityAt = 0;
}

function checkTranscriptHealth() {
  if (!session || session.mode !== "transcript" || state !== "recording" || reconnectingTranscript) {
    return;
  }

  const now = Date.now();
  const audioIsActive = lastAudioActivityAt > 0 && now - lastAudioActivityAt <= TRANSCRIPT_AUDIO_RECENT_MS;
  const transcriptIsStale = lastTranscriptEventAt > 0 && now - lastTranscriptEventAt >= TRANSCRIPT_STALL_MS;
  const reconnectIsAllowed = now - lastTranscriptReconnectAt >= TRANSCRIPT_RECONNECT_COOLDOWN_MS;

  if (audioIsActive && transcriptIsStale && reconnectIsAllowed) {
    void reconnectTranscriptSession("transcript stalled after audio resumed");
  }
}

async function reconnectTranscriptSession(reason: string) {
  if (!session || session.mode !== "transcript" || state !== "recording" || reconnectingTranscript) {
    return;
  }

  const now = Date.now();
  if (now - lastTranscriptReconnectAt < TRANSCRIPT_RECONNECT_COOLDOWN_MS) {
    return;
  }

  reconnectingTranscript = true;
  lastTranscriptReconnectAt = now;
  lastTranscriptEventAt = now;
  setHelper(`Reconnecting transcript: ${reason}.`);
  updateSessionNote();

  try {
    const currentSession = session;
    closePrimaryConnection(currentSession);

    const { pc, dc } = createPeerConnection(currentSession.stream);
    attachPrimaryRealtimeListeners(pc, dc, () => {
      setHelper("Transcript reconnected. Keep speaking.");
      lastTranscriptEventAt = Date.now();
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (!offer.sdp) {
      throw new Error("Browser did not create a reconnect SDP offer.");
    }

    const answerSdp = await createTranslationAnswer(offer.sdp, "en");
    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });

    currentSession.pc = pc;
    currentSession.dc = dc;
  } catch (error) {
    showError(error instanceof Error ? error.message : "Transcript reconnect failed.");
  } finally {
    reconnectingTranscript = false;
    updateSessionNote();
  }
}

function closePrimaryConnection(resources: SessionResources) {
  if (resources.dc.readyState !== "closed") {
    resources.dc.close();
  }

  resources.pc.close();
}

async function saveTranscriptDraft() {
  const draft = createTranscriptDraft();

  if (!hasDraftContent(draft)) {
    updateSessionNote();
    return;
  }

  try {
    await writeDraft(draft);
    lastSavedAt = draft.savedAt;
  } catch {
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      lastSavedAt = draft.savedAt;
    } catch {
      // Autosave is best-effort; recording should continue even if storage is unavailable.
    }
  }

  updateSessionNote();
}

async function restoreTranscriptDraft() {
  const draft = await readDraft();

  if (!draft || !isAppMode(draft.mode) || !hasDraftContent(draft)) {
    updateSessionNote();
    return;
  }

  setMode(draft.mode, { clear: false });
  finalLines = new Map(draft.finalLines.map((line) => [line.itemId, line]));
  liveDeltas = new Map();

  if (draft.liveText) {
    liveDeltas.set(lineKey("restored-live", 0), draft.liveText);
  }

  sourceText = draft.sourceText;
  translatedText = draft.translatedText;
  sourceTextEventSource = null;
  transcriptTextEventSource = draft.liveText ? "output" : null;
  lastSavedAt = draft.savedAt;
  renderTranscript();
  setHelper("Restored your saved transcript from this device.");
  updateSessionNote();
}

async function clearTranscriptDraft() {
  try {
    await deleteDraft();
  } catch {
    // Local storage fallback is still cleared below.
  }

  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // Some private browsing modes can block localStorage.
  }

  updateSessionNote();
}

async function saveCurrentTranscriptToHistory() {
  if (activeHistorySaved) {
    return;
  }

  const text = getTranscriptText();
  if (!text) {
    return;
  }

  const item: SavedTranscriptHistory = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode: appMode,
    savedAt: Date.now(),
    text
  };

  try {
    await writeHistoryItem(item);
  } catch {
    const fallback = await readHistoryFallback();
    writeHistoryFallback([item, ...fallback]);
  }

  activeHistorySaved = true;
  historyItems = [item, ...historyItems].sort((a, b) => b.savedAt - a.savedAt);
  renderHistory();
  setHelper("Saved this transcript to history.");
}

async function loadTranscriptHistory() {
  historyItems = (await readHistory()).sort((a, b) => b.savedAt - a.savedAt);
  renderHistory();
}

async function clearTranscriptHistory() {
  if (historyItems.length === 0) {
    setHelper("History is already empty.");
    return;
  }

  try {
    await deleteAllHistoryItems();
  } catch {
    writeHistoryFallback([]);
  }

  historyItems = [];
  renderHistory();
  setHelper("History deleted.");
}

async function deleteHistoryItem(id: string) {
  try {
    await deleteStoredHistoryItem(id);
  } catch {
    writeHistoryFallback(historyItems.filter((item) => item.id !== id));
  }

  historyItems = historyItems.filter((item) => item.id !== id);
  renderHistory();
  setHelper("History item deleted.");
}

function renderHistory() {
  historyButton.setAttribute("aria-expanded", String(historyOpen));
  historyButton.textContent = historyOpen ? "Hide history" : `History${historyItems.length ? ` (${historyItems.length})` : ""}`;
  clearHistoryButton.disabled = historyItems.length === 0;

  if (historyItems.length === 0) {
    historyList.replaceChildren(createHistoryEmptyState());
    return;
  }

  historyList.replaceChildren(...historyItems.map(createHistoryItemElement));
}

function createHistoryEmptyState() {
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = "No saved history yet.";
  return empty;
}

function createHistoryItemElement(item: SavedTranscriptHistory) {
  const row = document.createElement("article");
  row.className = "history-item";

  const meta = document.createElement("div");
  meta.className = "history-meta";

  const title = document.createElement("strong");
  title.textContent = `${getModeLabel(item.mode)} - ${formatHistoryDate(item.savedAt)}`;

  const preview = document.createElement("p");
  preview.textContent = item.text.replace(/\s+/g, " ").trim().slice(0, 180) || "(empty)";

  meta.appendChild(title);
  meta.appendChild(preview);

  const actions = document.createElement("div");
  actions.className = "history-item-actions";

  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download";
  download.addEventListener("click", () => {
    downloadText(item.text, createDownloadName(item.mode, item.savedAt));
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    void deleteHistoryItem(item.id);
  });

  actions.appendChild(download);
  actions.appendChild(remove);
  row.appendChild(meta);
  row.appendChild(actions);
  return row;
}

function setHistoryOpen(open: boolean) {
  historyOpen = open;
  historyPanel.hidden = !open;
  renderHistory();
}

function createTranscriptDraft(): SavedTranscriptDraft {
  return {
    id: DRAFT_ID,
    mode: appMode,
    savedAt: Date.now(),
    finalLines: [...finalLines.values()].sort((a, b) => a.completedAt - b.completedAt),
    liveText: getLiveText(),
    sourceText,
    translatedText
  };
}

function hasDraftContent(draft: SavedTranscriptDraft) {
  return Boolean(draft.finalLines.length || draft.liveText.trim() || draft.sourceText.trim() || draft.translatedText.trim());
}

function getLiveText() {
  return [...liveDeltas.values()].join(" ").trim();
}

function updateSessionNote() {
  const messages: string[] = [];

  if (wakeLockActive) {
    messages.push("Screen awake while recording");
  } else if (state === "recording") {
    messages.push("Keep this screen open while recording");
  }

  if (reconnectingTranscript) {
    messages.push("Reconnecting transcript");
  }

  if (session?.sourceDc && isTranslationMode(session.mode)) {
    messages.push("Source translate active");
  }

  if (lastSavedAt > 0) {
    messages.push(`Autosaved ${formatSavedTime(lastSavedAt)}`);
  }

  sessionNote.textContent = messages.join(" - ");
}

function formatSavedTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

async function requestWakeLock() {
  const wakeLockApi = (navigator as NavigatorWithWakeLock).wakeLock;

  if (!wakeLockApi || wakeLock) {
    updateSessionNote();
    return;
  }

  try {
    wakeLock = await wakeLockApi.request("screen");
    wakeLockActive = true;
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      wakeLockActive = false;
      updateSessionNote();
    });
  } catch {
    wakeLock = null;
    wakeLockActive = false;
  }

  updateSessionNote();
}

async function releaseWakeLock() {
  const currentWakeLock = wakeLock;
  wakeLock = null;
  wakeLockActive = false;

  try {
    await currentWakeLock?.release();
  } catch {
    // Wake locks can already be released by the browser.
  }

  updateSessionNote();
}

async function writeDraft(draft: SavedTranscriptDraft) {
  const db = await openDraftDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
    transaction.objectStore(DRAFT_STORE_NAME).put(draft);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  db.close();
}

async function readDraft() {
  try {
    const db = await openDraftDatabase();
    const draft = await new Promise<SavedTranscriptDraft | undefined>((resolve, reject) => {
      const transaction = db.transaction(DRAFT_STORE_NAME, "readonly");
      const request = transaction.objectStore(DRAFT_STORE_NAME).get(DRAFT_ID);
      request.onsuccess = () => resolve(request.result as SavedTranscriptDraft | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();

    if (draft) {
      return draft;
    }
  } catch {
    // Fall through to localStorage fallback.
  }

  try {
    const fallback = localStorage.getItem(DRAFT_STORAGE_KEY);
    return fallback ? (JSON.parse(fallback) as SavedTranscriptDraft) : undefined;
  } catch {
    return undefined;
  }
}

async function deleteDraft() {
  const db = await openDraftDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DRAFT_STORE_NAME, "readwrite");
    transaction.objectStore(DRAFT_STORE_NAME).delete(DRAFT_ID);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  db.close();
}

async function writeHistoryItem(item: SavedTranscriptHistory) {
  const db = await openDraftDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, "readwrite");
    transaction.objectStore(HISTORY_STORE_NAME).put(item);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  db.close();
}

async function readHistory() {
  try {
    const db = await openDraftDatabase();
    const items = await new Promise<SavedTranscriptHistory[]>((resolve, reject) => {
      const transaction = db.transaction(HISTORY_STORE_NAME, "readonly");
      const request = transaction.objectStore(HISTORY_STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result as SavedTranscriptHistory[]).filter(isHistoryItem));
      request.onerror = () => reject(request.error);
    });
    db.close();

    if (items.length > 0) {
      return items;
    }
  } catch {
    // Fall through to localStorage fallback.
  }

  return readHistoryFallback();
}

async function deleteStoredHistoryItem(id: string) {
  const db = await openDraftDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, "readwrite");
    transaction.objectStore(HISTORY_STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  db.close();
}

async function deleteAllHistoryItems() {
  const db = await openDraftDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE_NAME, "readwrite");
    transaction.objectStore(HISTORY_STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  db.close();
  writeHistoryFallback([]);
}

async function readHistoryFallback() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(isHistoryItem) : [];
  } catch {
    return [];
  }
}

function writeHistoryFallback(items: SavedTranscriptHistory[]) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // History persistence is best-effort when storage is blocked.
  }
}

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }

    const request = indexedDB.open(DRAFT_DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        db.createObjectStore(DRAFT_STORE_NAME, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function setFullTextOpen(open: boolean) {
  fullTextOpen = open;
  fullTextPanel.hidden = !open;
  fullTextButton.setAttribute("aria-expanded", String(open));
  fullTextButton.textContent = open ? "Hide full" : "Full text";
  renderFullText();
}

function renderFullText() {
  const transcript = getTranscriptText();
  fullTextContent.textContent = transcript || "No transcript yet.";
}

function scrollToLatest(element: HTMLElement) {
  requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
  });
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

  downloadText(transcript, createDownloadName(appMode, Date.now()));
}

function downloadText(text: string, fileName: string) {
  const blob = new Blob([text, "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function getTranscriptText() {
  if (isTranslationMode(appMode)) {
    const copy = translationCopy[appMode];
    const source = sourceText.trim();
    const translation = translatedText.trim();

    if (!source && !translation) {
      return "";
    }

    return [`${copy.sourceLabel}:\n${source || "(empty)"}`, `${copy.targetLabel}:\n${translation || "(empty)"}`].join(
      "\n\n"
    );
  }

  const finalText = [...finalLines.values()]
    .sort((a, b) => a.completedAt - b.completedAt)
    .map((line) => line.text)
    .join("\n")
    .trim();
  const liveText = getLiveText();

  return [finalText, liveText].filter(Boolean).join("\n").trim();
}

function createDownloadName(mode: AppMode, timestamp: number) {
  const suffix = isTranslationMode(mode) ? mode : "transcript";
  return `whisper-live-${suffix}-${new Date(timestamp).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
}

function getModeLabel(mode: AppMode) {
  if (mode === "en-ja") {
    return "EN to JA";
  }

  if (mode === "ja-en") {
    return "JA to EN";
  }

  return "Transcript";
}

function formatHistoryDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function isHistoryItem(item: unknown): item is SavedTranscriptHistory {
  if (!item || typeof item !== "object") {
    return false;
  }

  const candidate = item as Partial<SavedTranscriptHistory>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.savedAt === "number" &&
    typeof candidate.text === "string" &&
    typeof candidate.mode === "string" &&
    isAppMode(candidate.mode)
  );
}

function isTranslationMode(mode: AppMode): mode is TranslationMode {
  return mode === "en-ja" || mode === "ja-en";
}

function isAppMode(mode: string): mode is AppMode {
  return mode === "transcript" || mode === "en-ja" || mode === "ja-en";
}

function getSourceLanguage(mode: TranslationMode) {
  return mode === "en-ja" ? "en" : "ja";
}

function getTargetLanguage(mode: TranslationMode) {
  return mode === "en-ja" ? "ja" : "en";
}

function getPrimaryTranslationLanguage(mode: AppMode) {
  return isTranslationMode(mode) ? getTargetLanguage(mode) : "en";
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
