import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ingestDataset,
  resolveDatasetsRoot,
  resolveSbv2Root,
  type Sbv2AudioProbe,
} from "./datasets.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const probeAudio = async (): Promise<Sbv2AudioProbe> => ({
  durationSec: 1.25,
  codec: "pcm_s16le",
  sampleRate: 44100,
});

describe("SBV2 dataset ingest", () => {
  it("resolves default dataset and SBV2 roots", () => {
    expect(resolveDatasetsRoot(undefined)).toMatch(
      /\/\.openclaw\/state\/style-bert-vits2-bridge\/datasets$/,
    );
    expect(resolveSbv2Root(undefined)).toMatch(/\/src\/Style-Bert-VITS2$/);
  });

  it("copies a single audio file into a dataset workspace and creates a job", async () => {
    const datasetsRoot = tempRoot("sbv2-datasets-");
    const jobsRoot = tempRoot("sbv2-jobs-");
    const sbv2Root = tempRoot("sbv2-root-");
    const sourceDir = tempRoot("sbv2-source-");
    const sourceFile = path.join(sourceDir, "sample.wav");
    writeFileSync(sourceFile, "audio");

    const result = await ingestDataset({
      datasetsRoot,
      jobsRoot,
      sbv2Root,
      modelName: "voice01",
      sourceAudioPath: sourceFile,
      language: "ja",
      useJpExtra: true,
      probeAudio,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "abcdef123456",
    });

    expect(result.dataset).toMatchObject({
      workspaceId: "sbv2-dataset-20260601000000-abcdef12",
      modelName: "voice01",
      language: "ja",
      useJpExtra: true,
      styleMode: "neutral",
      productionDefaults: {
        transcriptionBackend: "hf-whisper",
        transcriptionModel: "litagin/anime-whisper",
        yomiError: "skip",
        notUseCustomBatchSampler: false,
      },
    });
    expect(result.dataset.files).toHaveLength(1);
    expect(result.dataset.files[0]).toMatchObject({
      relativePath: "sample.wav",
      extension: ".wav",
      sizeBytes: 5,
      codec: "pcm_s16le",
      sampleRate: 44100,
      durationSec: 1.25,
    });
    expect(readFileSync(result.dataset.files[0].storedPath, "utf8")).toBe("audio");
    expect(JSON.parse(readFileSync(result.dataset.manifestPath, "utf8"))).toEqual(
      result.dataset,
    );
    expect(result.job).toMatchObject({
      operation: "dataset-ingest",
      state: "succeeded",
      artifactPaths: [result.dataset.manifestPath],
      inputSummary: {
        workspaceId: result.dataset.workspaceId,
        modelName: "voice01",
      },
    });
  });

  it("preserves directory structure and records style groups when two style dirs exist", async () => {
    const datasetsRoot = tempRoot("sbv2-datasets-");
    const jobsRoot = tempRoot("sbv2-jobs-");
    const sbv2Root = tempRoot("sbv2-root-");
    const sourceDir = tempRoot("sbv2-source-");
    mkdirSync(path.join(sourceDir, "happy"), { recursive: true });
    mkdirSync(path.join(sourceDir, "sad"), { recursive: true });
    writeFileSync(path.join(sourceDir, "happy", "a.wav"), "a");
    writeFileSync(path.join(sourceDir, "sad", "b.mp3"), "b");

    const result = await ingestDataset({
      datasetsRoot,
      jobsRoot,
      sbv2Root,
      modelName: "voice-style",
      sourceAudioPath: sourceDir,
      language: "ja",
      useJpExtra: false,
      probeAudio,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "style123",
    });

    expect(result.dataset.styleMode).toBe("directory");
    expect(result.dataset.styleGroups).toEqual([
      {
        styleName: "happy",
        relativeDir: "happy",
        fileCount: 1,
        files: ["happy/a.wav"],
      },
      {
        styleName: "sad",
        relativeDir: "sad",
        fileCount: 1,
        files: ["sad/b.mp3"],
      },
    ]);
    expect(existsSync(path.join(result.dataset.originalsDir, "happy", "a.wav"))).toBe(true);
    expect(existsSync(path.join(result.dataset.originalsDir, "sad", "b.mp3"))).toBe(true);
  });

  it("keeps neutral style mode for a single subdirectory", async () => {
    const sourceDir = tempRoot("sbv2-source-");
    mkdirSync(path.join(sourceDir, "only"), { recursive: true });
    writeFileSync(path.join(sourceDir, "only", "a.wav"), "a");

    const result = await ingestDataset({
      datasetsRoot: tempRoot("sbv2-datasets-"),
      jobsRoot: tempRoot("sbv2-jobs-"),
      sbv2Root: tempRoot("sbv2-root-"),
      modelName: "neutral-style",
      sourceAudioPath: sourceDir,
      language: "ja",
      useJpExtra: true,
      probeAudio,
    });

    expect(result.dataset.styleMode).toBe("neutral");
    expect(result.dataset.styleGroups).toEqual([]);
  });

  it("rejects invalid input and SBV2 path collisions", async () => {
    await expect(
      ingestDataset({
        datasetsRoot: tempRoot("sbv2-datasets-"),
        jobsRoot: tempRoot("sbv2-jobs-"),
        sbv2Root: tempRoot("sbv2-root-"),
        modelName: "../escape",
        sourceAudioPath: tempRoot("sbv2-source-"),
        language: "ja",
        useJpExtra: true,
      }),
    ).rejects.toThrow(/Invalid SBV2 model name/);

    const unsupported = path.join(tempRoot("sbv2-source-"), "sample.txt");
    writeFileSync(unsupported, "text");
    await expect(
      ingestDataset({
        datasetsRoot: tempRoot("sbv2-datasets-"),
        jobsRoot: tempRoot("sbv2-jobs-"),
        sbv2Root: tempRoot("sbv2-root-"),
        modelName: "unsupported",
        sourceAudioPath: unsupported,
        language: "ja",
        useJpExtra: true,
      }),
    ).rejects.toThrow(/Unsupported audio file extension/);

    const sbv2Root = tempRoot("sbv2-root-");
    mkdirSync(path.join(sbv2Root, "Data", "collision"), { recursive: true });
    const audio = path.join(tempRoot("sbv2-source-"), "sample.wav");
    writeFileSync(audio, "audio");
    await expect(
      ingestDataset({
        datasetsRoot: tempRoot("sbv2-datasets-"),
        jobsRoot: tempRoot("sbv2-jobs-"),
        sbv2Root,
        modelName: "collision",
        sourceAudioPath: audio,
        language: "ja",
        useJpExtra: true,
      }),
    ).rejects.toThrow(/SBV2 dataset already exists/);
  });

  it("records ffprobe warnings without failing ingest", async () => {
    const sourceFile = path.join(tempRoot("sbv2-source-"), "sample.wav");
    writeFileSync(sourceFile, "audio");
    const result = await ingestDataset({
      datasetsRoot: tempRoot("sbv2-datasets-"),
      jobsRoot: tempRoot("sbv2-jobs-"),
      sbv2Root: tempRoot("sbv2-root-"),
      modelName: "probe-warning",
      sourceAudioPath: sourceFile,
      language: "ja",
      useJpExtra: true,
      probeAudio: async () => ({ warning: "ffprobe failed: not found" }),
    });

    expect(result.dataset.warnings).toEqual(["sample.wav: ffprobe failed: not found"]);
    expect(result.dataset.files[0].probeWarning).toBe("ffprobe failed: not found");
  });
});
