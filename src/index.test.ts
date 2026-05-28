import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import pluginEntry, { buildSbv2SpeechProvider } from "./index";

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45,
]);

describe("Style-Bert-VITS2 speech provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists voices from SBV2 models info", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          valentina01_bright: {
            spk2id: { valentina01_bright: 0 },
            id2spk: { "0": "valentina01_bright" },
            style2id: { "00_Neutral": 0, "01_Bright": 1 },
          },
          amitaro: {
            spk2id: { amitaro: 0 },
            id2spk: { "0": "amitaro" },
            style2id: { Neutral: 0 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    let provider: any;
    pluginEntry.register({
      registerSpeechProvider: (registered: unknown) => {
        provider = registered;
      },
    });

    const voices = await provider.listVoices({
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    expect(voices).toEqual([
      { id: "sbv2:amitaro:amitaro:Neutral", name: "amitaro (amitaro)" },
      {
        id: "sbv2:valentina01_bright:valentina01_bright:00_Neutral",
        name: "valentina01_bright (valentina01_bright)",
      },
    ]);
  });

  it("derives display model names from numeric models info entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            "2": {
              config_path: "model_assets/valentina01_bright/config.json",
              spk2id: { valentina01_bright: 0 },
              style2id: { "00_Neutral": 0 },
            },
          }),
      }),
    );

    let provider: any;
    pluginEntry.register({
      registerSpeechProvider: (registered: unknown) => {
        provider = registered;
      },
    });

    await expect(
      provider.listVoices({ providerConfig: { baseUrl: "http://localhost:5000" } }),
    ).resolves.toEqual([
      {
        id: "sbv2:valentina01_bright:valentina01_bright:00_Neutral",
        name: "valentina01_bright (valentina01_bright)",
      },
    ]);
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

  it("uses selected SBV2 voice overrides before configured defaults", async () => {
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
        defaultModelName: "configured-model",
        defaultSpeakerName: "configured-speaker",
        defaultStyle: "Neutral",
      },
      providerOverrides: {
        voiceId: "sbv2:valentina01_bright:valentina01_bright:00_Neutral",
      },
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_id")).toBeNull();
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

  it("requires a baseUrl to list voices", async () => {
    let provider: any;
    pluginEntry.register({
      registerSpeechProvider: (registered: unknown) => {
        provider = registered;
      },
    });

    await expect(provider.listVoices({ providerConfig: {} })).rejects.toThrow(
      /baseUrl is not configured/,
    );
  });
});
