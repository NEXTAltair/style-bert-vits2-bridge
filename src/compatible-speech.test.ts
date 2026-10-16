import { speechRequest } from "./speech.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompatibleSpeechProvider } from "./compatible-speech.js";

function wav(): Buffer {
  const data = Buffer.alloc(46);
  data.write("RIFF");
  data.writeUInt32LE(38, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(96000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(2, 40);
  return data;
}

describe("local OpenAI-compatible speech providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["irodori", "speech-cpp"] as const)("selects only %s config from the host TTS envelope", (engine) => {
    const provider = buildCompatibleSpeechProvider(engine);
    expect(provider.resolveConfig({ cfg: {}, timeoutMs: 120000, rawConfig: {
      auto: "off",
      providers: { [engine]: { baseUrl: "http://localhost:8088", voice: "sample" },
        unrelated: { apiKey: "not-this-provider" } },
    } })).toEqual({ baseUrl: "http://localhost:8088", voice: "sample", timeoutMs: 120000 });
  });

  it.each(["irodori", "speech-cpp"] as const)("supports current async and published sync config hooks for %s", async (engine) => {
    const provider = buildCompatibleSpeechProvider(engine);
    for (const [baseUrl, expected] of [["http://localhost:8088", true], ["", false]] as const) {
      const context = { providerConfig: { baseUrl }, timeoutMs: 30000 };
      expect(provider.isConfigured(context)).toBe(expected);
      expect(await provider.isConfiguredAsync(context)).toBe(expected);
    }
  });

  it("sends Irodori captions and references under irodori, with WAV output", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(wav())));
    vi.stubGlobal("fetch", fetch);
    const result = await buildCompatibleSpeechProvider("irodori").synthesize(speechRequest({
      text: "明るすぎない、自然な声で。",
      providerConfig: { baseUrl: "http://localhost:8088/v1", irodori: { ref_wavs: ["/voice/ref.wav"], caption: "落ち着いた声" } },
      providerOverrides: { caption: "少し明るく", speed: 1.1, seed: 42 },
    }));
    expect(String(fetch.mock.calls[0][0])).toBe("http://localhost:8088/v1/audio/speech");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      model: "irodori-tts", input: "明るすぎない、自然な声で。", voice: "none", speed: 1.1, response_format: "wav",
      irodori: { ref_wavs: ["/voice/ref.wav"], caption: "少し明るく", seed: 42 },
    });
    expect(result.audioBuffer).toEqual(wav());
    expect(result.metadata?.streaming).toBe(false);
  });

  it("keeps speech.cpp options top-level and never lets options replace text or format", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(wav())));
    vi.stubGlobal("fetch", fetch);
    await buildCompatibleSpeechProvider("speech-cpp").synthesize(speechRequest({
      text: "本来の本文", providerConfig: { baseUrl: "http://localhost:8766", voice: "B", speechOptions: { steps: 4, input: "wrong", response_format: "mp3" } },
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ steps: 4, input: "本来の本文", voice: "B", speed: 1, response_format: "wav" });
  });

  it("retains reverse-proxy prefixes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(wav())));
    vi.stubGlobal("fetch", fetch);
    await buildCompatibleSpeechProvider("irodori").synthesize(speechRequest({ text: "テスト", providerConfig: { baseUrl: "https://example.com/speech/" } }));
    expect(String(fetch.mock.calls[0][0])).toBe("https://example.com/speech/v1/audio/speech");
  });

  it("requires an explicitly chosen speech.cpp voice", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(buildCompatibleSpeechProvider("speech-cpp").synthesize(speechRequest({ text: "test", providerConfig: { baseUrl: "http://localhost:8766" } }))).rejects.toThrow("voice");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([NaN, 0, 5, "fast"])("rejects invalid speed %s", async (speed) => {
    await expect(buildCompatibleSpeechProvider("irodori").synthesize(speechRequest({ text: "test", providerConfig: { baseUrl: "http://localhost:8088", speed } }))).rejects.toThrow("speed");
  });

  it("rejects non-audio server responses even on HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>error</html>")));
    await expect(buildCompatibleSpeechProvider("irodori").synthesize(speechRequest({ text: "test", providerConfig: { baseUrl: "http://localhost:8088" } }))).rejects.toThrow("non-WAV");
  });

  it("redacts bearer tokens in HTTP error responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key secret-token", { status: 401 })));
    await expect(buildCompatibleSpeechProvider("irodori").synthesize(speechRequest({ text: "test", providerConfig: { baseUrl: "http://localhost:8088", apiKey: "secret-token" } }))).rejects.toThrow("[redacted]");
  });

  it("reports server availability without echoing credentials or paths", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-token /private/audio")));
    await expect(buildCompatibleSpeechProvider("irodori").synthesize(speechRequest({ text: "test", providerConfig: { baseUrl: "http://localhost:8088", apiKey: "secret-token" } }))).rejects.toThrow("Local speech server unavailable at http://localhost:8088");
  });

  it("lists Irodori's voice ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ id: "voice-a" }, { id: "voice-b" }] })));
    const provider = buildCompatibleSpeechProvider("irodori");
    expect(await provider.listVoices!({ providerConfig: { baseUrl: "http://localhost:8088" } })).toEqual([{ id: "voice-a", name: "voice-a" }, { id: "voice-b", name: "voice-b" }]);
  });

  it("lists the voices actually registered in speech.cpp", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{ speech: { voices: ["A", "B", "I08"] } }] })));
    expect(await buildCompatibleSpeechProvider("speech-cpp").listVoices!({ providerConfig: { baseUrl: "http://localhost:8766" } })).toHaveLength(3);
  });

  it("honors SDK voice-list request overrides and the host-resolved timeout", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "voice-a" }] }));
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await buildCompatibleSpeechProvider("irodori").listVoices({
      providerConfig: { baseUrl: "http://localhost:1", apiKey: "old-key", timeoutMs: 1 },
      baseUrl: "http://localhost:8088/v1", apiKey: "request-key", timeoutMs: 45000,
    });
    expect(String(fetch.mock.calls[0][0])).toBe("http://localhost:8088/v1/audio/voices");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer request-key");
    expect(timeout).toHaveBeenCalledWith(45000);
    timeout.mockRestore();
  });
});
