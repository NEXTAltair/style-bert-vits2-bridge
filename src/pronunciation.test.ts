import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyPronunciationReplacements,
  loadPronunciationReplacements,
  resolvePronunciationReplacements,
} from "./pronunciation.js";

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

  it("loads replacements from an external JSON dictionary", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sbv2-pronunciation-"));
    const file = path.join(dir, "dict.json");
    writeFileSync(file, JSON.stringify({ SBV2: "エスビーブイツー" }));

    expect(loadPronunciationReplacements(file)).toEqual({
      SBV2: "エスビーブイツー",
    });
  });

  it("lets inline replacements override file replacements", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sbv2-pronunciation-"));
    const file = path.join(dir, "dict.json");
    writeFileSync(file, JSON.stringify({ API: "エーピーアイ", SBV2: "old" }));

    expect(
      resolvePronunciationReplacements({
        pronunciationReplacementsPath: file,
        pronunciationReplacements: { SBV2: "エスビーブイツー" },
      }),
    ).toEqual({
      API: "エーピーアイ",
      SBV2: "エスビーブイツー",
    });
  });
});
