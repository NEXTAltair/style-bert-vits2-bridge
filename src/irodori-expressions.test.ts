import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildIrodoriExpressionPrompt, isIrodoriModel, IRODORI_ANNOTATIONS,
  IRODORI_EXPRESSIONS, IRODORI_UNDOCUMENTED_ANNOTATIONS,
  type IrodoriExpressionContext,
} from "./irodori-expressions.js";

const context: IrodoriExpressionContext = {
  provider: "irodori", auto: "always", allowText: true, maxLength: 400, speechEligible: true,
};

describe("Irodori expression catalog", () => {
  it("keeps all 45 documented and 11 undocumented Unicode annotations distinct", () => {
    expect(IRODORI_EXPRESSIONS).toHaveLength(45);
    expect(IRODORI_UNDOCUMENTED_ANNOTATIONS).toHaveLength(11);
    expect(new Set(IRODORI_ANNOTATIONS).size).toBe(56);
    expect(IRODORI_ANNOTATIONS).toContain("😮\u200d💨");
    expect(IRODORI_ANNOTATIONS).toContain("⏸\ufe0f");
    const reference = readFileSync(new URL("../skills/irodori-production/references/emoji-controls.md", import.meta.url), "utf8");
    const rows = [...reference.matchAll(/^\| ([^|]+) \| ([^|]+) \|$/gm)]
      .filter((m) => /\p{Extended_Pictographic}/u.test(m[1]) && !m[1].includes("`")).map((m) => m[1].trim());
    expect(new Set(rows)).toEqual(new Set(IRODORI_ANNOTATIONS));
  });

  it("gives the model every documented choice without inventing the other meanings", () => {
    const prompt = buildIrodoriExpressionPrompt(context)!;
    for (const [emoji, meaning] of IRODORI_EXPRESSIONS) expect(prompt).toContain(`${emoji}: ${meaning}`);
    for (const emoji of IRODORI_UNDOCUMENTED_ANNOTATIONS) expect(prompt).not.toContain(`${emoji}:`);
    expect(prompt).toContain("within 400 characters");
    expect(prompt).toContain("[[tts:text]]");
    expect(prompt).toContain("Preserve the spoken wording");
  });

  it.each(["irodori-tts", "irodori-tts-mf", "irodori-tts-large", "irodori-tts:q8_0",
    "Aratako/Irodori-TTS-v4.1-Small", "Irodori-TTS-v4.1-Small-MF", "Irodori-TTS-v4-Large",
    "Irodori-TTS-859M-v4.1-F16.gguf", "Irodori-TTS-866M-MF-v4.1-Q8_0.gguf"])("recognizes %s", (model) => {
    expect(isIrodoriModel(model)).toBe(true);
    expect(buildIrodoriExpressionPrompt({ ...context, provider: "speech-cpp", model })).toBeDefined();
  });

  it.each([undefined, "", "qwen3-tts-1.7b", "qwen-irodori-tts", "other", "irodori-tts-unknown", "Irodori-TTS-v99-Small"])("fails closed for unknown speech.cpp model %s", (model) => {
    expect(isIrodoriModel(model)).toBe(false);
    expect(buildIrodoriExpressionPrompt({ ...context, provider: "speech-cpp", model })).toBeUndefined();
  });

  it.each([
    { provider: "style-bert-vits2" }, { provider: "qwen" }, { model: "qwen3-tts-1.7b" },
    { auto: "off" as const }, { speechEligible: false }, { allowText: false }, { maxLength: NaN },
  ])("does not grant speech authorization or cross model boundaries: %j", (patch) => {
    expect(buildIrodoriExpressionPrompt({ ...context, ...patch })).toBeUndefined();
  });

  it("keeps tagged-mode selection explicit rather than triggering every reply", () => {
    expect(buildIrodoriExpressionPrompt({ ...context, auto: "tagged" })).toContain("never merely because this guide is present");
  });

  it("uses structured voiceText where the host requires it", () => {
    const prompt = buildIrodoriExpressionPrompt({ ...context, structuredDelivery: true })!;
    expect(prompt).toContain("voiceText");
    expect(prompt).not.toContain("[[tts:text]]");
  });
});
