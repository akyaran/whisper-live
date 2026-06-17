interface Env {
  OPENAI_API_KEY: string;
}

type SessionMode = "transcript" | "translate";
type LanguageCode = "en" | "ja";

function createTranscriptSessionConfig(language: LanguageCode) {
  return {
    type: "transcription",
    audio: {
      input: {
        transcription: {
          model: "gpt-realtime-whisper",
          language,
          delay: "minimal"
        },
        turn_detection: null
      }
    }
  };
}

function createTranslationSessionConfig(targetLanguage: LanguageCode) {
  return {
    session: {
      model: "gpt-realtime-translate",
      audio: {
        output: {
          language: targetLanguage
        }
      }
    }
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, { status: 204, headers: corsHeaders });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.OPENAI_API_KEY) {
    return json({ error: "OPENAI_API_KEY is not configured." }, 500);
  }

  const contentType = request.headers.get("content-type") ?? "";
  const mode = getMode(request, contentType);

  if (mode === "translate") {
    return createTranslationSession(request, env);
  }

  return createTranscriptSession(request, env, contentType);
};

async function createTranscriptSession(request: Request, env: Env, contentType: string) {
  if (!contentType.includes("application/sdp")) {
    return json({ error: "Expected Content-Type: application/sdp." }, 415);
  }

  const sdp = await request.text();
  if (!sdp.trim()) {
    return json({ error: "Missing SDP offer." }, 400);
  }

  const url = new URL(request.url);
  const language = getLanguage(url.searchParams.get("language"), "en");
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(createTranscriptSessionConfig(language)));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "OpenAI-Safety-Identifier": "whisper-live-pwa"
    },
    body: form
  });

  const body = await response.text();
  if (!response.ok) {
    return json(
      {
        error: "OpenAI Realtime session creation failed.",
        detail: body
      },
      response.status
    );
  }

  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/sdp"
    }
  });
}

async function createTranslationSession(request: Request, env: Env) {
  const targetLanguage = await getTargetLanguage(request);
  const response = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "whisper-live-pwa"
    },
    body: JSON.stringify(createTranslationSessionConfig(targetLanguage))
  });

  const data = await response.json();
  if (!response.ok) {
    return json(
      {
        error: "OpenAI translation session creation failed.",
        detail: data
      },
      response.status
    );
  }

  return json(
    {
      mode: "translate",
      endpoint: "https://api.openai.com/v1/realtime/translations/calls",
      clientSecret: data
    },
    200
  );
}

function getMode(request: Request, contentType: string): SessionMode {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");

  if (mode === "translate") {
    return "translate";
  }

  if (mode === "transcript") {
    return "transcript";
  }

  return contentType.includes("application/json") ? "translate" : "transcript";
}

async function getTargetLanguage(request: Request): Promise<LanguageCode> {
  try {
    const body = (await request.json()) as { targetLanguage?: string };
    return getLanguage(body.targetLanguage, "ja");
  } catch {
    return "ja";
  }
}

function getLanguage(value: string | null | undefined, fallback: LanguageCode): LanguageCode {
  return value === "en" || value === "ja" ? value : fallback;
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
