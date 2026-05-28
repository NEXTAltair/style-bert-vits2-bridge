import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (options: unknown) => options,
}));

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x24, 0x00, 0x00, 0x00,
  0x57, 0x41, 0x56, 0x45,
]);

describe("Style-Bert-VITS2 provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves voice params before calling /voice", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            valentina01_bright: {
              speaker2id: { valentina01_bright: 0 },
              style2id: { "00_Neutral": 0 },
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { buildSbv2SpeechProvider } = await import("./index.js");
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

  it("merges parsed directive overrides with current overrides", async () => {
    const { buildSbv2SpeechProvider } = await import("./index.js");
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

  it("lists voices from /models/info", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            demo: {
              speaker2id: { alice: 0 },
              style2id: { Neutral: 0 },
            },
          }),
      }),
    );

    const { buildSbv2SpeechProvider } = await import("./index.js");
    const provider = buildSbv2SpeechProvider();

    await expect(
      provider.listVoices?.({
        providerConfig: { baseUrl: "http://localhost:5000" },
      }),
    ).resolves.toEqual([{ id: "demo:alice", name: "alice (demo)" }]);
  });
});
