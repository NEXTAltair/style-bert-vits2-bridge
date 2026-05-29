import { describe, expect, it } from "vitest";
import { Sbv2Client } from "./sbv2-client.js";

const baseUrl = process.env.SBV2_BASE_URL?.replace(/\/+$/, "");
const liveBaseUrl = baseUrl ?? "http://127.0.0.1:5000";
const describeLive = baseUrl ? describe : describe.skip;

function expectWav(buffer: Buffer): void {
  expect(buffer.length).toBeGreaterThan(12);
  expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
}

describeLive("SBV2 live smoke", () => {
  const client = new Sbv2Client({ baseUrl: liveBaseUrl, timeoutMs: 30_000 });

  it("reports server status", async () => {
    const response = await fetch(new URL("/status", liveBaseUrl));

    expect(response.ok).toBe(true);
  });

  it("fetches at least one model from /models/info", async () => {
    const models = await client.getModelsInfo();

    expect(models.length).toBeGreaterThan(0);
    expect(models.some((model) => model.name.trim())).toBe(true);
  });

  it("synthesizes a short WAV response", async () => {
    const audio = await client.synthesize({ text: "テストです。", language: "JP" });

    expectWav(audio);
  });

  it("rejects invalid model parameters", async () => {
    await expect(
      client.synthesize({
        text: "テストです。",
        language: "JP",
        modelName: "__openclaw_missing_model__",
      }),
    ).rejects.toThrow(/SBV2 \/voice validation failed|SBV2 \/voice failed|non-WAV response/);
  });
});
