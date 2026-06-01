import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ingestDataset,
  prepareDataset,
  resolveDatasetsRoot,
  resolveSbv2Root,
  type Sbv2AudioProbe,
  type PrepareDatasetCommandRunner,
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

  it("runs SBV2 slice and transcription commands for an ingested manifest", async () => {
    const datasetsRoot = tempRoot("sbv2-datasets-");
    const jobsRoot = tempRoot("sbv2-jobs-");
    const sbv2Root = tempRoot("sbv2-root-");
    writeFileSync(path.join(sbv2Root, "slice.py"), "");
    writeFileSync(path.join(sbv2Root, "transcribe.py"), "");
    const sourceDir = tempRoot("sbv2-source-");
    mkdirSync(path.join(sourceDir, "happy"), { recursive: true });
    mkdirSync(path.join(sourceDir, "sad"), { recursive: true });
    writeFileSync(path.join(sourceDir, "happy", "a.wav"), "a");
    writeFileSync(path.join(sourceDir, "sad", "b.wav"), "b");
    const ingested = await ingestDataset({
      datasetsRoot,
      jobsRoot,
      sbv2Root,
      modelName: "prepare-voice",
      sourceAudioPath: sourceDir,
      language: "ja",
      useJpExtra: true,
      probeAudio,
    });
    const calls: { executable: string; args: string[]; cwd: string }[] = [];
    const runner: PrepareDatasetCommandRunner = async (executable, args, options) => {
      calls.push({ executable, args, cwd: options.cwd });
      if (args.includes("slice.py")) {
        mkdirSync(path.join(sbv2Root, "Data", "prepare-voice", "raw", "happy"), { recursive: true });
        mkdirSync(path.join(sbv2Root, "Data", "prepare-voice", "raw", "sad"), { recursive: true });
        writeFileSync(path.join(sbv2Root, "Data", "prepare-voice", "raw", "happy", "a-0.wav"), "a");
        writeFileSync(path.join(sbv2Root, "Data", "prepare-voice", "raw", "sad", "b-0.wav"), "b");
      }
      if (args.includes("transcribe.py")) {
        writeFileSync(
          path.join(sbv2Root, "Data", "prepare-voice", "esd.list"),
          ["happy/a-0.wav|prepare-voice|JP|こんにちは", "sad/b-0.wav|prepare-voice|JP|おやすみ", ""].join("\n"),
        );
      }
      return { stdout: "ok" };
    };

    const result = await prepareDataset({
      jobsRoot,
      manifestPath: ingested.dataset.manifestPath,
      commandRunner: runner,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "prepare123",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      executable: "uv",
      cwd: sbv2Root,
    });
    expect(calls[0].args).toEqual(
      expect.arrayContaining([
        "run",
        "python",
        "slice.py",
        "--model_name",
        "prepare-voice",
        "--input_dir",
        ingested.dataset.originalsDir,
        "--min_sec",
        "2",
        "--max_sec",
        "12",
        "--min_silence_dur_ms",
        "700",
      ]),
    );
    expect(calls[1].args).toEqual(
      expect.arrayContaining([
        "transcribe.py",
        "--language",
        "ja",
        "--initial_prompt",
        "",
        "--use_hf_whisper",
        "--hf_repo_id",
        "litagin/anime-whisper",
        "--batch_size",
        "16",
      ]),
    );
    expect(result.summary).toMatchObject({
      workspaceId: ingested.dataset.workspaceId,
      modelName: "prepare-voice",
      rawWavCount: 2,
      esdLineCount: 2,
      missingAudioReferences: [],
      untranscribedWavs: [],
    });
    expect(result.summary.styleGroups.map((group) => group.styleName)).toEqual(["happy", "sad"]);
    expect(result.job).toMatchObject({
      operation: "dataset-prepare",
      state: "succeeded",
    });
    expect(result.job.artifactPaths).toContain(path.join(result.job.outputDir, "summary.json"));
    expect(JSON.parse(readFileSync(path.join(result.job.outputDir, "summary.json"), "utf8"))).toEqual(
      result.summary,
    );
  });

  it("rejects prepare when SBV2 output paths already exist", async () => {
    const sbv2Root = tempRoot("sbv2-root-");
    writeFileSync(path.join(sbv2Root, "slice.py"), "");
    writeFileSync(path.join(sbv2Root, "transcribe.py"), "");
    const sourceFile = path.join(tempRoot("sbv2-source-"), "sample.wav");
    writeFileSync(sourceFile, "audio");
    const ingested = await ingestDataset({
      datasetsRoot: tempRoot("sbv2-datasets-"),
      jobsRoot: tempRoot("sbv2-jobs-"),
      sbv2Root,
      modelName: "collision-prepare",
      sourceAudioPath: sourceFile,
      language: "ja",
      useJpExtra: true,
      probeAudio,
    });
    mkdirSync(path.join(sbv2Root, "Data", "collision-prepare", "raw"), { recursive: true });

    await expect(
      prepareDataset({
        jobsRoot: tempRoot("sbv2-jobs-"),
        manifestPath: ingested.dataset.manifestPath,
        commandRunner: async () => ({ stdout: "not reached" }),
      }),
    ).rejects.toThrow(/SBV2 raw dataset already exists/);
  });

  it("summarizes esd.list mismatches as warnings", async () => {
    const sbv2Root = tempRoot("sbv2-root-");
    writeFileSync(path.join(sbv2Root, "slice.py"), "");
    writeFileSync(path.join(sbv2Root, "transcribe.py"), "");
    const sourceFile = path.join(tempRoot("sbv2-source-"), "sample.wav");
    writeFileSync(sourceFile, "audio");
    const ingested = await ingestDataset({
      datasetsRoot: tempRoot("sbv2-datasets-"),
      jobsRoot: tempRoot("sbv2-jobs-"),
      sbv2Root,
      modelName: "warning-prepare",
      sourceAudioPath: sourceFile,
      language: "ja",
      useJpExtra: true,
      probeAudio,
    });
    const runner: PrepareDatasetCommandRunner = async (_executable, args) => {
      if (args.includes("slice.py")) {
        mkdirSync(path.join(sbv2Root, "Data", "warning-prepare", "raw"), { recursive: true });
        writeFileSync(path.join(sbv2Root, "Data", "warning-prepare", "raw", "sample-0.wav"), "a");
        writeFileSync(path.join(sbv2Root, "Data", "warning-prepare", "raw", "sample-1.wav"), "b");
      }
      if (args.includes("transcribe.py")) {
        writeFileSync(
          path.join(sbv2Root, "Data", "warning-prepare", "esd.list"),
          "missing.wav|wrong-speaker|EN|\n",
        );
      }
      return {};
    };

    const result = await prepareDataset({
      jobsRoot: tempRoot("sbv2-jobs-"),
      manifestPath: ingested.dataset.manifestPath,
      commandRunner: runner,
    });

    expect(result.summary.missingAudioReferences).toEqual(["missing.wav"]);
    expect(result.summary.untranscribedWavs).toEqual(["sample-0.wav", "sample-1.wav"]);
    expect(result.summary.warnings.join("\n")).toContain("speaker is wrong-speaker");
    expect(result.summary.warnings.join("\n")).toContain("language is EN, expected JP");
    expect(result.summary.warnings.join("\n")).toContain("empty transcription text");
  });
});
