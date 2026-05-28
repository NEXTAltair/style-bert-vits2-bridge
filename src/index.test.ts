import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import pluginEntry, { buildSbv2SpeechProvider } from "./index.js";

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45,
]);

const valentinaModelsInfo = {
  valentina01_bright: {
    spk2id: { valentina01_bright: 0 },
    id2spk: { "0": "valentina01_bright" },
    style2id: { "00_Neutral": 0, "01_Bright": 1 },
  },
};

describe("Style-Bert-VITS2 speech provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the speech provider through the plugin entry", () => {
    let provider: unknown;
    pluginEntry.register({
      registerSpeechProvider: (registered: unknown) => {
        provider = registered;
      },
    });

    expect(provider).toMatchObject({
      id: "style-bert-vits2",
      label: "Style-Bert-VITS2",
    });
  });

  it("lists voices from SBV2 models info", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...valentinaModelsInfo,
          amitaro: {
            spk2id: { amitaro: 0 },
            id2spk: { "0": "amitaro" },
            style2id: { Neutral: 0 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    const voices = await provider.listVoices?.({
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

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.listVoices?.({ providerConfig: { baseUrl: "http://localhost:5000" } }),
    ).resolves.toEqual([
      {
        id: "sbv2:valentina01_bright:valentina01_bright:00_Neutral",
        name: "valentina01_bright (valentina01_bright)",
      },
    ]);
  });

  it("lists selectable voices for speakerless and styleless models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            speakerless: {
              style2id: { Neutral: 0 },
            },
            styleless: {
              spk2id: { alice: 0 },
            },
          }),
      }),
    );

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.listVoices?.({ providerConfig: { baseUrl: "http://localhost:5000" } }),
    ).resolves.toEqual([
      { id: "sbv2:styleless:alice", name: "alice (styleless)" },
      { id: "sbv2:speakerless::Neutral", name: "speakerless" },
    ]);
  });

  it("resolves voice params before calling /voice", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(valentinaModelsInfo),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    const result = await provider.synthesize({
      text: "こんにちは",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    expect(result.outputFormat).toBe("wav");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const modelsUrl = new URL(mockFetch.mock.calls[0][0]);
    const voiceUrl = new URL(mockFetch.mock.calls[1][0]);

    expect(modelsUrl.pathname).toBe("/models/info");
    expect(voiceUrl.pathname).toBe("/voice");
    expect(voiceUrl.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(voiceUrl.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(voiceUrl.searchParams.get("style")).toBe("00_Neutral");
    expect(voiceUrl.searchParams.get("language")).toBe("JP");
  });

  it("uses selected SBV2 voice overrides before configured defaults", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(valentinaModelsInfo),
      })
      .mockResolvedValueOnce({
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

    const url = new URL(mockFetch.mock.calls[1][0]);
    expect(url.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_id")).toBeNull();
    expect(url.searchParams.get("style")).toBe("00_Neutral");
  });

  it("uses speakerless voice ids without sending inherited speaker or style defaults", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            speakerless: {
              style2id: { Neutral: 0 },
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await provider.synthesize({
      text: "こんにちは",
      providerConfig: {
        baseUrl: "http://localhost:5000",
        defaultSpeakerName: "configured-speaker",
        defaultStyle: "00_Neutral",
      },
      providerOverrides: {
        voiceId: "sbv2:speakerless::Neutral",
      },
    });

    const url = new URL(mockFetch.mock.calls[1][0]);
    expect(url.searchParams.get("model_name")).toBe("speakerless");
    expect(url.searchParams.get("speaker_name")).toBeNull();
    expect(url.searchParams.get("style")).toBe("Neutral");
  });

  it("merges parsed directive overrides with current overrides", () => {
    const provider = buildSbv2SpeechProvider();

    expect(
      provider.parseDirectiveToken?.({
        key: "assist_text",
        value: "happy",
        policy: { allowVoiceSettings: true },
        currentOverrides: { style: "00_Neutral" },
      }),
    ).toEqual({
      style: "00_Neutral",
      assistText: "happy",
    });
  });

  it("requires a baseUrl to list voices", async () => {
    const provider = buildSbv2SpeechProvider();

    await expect(provider.listVoices?.({ providerConfig: {} })).rejects.toThrow(
      /baseUrl is not configured/,
    );
  });
});
