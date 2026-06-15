import "./styles.css";

type AppState = "idle" | "requesting-mic" | "connecting" | "recording" | "stopping" | "error";

type TranscriptEvent =
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

interface SessionResources {
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

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">OpenAI Realtime Whisper</p>
        <h1>Whisper Live</h1>
      </div>
      <span id="statusBadge" class="status-badge" data-state="idle">Ready</span>
    </header>

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
      <div id="liveLine" class="live-line" aria-live="polite">Live words will appear here.</div>
      <ol id="finalList" class="final-list" aria-label="Final transcript lines"></ol>
      <p id="emptyState" class="empty-state">No final transcript yet.</p>
    </section>
  </main>
`;

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

let state: AppState = "idle";
let session: SessionResources | null = null;
let finalLines = new Map<string, FinalLine>();
let liveDeltas = new Map<string, string>();
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

copyButton.addEventListener("click", () => {
  void copyTranscript();
});

downloadButton.addEventListener("click", downloadTranscript);

clearButton.addEventListener("click", () => {
  finalLines = new Map();
  liveDeltas = new Map();
  renderTranscript();
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
      setHelper("Speak naturally. Tap stop to finalize the current transcript.");
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

    const response = await fetch("/api/session", {
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

    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp
    });

    session = { pc, dc, stream };
  } catch (error) {
    closeSession();
    showError(error instanceof Error ? error.message : "Could not start recording.");
  }
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
    session.dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    closeSession();
    setState("idle");
    setHelper("Ready for another take.");
  }, 1600);
}

function handleRealtimeEvent(payload: string) {
  let event: TranscriptEvent;

  try {
    event = JSON.parse(payload) as TranscriptEvent;
  } catch {
    return;
  }

  if (isErrorEvent(event)) {
    showError(event.error?.message ?? "Realtime API returned an error.");
    return;
  }

  if (isDeltaEvent(event)) {
    const key = lineKey(event.item_id, event.content_index);
    liveDeltas.set(key, `${liveDeltas.get(key) ?? ""}${event.delta ?? ""}`);
    renderTranscript();
    return;
  }

  if (isCompletedEvent(event)) {
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
  }
}

function isErrorEvent(event: TranscriptEvent): event is Extract<TranscriptEvent, { type: "error" }> {
  return event.type === "error";
}

function isDeltaEvent(
  event: TranscriptEvent
): event is Extract<TranscriptEvent, { type: "conversation.item.input_audio_transcription.delta" }> {
  return event.type === "conversation.item.input_audio_transcription.delta";
}

function isCompletedEvent(
  event: TranscriptEvent
): event is Extract<TranscriptEvent, { type: "conversation.item.input_audio_transcription.completed" }> {
  return event.type === "conversation.item.input_audio_transcription.completed";
}

function renderTranscript() {
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

function setState(nextState: AppState) {
  state = nextState;
  statusBadge.textContent = statusCopy[nextState];
  statusBadge.dataset.state = nextState;
  recordButton.dataset.state = nextState;

  const isBusy = nextState === "requesting-mic" || nextState === "connecting" || nextState === "stopping";
  recordButton.disabled = isBusy;
  recordButtonText.textContent = nextState === "recording" ? "Stop" : "Start";
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
  link.href = url;
  link.download = `whisper-live-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

function getTranscriptText() {
  return [...finalLines.values()]
    .sort((a, b) => a.completedAt - b.completedAt)
    .map((line) => line.text)
    .join("\n")
    .trim();
}

function readApiError(text: string) {
  try {
    const data = JSON.parse(text) as { error?: string; detail?: string };
    return data.detail || data.error || "Session request failed.";
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
