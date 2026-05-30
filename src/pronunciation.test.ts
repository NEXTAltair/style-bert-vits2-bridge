import { describe, expect, it } from "vitest";
import { applyPronunciationReplacements } from "./pronunciation.js";

describe("pronunciation replacements", () => {
  it("applies configured replacements before synthesis", () => {
    expect(
      applyPronunciationReplacements("SBV2 API test", {
        SBV2: "エスビーブイツー",
        API: "エーピーアイ",
      }),
    ).toBe("エスビーブイツー エーピーアイ test");
  });

  it("prefers longer matches before shorter matches", () => {
    expect(
      applyPronunciationReplacements("HTTPS API", {
        HTTP: "エイチティーティーピー",
        HTTPS: "エイチティーティーピーエス",
        API: "エーピーアイ",
      }),
    ).toBe("エイチティーティーピーエス エーピーアイ");
  });

  it("ignores malformed replacement config", () => {
    expect(applyPronunciationReplacements("SBV2", null)).toBe("SBV2");
    expect(applyPronunciationReplacements("SBV2", { SBV2: 2 })).toBe("SBV2");
  });
});
