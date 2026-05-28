import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sbv2Client } from "./sbv2-client.js";

const wavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // chunk size
  0x57, 0x41, 0x56, 0x45, // "WAVE"
]);

describe("Sbv2Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls POST /voice with correct query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await client.synthesize({
      text: "こんにちは",
      speakerId: 1,
      style: "Neutral",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/voice");
    expect(url.searchParams.get("text")).toBe("こんにちは");
    expect(url.searchParams.get("speaker_id")).toBe("1");
    expect(url.searchParams.get("style")).toBe("Neutral");
  });

  it("returns a Buffer of audio data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(wavBytes.buffer),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    const result = await client.synthesize({ text: "テスト" });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.slice(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("maps camelCase params to snake_case query keys", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await client.synthesize({
      text: "テスト",
      modelName: "my-model",
      speakerName: "speaker-A",
      sdpRatio: 0.3,
      assistText: "嬉しい",
      assistTextWeight: 0.8,
      autoSplit: true,
      splitInterval: 0.5,
      styleWeight: 0.7,
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("model_name")).toBe("my-model");
    expect(url.searchParams.get("speaker_name")).toBe("speaker-A");
    expect(url.searchParams.get("sdp_ratio")).toBe("0.3");
    expect(url.searchParams.get("assist_text")).toBe("嬉しい");
    expect(url.searchParams.get("assist_text_weight")).toBe("0.8");
    expect(url.searchParams.get("auto_split")).toBe("true");
    expect(url.searchParams.get("split_interval")).toBe("0.5");
    expect(url.searchParams.get("style_weight")).toBe("0.7");
  });

  it("omits undefined/null params from query string", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await client.synthesize({ text: "テスト" });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("speaker_id")).toBe(false);
    expect(url.searchParams.has("model_name")).toBe(false);
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: () => Promise.resolve("validation error"),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.synthesize({ text: "" })).rejects.toThrow(
      /SBV2 \/voice failed: 422/,
    );
  });

  it("strips trailing slashes from baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(wavBytes.buffer),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000///" });
    await client.synthesize({ text: "テスト" });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.origin).toBe("http://localhost:5000");
  });

  it("fetches models info from SBV2", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          valentina01_bright: {
            id: 2,
            spk2id: { valentina01_bright: 0 },
            id2spk: { "0": "valentina01_bright" },
            style2id: { "00_Neutral": 0 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    const result = await client.getModelsInfo();

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/models/info");
    expect(result).toEqual([
      {
        sourceId: "valentina01_bright",
        name: "valentina01_bright",
        id: 2,
        spk2id: { valentina01_bright: 0 },
        id2spk: { "0": "valentina01_bright" },
        style2id: { "00_Neutral": 0 },
      },
    ]);
  });

  it("preserves numeric models info keys as ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            "2": {
              config_path: "model_assets/valentina01_bright/config.json",
              spk2id: { valentina01_bright: 0 },
            },
          }),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.getModelsInfo()).resolves.toEqual([
      {
        sourceId: "2",
        id: 2,
        config_path: "model_assets/valentina01_bright/config.json",
        spk2id: { valentina01_bright: 0 },
      },
    ]);
  });

  it("throws a clear error when models info cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5000")),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.getModelsInfo()).rejects.toThrow(
      /SBV2 \/models\/info request failed: connect ECONNREFUSED/,
    );
  });
});
