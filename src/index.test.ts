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

  it("returns safe telemetry metadata for the resolved SBV2 profile", async () => {
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

    const debug = vi.fn();
    const provider = buildSbv2SpeechProvider({ logger: { debug } });
    const result = await provider.synthesize({
      text: "ログに出してはいけない本文",
      providerConfig: {
        baseUrl: "http://user:secret@localhost:5000/api?token=hidden#fragment",
        defaultStyleWeight: 0.7,
        defaultLength: 1.1,
        defaultAssistText: "ログに出してはいけない補助テキスト",
      },
    });

    expect(result.metadata).toEqual({
      provider: "style-bert-vits2",
      baseUrl: "http://localhost:5000/api",
      voiceId: "valentina01_bright",
      modelName: "valentina01_bright",
      speakerName: "valentina01_bright",
      style: "00_Neutral",
      styleWeight: 0.7,
      length: 1.1,
      language: "JP",
      outputFormat: "wav",
      audioBytes: wavBytes.byteLength,
    });
    expect(debug).toHaveBeenCalledWith("style-bert-vits2 synthesis resolved", result.metadata);

    const loggedPayload = JSON.stringify(debug.mock.calls);
    expect(loggedPayload).not.toContain("ログに出してはいけない本文");
    expect(loggedPayload).not.toContain("ログに出してはいけない補助テキスト");
    expect(loggedPayload).not.toContain("secret");
    expect(loggedPayload).not.toContain("token=hidden");
    expect(loggedPayload).not.toContain(Buffer.from(wavBytes).toString("base64"));
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

  it("lets explicit overrides refine a selected SBV2 voice id", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            valentina01_bright: {
              spk2id: { valentina01_bright: 0 },
              style2id: { "00_Neutral": 0, Happy: 1 },
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
      providerConfig: { baseUrl: "http://localhost:5000" },
      providerOverrides: {
        voiceId: "sbv2:valentina01_bright:valentina01_bright:00_Neutral",
        style: "Happy",
      },
    });

    const url = new URL(mockFetch.mock.calls[1][0]);
    expect(url.searchParams.get("style")).toBe("Happy");
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
    const result = await provider.synthesize({
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
    expect(result.metadata).toMatchObject({
      voiceId: "sbv2:speakerless::Neutral",
      modelName: "speakerless",
      speakerName: undefined,
      style: "Neutral",
    });
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

  it("maps Talk snake_case voice fields, WPM rate, and style settings", () => {
    const provider = buildSbv2SpeechProvider();

    expect(
      provider.resolveTalkOverrides?.({
        params: {
          voice_id: "sbv2:model:speaker:Neutral",
          model_id: "2",
          speaker_id: "3",
          rate: 180,
          style: "Happy",
          style_weight: "0.7",
          assist_text: "cheerful",
          assist_text_weight: "0.8",
        },
      }),
    ).toEqual({
      voiceId: "sbv2:model:speaker:Neutral",
      modelId: 2,
      speakerId: 3,
      length: 1,
      style: "Happy",
      styleWeight: 0.7,
      assistText: "cheerful",
      assistTextWeight: 0.8,
    });
  });

  it("keeps Talk speed separate from WPM rate", () => {
    const provider = buildSbv2SpeechProvider();

    expect(
      provider.resolveTalkOverrides?.({
        params: {
          speed: 1.25,
          rate: 180,
        },
      }),
    ).toMatchObject({
      speed: 1.25,
      length: 1,
    });
  });

  it("requires a baseUrl to list voices", async () => {
    const provider = buildSbv2SpeechProvider();

    await expect(provider.listVoices?.({ providerConfig: {} })).rejects.toThrow(
      /baseUrl is not configured/,
    );
  });

  it("adds safe profile context to SBV2 resolve errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(valentinaModelsInfo),
      }),
    );

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.synthesize({
        text: "ログに出してはいけない本文",
        providerConfig: {
          baseUrl: "http://user:secret@localhost:5000?token=hidden",
          defaultModelName: "missing-model",
          defaultSpeakerName: "missing-speaker",
          defaultStyle: "MissingStyle",
          defaultAssistText: "ログに出してはいけない補助テキスト",
        },
      }),
    ).rejects.toThrow(
      /SBV2 telemetry context: provider=style-bert-vits2, baseUrl=http:\/\/localhost:5000, modelName=missing-model, speakerName=missing-speaker, style=MissingStyle/,
    );

    try {
      await provider.synthesize({
        text: "ログに出してはいけない本文",
        providerConfig: {
          baseUrl: "http://user:secret@localhost:5000?token=hidden",
          defaultModelName: "missing-model",
          defaultAssistText: "ログに出してはいけない補助テキスト",
        },
      });
      throw new Error("expected synthesize to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toContain("ログに出してはいけない本文");
      expect(message).not.toContain("ログに出してはいけない補助テキスト");
      expect(message).not.toContain("secret");
      expect(message).not.toContain("token=hidden");
    }
  });

  it("adds safe profile context to SBV2 voice request errors", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(valentinaModelsInfo),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve("upstream failed"),
      });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();

    await expect(
      provider.synthesize({
        text: "ログに出してはいけない本文",
        providerConfig: {
          baseUrl: "http://user:secret@localhost:5000?token=hidden",
          defaultAssistText: "ログに出してはいけない補助テキスト",
        },
      }),
    ).rejects.toThrow(
      /SBV2 telemetry context: provider=style-bert-vits2, baseUrl=http:\/\/localhost:5000, voiceId=valentina01_bright, modelName=valentina01_bright, speakerName=valentina01_bright, style=00_Neutral/,
    );
  });
});
