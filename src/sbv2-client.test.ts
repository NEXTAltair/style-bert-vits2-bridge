import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sbv2Client, normalizeModelsInfo } from "./sbv2-client.js";

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

  it("rejects successful non-WAV responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode("not audio").buffer),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.synthesize({ text: "テスト" })).rejects.toThrow(
      /SBV2 \/voice returned a non-WAV response/,
    );
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
      /SBV2 \/voice validation failed: 422/,
    );
  });

  it("formats SBV2 validation details for operators", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              detail: [
                { loc: ["query", "model_name"], msg: "model was not found" },
                { loc: ["query", "speaker_name"], msg: "speaker was not found" },
                { loc: ["query", "style"], msg: "style was not found" },
              ],
            }),
          ),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.synthesize({ text: "テスト" })).rejects.toThrow(
      /Validation error: model_name: model was not found; speaker_name: speaker was not found; style: style was not found/,
    );
  });

  it("truncates long SBV2 error bodies", async () => {
    const longBody = `${"x".repeat(600)}secret-tail`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve(longBody),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });

    try {
      await client.synthesize({ text: "テスト" });
      throw new Error("expected synthesize to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("... [truncated]");
      expect(message).not.toContain("secret-tail");
    }
  });

  it("truncates long formatted validation details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: () =>
          Promise.resolve(
            JSON.stringify({
              detail: [{ loc: ["query", "model_name"], msg: `${"x".repeat(600)}secret-tail` }],
            }),
          ),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });

    try {
      await client.synthesize({ text: "テスト" });
      throw new Error("expected synthesize to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("Validation error: model_name:");
      expect(message).toContain("... [truncated]");
      expect(message).not.toContain("secret-tail");
    }
  });

  it("formats plain-text SBV2 validation responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: () => Promise.resolve("model_name is invalid"),
      }),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.synthesize({ text: "テスト" })).rejects.toThrow(
      /SBV2 \/voice validation failed: 422 Unprocessable Entity\. model_name is invalid/,
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

  it("fetches and normalizes /models/info", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          valentina01_bright: {
            id: 2,
            spk2id: { valentina01_bright: 0 },
            id2spk: { "0": "valentina01_bright" },
            style2id: { "00_Neutral": 0, Happy: 1 },
          },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    const result = await client.getModelsInfo();

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/models/info");
    expect(result).toMatchObject([
      {
        sourceId: "valentina01_bright",
        name: "valentina01_bright",
        id: 2,
        speakers: [{ id: 0, name: "valentina01_bright" }],
        styles: [
          { id: 0, name: "00_Neutral" },
          { id: 1, name: "Happy" },
        ],
      },
    ]);
  });

  it("normalizes array-shaped /models/info payloads", () => {
    expect(
      normalizeModelsInfo([
        {
          model_name: "demo",
          speakers: ["alice"],
          styles: [{ name: "Neutral", id: 2 }],
        },
      ]),
    ).toMatchObject([
      {
        name: "demo",
        speakers: [{ id: 0, name: "alice" }],
        styles: [{ id: 2, name: "Neutral" }],
      },
    ]);
  });

  it("preserves numeric models info keys as ids while deriving model names from paths", () => {
    expect(
      normalizeModelsInfo({
        "2": {
          config_path: "model_assets/valentina01_bright/config.json",
          spk2id: { valentina01_bright: 0 },
        },
      }),
    ).toMatchObject([
      {
        sourceId: "2",
        id: 2,
        name: "valentina01_bright",
        speakers: [{ id: 0, name: "valentina01_bright" }],
      },
    ]);
  });

  it("prefers canonical model_name over display names", () => {
    expect(
      normalizeModelsInfo({
        display_key: {
          name: "Pretty Display Name",
          model_name: "canonical-model",
          spk2id: { alice: 0 },
        },
      }),
    ).toMatchObject([
      {
        sourceId: "display_key",
        name: "canonical-model",
        speakers: [{ id: 0, name: "alice" }],
      },
    ]);
  });

  it("normalizes SBV2 spk2id and id2style maps", () => {
    expect(
      normalizeModelsInfo({
        demo: {
          spk2id: { alice: 3 },
          id2style: { "0": "Neutral" },
        },
      }),
    ).toMatchObject([
      {
        name: "demo",
        speakers: [{ id: 3, name: "alice" }],
        styles: [{ id: 0, name: "Neutral" }],
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
      /SBV2 \/models\/info request failed for http:\/\/localhost:5000/,
    );
    await expect(client.getModelsInfo()).rejects.toThrow(
      /Check that the SBV2 API is running and reachable at http:\/\/localhost:5000\/status/,
    );
  });

  it("formats /voice connection failures with baseUrl and status guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5000" },
        }),
      ),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000" });
    await expect(client.synthesize({ text: "テスト" })).rejects.toThrow(
      /SBV2 \/voice request failed for http:\/\/localhost:5000/,
    );
    await expect(client.synthesize({ text: "テスト" })).rejects.toThrow(
      /GET|status|ECONNREFUSED/,
    );
  });

  it("includes timeoutMs when requests time out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation timed out", "TimeoutError")),
    );

    const client = new Sbv2Client({ baseUrl: "http://localhost:5000", timeoutMs: 1234 });
    await expect(client.getModelsInfo()).rejects.toThrow(
      /SBV2 \/models\/info request timed out after 1234ms/,
    );
  });
});
