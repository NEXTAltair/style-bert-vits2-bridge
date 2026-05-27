import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import pluginEntry from "./index";

describe("Style-Bert-VITS2 speech provider voices", () => {
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
      { id: "sbv2:amitaro:amitaro", name: "amitaro (amitaro)" },
      {
        id: "sbv2:valentina01_bright:valentina01_bright",
        name: "valentina01_bright (valentina01_bright)",
      },
    ]);
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
