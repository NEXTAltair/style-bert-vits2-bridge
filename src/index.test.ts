import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import { buildSbv2SpeechProvider } from "./index";

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45,
]);

describe("Style-Bert-VITS2 speech provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes configured default voice values to SBV2", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await provider.synthesize({
      text: "こんにちは",
      providerConfig: {
        baseUrl: "http://localhost:5000",
        defaultModelName: "valentina01_bright",
        defaultSpeakerName: "valentina01_bright",
        defaultStyle: "00_Neutral",
        defaultLanguage: "JP",
      },
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("style")).toBe("00_Neutral");
    expect(url.searchParams.get("language")).toBe("JP");
  });

  it("uses default keys before legacy keys", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await provider.synthesize({
      text: "こんにちは",
      providerConfig: {
        baseUrl: "http://localhost:5000",
        defaultModelName: "valentina01_bright",
        modelName: "amitaro",
        defaultSpeakerId: 3,
        speakerId: 0,
        defaultStyle: "00_Neutral",
        style: "Neutral",
      },
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_id")).toBe("3");
    expect(url.searchParams.get("style")).toBe("00_Neutral");
  });

  it("falls back to legacy config keys", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await provider.synthesize({
      text: "こんにちは",
      providerConfig: {
        baseUrl: "http://localhost:5000",
        modelName: "legacy-model",
        speakerName: "legacy-speaker",
        style: "LegacyStyle",
        language: "EN",
      },
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("model_name")).toBe("legacy-model");
    expect(url.searchParams.get("speaker_name")).toBe("legacy-speaker");
    expect(url.searchParams.get("style")).toBe("LegacyStyle");
    expect(url.searchParams.get("language")).toBe("EN");
  });
});
