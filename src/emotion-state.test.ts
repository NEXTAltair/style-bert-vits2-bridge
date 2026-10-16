import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEmotionStateSelection } from "./emotion-state.js";

describe("resolveEmotionStateSelection", () => {
  it("maps an exact Soul-in-Sapphire mood to a safe voice profile", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbv2-emotion-"));
    const statePath = path.join(dir, "now-state.json");
    await writeFile(statePath, JSON.stringify({ mood: "clear" }));

    await expect(resolveEmotionStateSelection({
      emotionStatePath: statePath,
      emotionProfiles: {
        clear: {
          modelName: "expressive",
          speakerName: "expressive",
          style: "00_Neutral",
          styleWeight: 0.8,
          ignored: "no",
        },
      },
    })).resolves.toEqual({
      mood: "clear",
      profileName: "clear",
      overrides: {
        modelName: "expressive",
        speakerName: "expressive",
        style: "00_Neutral",
        styleWeight: 0.8,
      },
    });
  });

  it("supports descriptive moods and a default profile", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbv2-emotion-"));
    const statePath = path.join(dir, "now-state.json");
    await writeFile(statePath, JSON.stringify({ mood: "quietly happy and relieved" }));
    const config = {
      emotionStatePath: statePath,
      emotionProfiles: {
        happy: { style: "00_Happy" },
        default: { style: "Neutral" },
      },
    };

    await expect(resolveEmotionStateSelection(config)).resolves.toMatchObject({
      profileName: "happy",
      overrides: { style: "00_Happy" },
    });

    await writeFile(statePath, JSON.stringify({ mood: "unclassified" }));
    await expect(resolveEmotionStateSelection(config)).resolves.toMatchObject({
      profileName: "default",
      overrides: { style: "Neutral" },
    });
  });
});
