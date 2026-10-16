import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";

export type CompatibleSpeechEngine = "irodori" | "speech-cpp";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function endpoint(base: unknown, route: string): URL {
  const value = string(base);
  if (!value) throw new Error("Local speech baseUrl is not configured");
  const url = new URL(value.replace(/\/+$/, "") + "/");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Speech baseUrl must be an HTTP(S) URL without embedded credentials, query, or fragment");
  }
  // Accept both a server root and an existing /v1 API prefix, including reverse-proxy paths.
  return new URL((url.pathname.endsWith("/v1/") ? "" : "v1/") + route, url);
}

function timeout(value: unknown): number {
  if (value === undefined) return 120_000;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Speech timeoutMs must be a positive integer");
  }
  return value;
}

function headers(config: Record<string, unknown>): Record<string, string> {
  const key = string(config.apiKey);
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

async function request(url: URL, config: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: headers(config),
      redirect: "error",
      signal: AbortSignal.timeout(timeout(config.timeoutMs)),
    });
  } catch {
    // Do not echo request bodies (local file paths) or bearer tokens in operator errors.
    throw new Error(`Local speech server unavailable at ${url.origin}; check its health and timeoutMs`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const key = string(config.apiKey);
    const detail = (key ? body.replaceAll(key, "[redacted]") : body).slice(0, 800);
    throw new Error(`Local speech ${url.pathname} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

export function buildCompatibleSpeechProvider(engine: CompatibleSpeechEngine): SpeechProviderPlugin {
  return {
    id: engine,
    label: engine === "irodori" ? "Irodori-TTS" : "speech.cpp",
    capabilities: { text: engine === "irodori" ? { maxInputChars: 4096 } : {} },
    isConfigured: ({ providerConfig }) => Boolean(string(providerConfig.baseUrl)),
    resolveConfig: ({ rawConfig }) => rawConfig,
    listVoices: async ({ providerConfig = {} }) => {
      const route = engine === "irodori" ? "audio/voices" : "models";
      const response = await request(endpoint(providerConfig.baseUrl, route), providerConfig);
      const body = record(await response.json());
      const rows = Array.isArray(body.data) ? body.data : [];
      if (engine === "irodori") {
        return rows.flatMap((row) => {
          const id = string(record(row).id);
          return id ? [{ id, name: id }] : [];
        });
      }
      const ids = rows.flatMap((row) => {
        const voices = record(record(row).speech).voices;
        return Array.isArray(voices)
          ? voices.flatMap((voice) => {
              const id = string(voice) ?? string(record(voice).id) ?? string(record(voice).name);
              return id ? [id] : [];
            })
          : [];
      });
      return [...new Set(ids)].map((id) => ({ id, name: id }));
    },
    synthesize: async (req) => {
      const config = req.providerConfig;
      const overrides = req.providerOverrides ?? {};
      const voice = string(overrides.voice) ?? string(config.voice) ?? (engine === "irodori" ? "none" : undefined);
      if (!voice) throw new Error("speech.cpp voice must name an existing registered voice");
      if (!req.text.trim()) throw new Error("Speech text must not be empty");
      const speed = overrides.speed ?? config.speed ?? 1;
      if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
        throw new Error("Speech speed must be between 0.25 and 4");
      }
      const model = string(overrides.model) ?? string(config.model) ?? (engine === "irodori" ? "irodori-tts" : undefined);
      const options = { ...record(config[engine === "irodori" ? "irodori" : "speechOptions"]) };
      // Inference options must not replace routing, text, or the WAV response contract.
      for (const key of ["input", "model", "voice", "response_format", "stream_format", "speed", "__proto__", "constructor", "prototype"]) {
        delete options[key];
      }
      if (typeof overrides.seed === "number" && Number.isSafeInteger(overrides.seed)) options.seed = overrides.seed;
      if (engine === "irodori" && typeof overrides.caption === "string") options.caption = overrides.caption;
      if (engine === "speech-cpp") {
        const instructions = string(overrides.instructions) ?? string(config.instructions);
        if (instructions) options.instructions = instructions;
      }
      const payload = {
        ...(engine === "speech-cpp" ? options : {}),
        ...(model ? { model } : {}),
        input: req.text,
        voice,
        speed,
        response_format: "wav",
        ...(engine === "irodori" ? { irodori: options } : {}),
      };
      const response = await request(endpoint(config.baseUrl, "audio/speech"), {
        ...config, timeoutMs: req.timeoutMs ?? config.timeoutMs,
      }, { method: "POST", body: JSON.stringify(payload) });
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      if (audioBuffer.length < 44 || audioBuffer.toString("ascii", 0, 4) !== "RIFF" || audioBuffer.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error(`${engine} returned an invalid or non-WAV response`);
      }
      return {
        audioBuffer, outputFormat: "wav", fileExtension: ".wav", voiceCompatible: false,
        metadata: { provider: engine, model, voice, speed, streaming: false },
      };
    },
  };
}
