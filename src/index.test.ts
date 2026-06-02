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

const observedToolFailureText =
  '⚠️ 🛠️ gh issue close 2 --repo NEXTAltair/openclaw --reason not planned --comment "Opened in the wrong repository. This belong… (in ~/src/openclaw) failed';

function openApiTextLimit(maxLength: number) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        paths: {
          "/voice": {
            post: {
              parameters: [{ name: "text", schema: { maxLength } }],
            },
          },
        },
      }),
  };
}

function openApiUnlimitedText() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        paths: {
          "/voice": {
            post: {
              parameters: [{ name: "text", schema: { type: "string" } }],
            },
          },
        },
      }),
  };
}

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
      capabilities: {
        text: {
          maxInputChars: 100,
        },
      },
    });
  });

  it("reports dynamic SBV2 text capabilities from OpenAPI when configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          paths: {
            "/voice": {
              post: {
                parameters: [{ name: "text", schema: { maxLength: 320 } }],
              },
            },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.resolveCapabilities?.({ providerConfig: { baseUrl: "http://localhost:5000" } }),
    ).resolves.toEqual({
      text: {
        maxInputChars: 320,
      },
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/openapi.json");
  });

  it("rejects text over the SBV2 hard limit before sending /voice", async () => {
    const mockFetch = vi.fn().mockResolvedValue(openApiTextLimit(400));
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.synthesize({
        text: "あ".repeat(401),
        providerConfig: { baseUrl: "http://localhost:5000" },
      }),
    ).rejects.toThrow(/SBV2 \/voice text is too long: 401 chars exceeds provider hard limit 400/);

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/openapi.json");
  });

  it("allows text at the SBV2 hard limit", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "あ".repeat(400),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.pathname).toBe("/voice");
    expect(voiceUrl.searchParams.get("text")).toBe("あ".repeat(400));
  });

  it("uses the OpenAPI text limit for synthesis preflight", async () => {
    const mockFetch = vi.fn().mockResolvedValue(openApiTextLimit(320));
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.synthesize({
        text: "あ".repeat(321),
        providerConfig: { baseUrl: "http://localhost:5000" },
      }),
    ).rejects.toThrow(/exceeds provider hard limit 320/);

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/openapi.json");
  });

  it("counts Unicode code points for the SBV2 text limit", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(100))
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
      text: "😀".repeat(51),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.pathname).toBe("/voice");
    expect(voiceUrl.searchParams.get("text")).toBe("😀".repeat(51));
  });

  it("reports over-limit Unicode text by code point count", async () => {
    const mockFetch = vi.fn().mockResolvedValue(openApiTextLimit(100));
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.synthesize({
        text: "😀".repeat(101),
        providerConfig: { baseUrl: "http://localhost:5000" },
      }),
    ).rejects.toThrow(/SBV2 \/voice text is too long: 101 chars exceeds provider hard limit 100/);
  });

  it("validates the pronunciation-adjusted text sent to SBV2", async () => {
    const mockFetch = vi.fn().mockResolvedValue(openApiTextLimit(100));
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.synthesize({
        text: "SBV2",
        providerConfig: {
          baseUrl: "http://localhost:5000",
          pronunciationReplacements: { SBV2: "あ".repeat(101) },
        },
      }),
    ).rejects.toThrow(/SBV2 \/voice text is too long: 101 chars exceeds provider hard limit 100/);

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("does not cap synthesis when reachable OpenAPI has no text maxLength", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiUnlimitedText())
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
      text: "あ".repeat(401),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.pathname).toBe("/voice");
    expect(voiceUrl.searchParams.get("text")).toBe("あ".repeat(401));
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
      .mockResolvedValueOnce(openApiTextLimit(400))
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
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const openApiUrl = new URL(mockFetch.mock.calls[0][0]);
    const modelsUrl = new URL(mockFetch.mock.calls[1][0]);
    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);

    expect(openApiUrl.pathname).toBe("/openapi.json");
    expect(modelsUrl.pathname).toBe("/models/info");
    expect(voiceUrl.pathname).toBe("/voice");
    expect(voiceUrl.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(voiceUrl.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(voiceUrl.searchParams.get("style")).toBe("00_Neutral");
    expect(voiceUrl.searchParams.get("language")).toBe("JP");
  });

  it("rewrites raw tool status failure text before calling /voice", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: observedToolFailureText,
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("コマンドが失敗しました。別の方法で進めます。");
    expect(spokenText).not.toContain("gh issue close");
    expect(spokenText).not.toContain("--repo");
    expect(spokenText).not.toContain("~/src/openclaw");
    expect(spokenText).not.toContain("⚠️");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("uses the resolved synthesis language for rewritten tool status text", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: observedToolFailureText,
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(voiceUrl.searchParams.get("language")).toBe("EN");
  });

  it("passes ordinary Japanese text through without tool status rewriting", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "GitHub issue のクローズに失敗しました。理由を確認します。",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("GitHub issue のクローズに失敗しました。理由を確認します。");
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("does not rewrite natural narration about a failed command", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "The git command failed for NEXTAltair/openclaw, so I will check the repository state.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe(
      "The git command failed for NEXTAltair/openclaw, so I will check the repository state.",
    );
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("does not treat failure verbs as command subcommands", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "Python failed to parse the file, so I will inspect the syntax.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe(
      "Python failed to parse the file, so I will inspect the syntax.",
    );
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("rewrites colon-delimited CLI errors", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "git status --bad\nerror: unknown option",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("rewrites failed command lines that use single-dash options", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "python -m pytest failed",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("does not turn emoji-prefixed non-failure warnings into command failures", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "⚠️ High CPU usage detected.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("⚠️ High CPU usage detected.");
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("does not turn emoji-prefixed running tool status into command failures", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "🛠️ git status is still running.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("🛠️ git status is still running.");
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("allows explicit tts text to speak command-like text intentionally", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
      text: "[[tts:text]]gh issue close 2 --repo NEXTAltair/openclaw failed[[/tts:text]]",
      providerConfig: {
        baseUrl: "http://localhost:5000",
        pronunciationReplacements: { gh: "ジーエイチ" },
      },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("gh issue close 2 --repo NEXTAltair/openclaw failed");
    expect(result.metadata).toMatchObject({ textPreparation: "explicit" });
  });

  it("passes SBV2 generation tuning defaults through to /voice", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
        defaultSdpRatio: 0.15,
        defaultNoise: 0.45,
        defaultNoisew: 0.55,
      },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("sdp_ratio")).toBe("0.15");
    expect(voiceUrl.searchParams.get("noise")).toBe("0.45");
    expect(voiceUrl.searchParams.get("noisew")).toBe("0.55");
  });

  it("returns OpenClaw directive parse results for style overrides", () => {
    const provider = buildSbv2SpeechProvider();

    expect(
      provider.parseDirectiveToken?.({
        key: "style",
        value: "01_Happy",
        policy: { allowVoiceSettings: true },
        currentOverrides: { styleWeight: 0.65, noise: 0.45 },
      }),
    ).toEqual({
      handled: true,
      overrides: {
        style: "01_Happy",
        styleWeight: 0.65,
        noise: 0.45,
      },
    });
  });

  it("returns safe telemetry metadata for the resolved SBV2 profile", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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
        defaultSdpRatio: 0.15,
        defaultNoise: 0.45,
        defaultNoisew: 0.55,
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
      sdpRatio: 0.15,
      noise: 0.45,
      noisew: 0.55,
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
      .mockResolvedValueOnce(openApiTextLimit(400))
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

    const url = new URL(mockFetch.mock.calls[2][0]);
    expect(url.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_id")).toBeNull();
    expect(url.searchParams.get("style")).toBe("00_Neutral");
  });

  it("lets style overrides change expression without changing selected model and speaker", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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

    const url = new URL(mockFetch.mock.calls[2][0]);
    expect(url.searchParams.get("model_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("speaker_name")).toBe("valentina01_bright");
    expect(url.searchParams.get("style")).toBe("Happy");
  });

  it("uses speakerless voice ids without sending inherited speaker or style defaults", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
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

    const url = new URL(mockFetch.mock.calls[2][0]);
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

  it("rejects malformed selectable SBV2 voice ids before synthesis", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();
    await expect(
      provider.synthesize({
        text: "こんにちは",
        providerConfig: { baseUrl: "http://localhost:5000" },
        providerOverrides: { voiceId: "sbv2:%E0%A4%A" },
      }),
    ).rejects.toThrow('Malformed SBV2 voice ID "sbv2:%E0%A4%A"');

    expect(mockFetch).not.toHaveBeenCalled();
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
      handled: true,
      overrides: {
        style: "00_Neutral",
        assistText: "happy",
      },
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
          sdp_ratio: "0.15",
          noise: "0.45",
          noisew: "0.55",
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
      sdpRatio: 0.15,
      noise: 0.45,
      noisew: 0.55,
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
      .mockResolvedValueOnce(openApiTextLimit(400))
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

  it("surfaces SBV2 FastAPI unavailability with provider and baseUrl context", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(400))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(valentinaModelsInfo),
      })
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5000" },
        }),
      );
    vi.stubGlobal("fetch", mockFetch);

    const provider = buildSbv2SpeechProvider();

    try {
      await provider.synthesize({
        text: "ログに出してはいけない本文",
        providerConfig: {
          baseUrl: "http://user:secret@localhost:5000?token=hidden",
          defaultAssistText: "ログに出してはいけない補助テキスト",
        },
      });
      throw new Error("expected synthesize to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(
        /SBV2 FastAPI server is unavailable or unreachable: \/voice request failed for baseUrl http:\/\/localhost:5000/,
      );
      expect(message).toContain("provider=style-bert-vits2");
      expect(message).toContain("baseUrl=http://localhost:5000");
      expect(message).toContain("voiceId=valentina01_bright");
      expect(message).toContain("modelName=valentina01_bright");
      expect(message).toContain("speakerName=valentina01_bright");
      expect(message).toContain("style=00_Neutral");
      expect(message).toContain("ECONNREFUSED");
      expect(message).not.toContain("ログに出してはいけない本文");
      expect(message).not.toContain("ログに出してはいけない補助テキスト");
      expect(message).not.toContain("secret");
      expect(message).not.toContain("token=hidden");
    }
  });
});
