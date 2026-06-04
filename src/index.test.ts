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

  it("rewrites GitHub issue metadata status text before calling /voice", async () => {
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
      text: "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("GitHub の課題を更新しました。");
    expect(spokenText).not.toContain("Issue");
    expect(spokenText).not.toContain("issues/64");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("rewrites GitHub PR status lines without leaking labels or URLs", async () => {
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
      text: "PR updated: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("The GitHub pull request was updated.");
    expect(spokenText).not.toContain("PR updated");
    expect(spokenText).not.toContain("/pull/65");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("rewrites verb-first GitHub issue metadata status lines", async () => {
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
      text: "Created issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The GitHub issue was updated.");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("rewrites GitHub-prefixed pull request metadata status lines", async () => {
    const inputs = [
      "GitHub pull request: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65",
      "Updated GitHub pull request: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65",
    ];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe("The GitHub pull request was updated.");
      expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
    }
  });

  it("rewrites GitHub comment and review URL metadata status lines", async () => {
    const inputs = [
      ["Commented issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64#issuecomment-123", "The GitHub issue was updated."],
      ["Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64?notification_referrer_id=abc123", "The GitHub issue was updated."],
      ["Posted PR: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65#discussion_r123", "The GitHub pull request was updated."],
    ] as const;

    for (const [text, expectedText] of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe(expectedText);
      expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
    }
  });

  it("rewrites mixed issue and PR metadata-only blocks generically", async () => {
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
      text: [
        "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
        "PR: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The GitHub items were updated.");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("rewrites longer metadata-only link blocks before SBV2 text-limit checks", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(40))
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
      text: [
        "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
        "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/65",
        "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/66",
        "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/67",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The GitHub issue was updated.");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("rewrites numbered GitHub issue and PR metadata labels", async () => {
    const inputs = [
      ["Issue #64: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64", "The GitHub issue was updated."],
      ["PR #65: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65", "The GitHub pull request was updated."],
    ] as const;

    for (const [text, expectedText] of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe(expectedText);
      expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
    }
  });

  it("rewrites GitHub PR subpage URL metadata without leaking suffixes", async () => {
    const inputs = [
      "PR: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65/files",
      "PR: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65/checks?check_run_id=123",
      "PR: [#65](https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65/files)",
      "1. PR: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65",
      "PR: https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65.",
    ];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      const spokenText = voiceUrl.searchParams.get("text");
      expect(spokenText).toBe("The GitHub pull request was updated.");
      expect(spokenText).not.toContain("/files");
      expect(spokenText).not.toContain("/checks");
      expect(spokenText).not.toContain("#65");
      expect(spokenText).not.toContain("1. PR");
      expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
    }
  });

  it("drops GitHub issue metadata URL lines from mixed user-facing prose", async () => {
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

    const text = [
      "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
      "Please review the repro steps below.",
    ].join("\n");
    const provider = buildSbv2SpeechProvider();
    const result = await provider.synthesize({
      text,
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("Please review the repro steps below.");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("drops bare GitHub issue URL lines from final response speech text", async () => {
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
      text: [
        "作った。",
        "",
        "https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71",
        "",
        "内容は確認します。",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("作った。\n内容は確認します。");
    expect(spokenText).not.toContain("https://github.com");
    expect(spokenText).not.toContain("issues/71");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("removes inline GitHub URLs from final response speech text", async () => {
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
      text: "作った。 https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("作った。");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("ignores non-issue GitHub file paths that contain issue-like segments", async () => {
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
    const text = "See https://github.com/org/repo/blob/main/docs/issues/71.md for details.";
    const result = await provider.synthesize({
      text,
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe(text);
    expect(result.metadata).not.toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("removes Markdown-wrapped GitHub subpage URLs from inline prose", async () => {
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
      text: [
        "See <https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65/files> now",
        "Check `https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/65/checks?check_run_id=123` next",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("See now\nCheck next");
    expect(spokenText).not.toContain("<");
    expect(spokenText).not.toContain(">");
    expect(spokenText).not.toContain("`");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps Markdown GitHub link labels in inline prose", async () => {
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
      text: "Please see [the pull request](https://github.com/org/repo/pull/65) for details.",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the pull request for details.");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps Markdown GitHub link labels when inline links include titles", async () => {
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
      text: 'Please see [the PR](https://github.com/org/repo/pull/65 "hidden title") now.',
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the PR now.");
    expect(spokenText).not.toContain("hidden title");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps meaningful Markdown GitHub link labels on link-only list items", async () => {
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
      text: [
        "- [Fixed crash](https://github.com/org/repo/issues/71)",
        "- [issue](https://github.com/org/repo/issues/72)",
        "確認します。",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Fixed crash\n確認します。");
    expect(spokenText).not.toContain("https://github.com");
    expect(spokenText).not.toContain("\nissue\n");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("drops Markdown reference-style GitHub link definitions", async () => {
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
      text: [
        "対応しました。",
        "[1]: https://github.com/org/repo/issues/71",
        "[pr]: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("対応しました。");
    expect(spokenText).not.toContain("[1]:");
    expect(spokenText).not.toContain("[pr]:");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("drops Markdown reference-style GitHub link definitions with titles", async () => {
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
      text: [
        "対応しました。",
        '[1]: https://github.com/org/repo/issues/71 "fix"',
        "[pr]: https://github.com/org/repo/pull/65 'details'",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("対応しました。");
    expect(spokenText).not.toContain("[1]:");
    expect(spokenText).not.toContain("fix");
    expect(spokenText).not.toContain("details");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps Markdown reference-style GitHub link labels in prose", async () => {
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
      text: [
        "Please see [the pull request][pr].",
        "[pr]: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the pull request.");
    expect(spokenText).not.toContain("[pr]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps collapsed Markdown reference-style GitHub link labels in prose", async () => {
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
      text: [
        "Please see [the pull request][].",
        "[the pull request]: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the pull request.");
    expect(spokenText).not.toContain("[]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps shortcut Markdown reference-style GitHub link labels in prose", async () => {
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
      text: [
        "Please see [the pull request].",
        "[the pull request]: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the pull request.");
    expect(spokenText).not.toContain("[the pull request]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps Markdown reference-style labels when definitions use angle-bracket destinations", async () => {
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
      text: [
        "Please see [the pull request][pr].",
        "[pr]: <https://github.com/org/repo/pull/65>",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the pull request.");
    expect(spokenText).not.toContain("[pr]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("normalizes whitespace when matching Markdown reference-style GitHub labels", async () => {
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
      text: [
        "Please see [the PR][pull   request].",
        "[pull request]: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the PR.");
    expect(spokenText).not.toContain("[pull");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("strips Markdown image markers from reference-style GitHub link labels", async () => {
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
      text: [
        "![fixed crash][pr]",
        "[pr]: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("fixed crash");
    expect(spokenText).not.toContain("!");
    expect(spokenText).not.toContain("[pr]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("does not rewrite non-GitHub inline link labels as shortcut references", async () => {
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
      text: [
        "See [docs](https://example.com).",
        "[docs]: https://github.com/org/repo/issues/71",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("See [docs](https://example.com).");
    expect(spokenText).not.toContain("docs(https://example.com)");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("drops multiline Markdown reference definition titles", async () => {
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
      text: [
        "対応しました。",
        "[pr]: https://github.com/org/repo/pull/65",
        '  "details"',
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("対応しました。");
    expect(spokenText).not.toContain("details");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("drops Markdown heading markers left by URL-only GitHub headings", async () => {
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
      text: [
        "### https://github.com/org/repo/issues/71",
        "### [issue](https://github.com/org/repo/issues/72)",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("The GitHub issue was updated.");
    expect(spokenText).not.toContain("###");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("drops Markdown emphasis markers left by URL-only GitHub links", async () => {
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
      text: [
        "**https://github.com/org/repo/issues/71**",
        "**[issue](https://github.com/org/repo/issues/72)**",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("The GitHub issue was updated.");
    expect(spokenText).not.toContain("**");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("removes inline wrappers left by bare GitHub URL removal", async () => {
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
      text: [
        "See (https://github.com/org/repo/issues/71) for details.",
        "See [https://github.com/org/repo/pull/65] for details.",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("See for details.\nSee for details.");
    expect(spokenText).not.toContain("()");
    expect(spokenText).not.toContain("[]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("removes bracket wrappers around GitHub URLs with query or fragment suffixes", async () => {
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
      text: [
        "See [https://github.com/org/repo/issues/71?x=1] now.",
        "See [https://github.com/org/repo/issues/72#comment] next.",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("See now.\nSee next.");
    expect(spokenText).not.toContain("[");
    expect(spokenText).not.toContain("]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("removes inline emphasis markers left by GitHub link removal", async () => {
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
      text: [
        "See **https://github.com/org/repo/issues/71** for details.",
        "See **[the PR](https://github.com/org/repo/pull/65)** now.",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("See for details.\nSee the PR now.");
    expect(spokenText).not.toContain("**");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps Markdown link labels when inline destinations use angle brackets", async () => {
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
      text: "Please see [the PR](<https://github.com/org/repo/pull/65>) now.",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Please see the PR now.");
    expect(spokenText).not.toContain("[the PR]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("strips Markdown image markers from GitHub link labels", async () => {
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
      text: "![fixed crash](https://github.com/org/repo/issues/71)",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("fixed crash");
    expect(spokenText).not.toContain("!");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("drops URL-only list markers from final response speech text", async () => {
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
      text: [
        "- https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71",
        "1. https://github.com/NEXTAltair/style-bert-vits2-bridge/pull/73/files",
        "- [issue](https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/72)",
        "<https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/73>",
        "`https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/74`",
        "https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/75.",
        "内容は確認します。",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("内容は確認します。");
    expect(spokenText).not.toContain("-");
    expect(spokenText).not.toContain("1.");
    expect(spokenText).not.toContain("issue");
    expect(spokenText).not.toContain("https://github.com");
    expect(spokenText).not.toContain("<>");
    expect(spokenText).not.toContain("`");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("keeps empty call and list markers in prose while removing GitHub URLs", async () => {
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
      text: [
        "Call foo() after https://github.com/org/repo/issues/71",
        "Use [] as the default: https://github.com/org/repo/pull/65",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Call foo() after\nUse [] as the default:");
    expect(spokenText).toContain("foo()");
    expect(spokenText).toContain("[]");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("preserves code identifiers on lines that also remove GitHub URLs", async () => {
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
      text: "Call __init__ before https://github.com/org/repo/issues/71",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Call __init__ before");
    expect(spokenText).toContain("__init__");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("preserves Markdown-like tokens on URL-free lines during GitHub URL sanitization", async () => {
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
      text: [
        "Call __init__ before proceeding.",
        "https://github.com/org/repo/issues/71",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("Call __init__ before proceeding.");
    expect(spokenText).toContain("__init__");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("rewrites GitHub PR diff and patch URL metadata without leaking suffixes", async () => {
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
      text: [
        "PR: https://github.com/org/repo/pull/65.diff",
        "PR: https://github.com/org/repo/pull/66.patch",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    const spokenText = voiceUrl.searchParams.get("text");
    expect(spokenText).toBe("The GitHub pull request was updated.");
    expect(spokenText).not.toContain(".diff");
    expect(spokenText).not.toContain(".patch");
    expect(spokenText).not.toContain("https://github.com");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("rewrites bare GitHub URL-only speech text to natural metadata text", async () => {
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
      text: "https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The GitHub issue was updated.");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("checks the SBV2 text limit after GitHub URL sanitization", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(20))
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
      text: [
        "作った。",
        "https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71?notification_referrer_id=very-long",
      ].join("\n"),
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("作った。");
    expect(result.metadata).toMatchObject({ textPreparation: "url_sanitize" });
  });

  it("uses provider override language for rewritten text limit preflight", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(20))
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
      text: "https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      providerOverrides: { language: "JP" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("GitHub の課題を更新しました。");
    expect(voiceUrl.searchParams.get("language")).toBe("JP");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("uses selected voice profile language for rewritten text limit preflight", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(20))
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
      text: "https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/71",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      providerOverrides: { voiceId: "valentina01_bright" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("GitHub の課題を更新しました。");
    expect(voiceUrl.searchParams.get("language")).toBe("JP");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
  });

  it("defers SBV2 text limit checks for long metadata that will be rewritten", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(openApiTextLimit(40))
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
      text: "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The GitHub issue was updated.");
    expect(result.metadata).toMatchObject({ textPreparation: "metadata_status_rewrite" });
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

  it("does not treat tool-name prose as command output", async () => {
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
      text: "Python script failed to parse the file, and Node process failed to start.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe(
      "Python script failed to parse the file, and Node process failed to start.",
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

  it("rewrites versioned interpreter command failures", async () => {
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
      text: "python3.12 -m pytest failed",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("does not treat version prose as script-path command failures", async () => {
    const inputs = ["Python 3.12 failed to parse the file", "node v20.1 failed to start"];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe(text);
      expect(result.metadata).not.toHaveProperty("textPreparation");
    }
  });

  it("rewrites script-path command failures", async () => {
    const inputs = ["node scripts/check.js failed", "bash scripts/deploy.sh failed", "🛠️ python tools/run.py failed"];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
      expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
    }
  });

  it("rewrites package-manager diagnostic failures", async () => {
    const inputs = [
      "npm ci --ignore-scripts\nnpm ERR! code EUSAGE",
      "pnpm install\nERR_PNPM_PEER_DEP_ISSUES",
      "yarn install\nYN0001: Error: package failed",
    ];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
      expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
    }
  });

  it("rewrites direct check and test executable failures", async () => {
    const inputs = ["tsc --noEmit failed", "vitest run failed", "npx tsc --noEmit failed"];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
      expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
    }
  });

  it("rewrites command-failed prefixes before command invocations", async () => {
    const inputs = [
      "Command failed with exit code 1: git status --short",
      "Error: Command failed with exit code 1: npm ci",
    ];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
      expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
    }
  });

  it("rewrites colon-form exit codes", async () => {
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
      text: "git status --short\nexit code: 1",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("rewrites undecorated failed command status lines", async () => {
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
      text: "git status failed",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("rewrites failed command statuses with common subcommands", async () => {
    const inputs = ["🛠️ git diff failed", "npm ci failed", "pnpm lint failed"];

    for (const text of inputs) {
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
        text,
        providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
      });

      const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
      expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
      expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
    }
  });

  it("rewrites operator-prefixed command failure status lines", async () => {
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
      text: "🛠️ git status failed",
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

  it("does not turn emoji-prefixed natural failures into command failures", async () => {
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
      text: "⚠️ Database connection failed.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("⚠️ Database connection failed.");
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("does not rewrite negated error narration about command flags", async () => {
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
      text: "git status --short is not an error.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("git status --short is not an error.");
    expect(result.metadata).not.toHaveProperty("textPreparation");
  });

  it("rewrites fatal CLI diagnostics", async () => {
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
      text: "git status\nfatal: not a git repository",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("The command failed. I will try another way.");
    expect(result.metadata).toMatchObject({ textPreparation: "tool_status_rewrite" });
  });

  it("does not treat cwd suffixes without command context as tool status", async () => {
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
      text: "Loading config (in /etc/app) failed.",
      providerConfig: { baseUrl: "http://localhost:5000", defaultLanguage: "EN" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe("Loading config (in /etc/app) failed.");
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

  it("allows explicit tts text to speak GitHub issue metadata intentionally", async () => {
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
      text: "[[tts:text]]Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64[[/tts:text]]",
      providerConfig: { baseUrl: "http://localhost:5000" },
    });

    const voiceUrl = new URL(mockFetch.mock.calls[2][0]);
    expect(voiceUrl.searchParams.get("text")).toBe(
      "Issue: https://github.com/NEXTAltair/style-bert-vits2-bridge/issues/64",
    );
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
        currentOverrides: {
          styleWeight: 0.65,
          sdpRatio: 0.15,
          sdp_ratio: 0.2,
          noise: 0.45,
          noisew: 0.55,
          noise_w: 0.6,
        },
      }),
    ).toEqual({
      handled: true,
      overrides: {
        style: "01_Happy",
        styleWeight: 0.65,
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

  it("maps Talk snake_case voice fields, WPM rate, and user-facing style settings", () => {
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
