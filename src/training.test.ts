import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestDataset, type Sbv2AudioProbe } from "./datasets.js";
import {
  createTrainingPlan,
  runTraining,
  type Sbv2TrainingStage,
  type TrainingCommandRunner,
} from "./training.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const probeAudio = async (): Promise<Sbv2AudioProbe> => ({
  durationSec: 1.25,
  codec: "pcm_s16le",
  sampleRate: 44100,
});

function setupSbv2Root(useJpExtra = true): string {
  const sbv2Root = tempRoot("sbv2-training-root-");
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  mkdirSync(path.join(sbv2Root, "Data"), { recursive: true });
  mkdirSync(path.join(sbv2Root, "model_assets"), { recursive: true });
  mkdirSync(path.join(sbv2Root, useJpExtra ? "pretrained_jp_extra" : "pretrained"), { recursive: true });
  writeFileSync(path.join(sbv2Root, useJpExtra ? "pretrained_jp_extra" : "pretrained", "G_0.pth"), "pretrained");
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "dataset_root: Data\nassets_root: model_assets\n");
  writeFileSync(path.join(sbv2Root, "config.yml"), "model_name: old\ndataset_path: old\n");
  writeFileSync(path.join(sbv2Root, "default_config.yml"), "model_name: default\n");
  writeFileSync(
    path.join(sbv2Root, "configs", useJpExtra ? "config_jp_extra.json" : "config.json"),
    JSON.stringify({
      model_name: "Dummy",
      train: {
        batch_size: 2,
        epochs: 1000,
        eval_interval: 1000,
        log_interval: 200,
        freeze_EN_bert: false,
        freeze_JP_bert: false,
        freeze_ZH_bert: false,
        freeze_style: false,
        freeze_decoder: false,
        bf16_run: true,
      },
      data: {
        training_files: "Data/Dummy/train.list",
        validation_files: "Data/Dummy/val.list",
        use_jp_extra: useJpExtra,
      },
    }),
  );
  for (const script of ["resample.py", "preprocess_text.py", "bert_gen.py", "style_gen.py", "train_ms.py", "train_ms_jp_extra.py"]) {
    writeFileSync(path.join(sbv2Root, script), "");
  }
  return sbv2Root;
}

async function createPreparedManifest(useJpExtra = true): Promise<{
  manifestPath: string;
  sbv2Root: string;
  modelName: string;
}> {
  const sbv2Root = setupSbv2Root(useJpExtra);
  const sourceFile = path.join(tempRoot("sbv2-training-source-"), "sample.wav");
  writeFileSync(sourceFile, "audio");
  const modelName = useJpExtra ? "train-jp" : "train-normal";
  const ingested = await ingestDataset({
    datasetsRoot: tempRoot("sbv2-training-datasets-"),
    jobsRoot: tempRoot("sbv2-training-jobs-"),
    sbv2Root,
    modelName,
    sourceAudioPath: sourceFile,
    language: "ja",
    useJpExtra,
    probeAudio,
  });
  mkdirSync(path.join(sbv2Root, "Data", modelName, "raw"), { recursive: true });
  writeFileSync(path.join(sbv2Root, "Data", modelName, "raw", "sample-0.wav"), "audio");
  writeFileSync(path.join(sbv2Root, "Data", modelName, "esd.list"), `sample-0.wav|${modelName}|JP|こんにちは\n`);
  return { manifestPath: ingested.dataset.manifestPath, sbv2Root, modelName };
}

describe("SBV2 training wrapper", () => {
  it("creates a dry-run plan with default stages and JP-Extra commands", async () => {
    const { manifestPath, sbv2Root, modelName } = await createPreparedManifest(true);
    const { plan } = await createTrainingPlan({ manifestPath });

    expect(plan).toMatchObject({
      modelName,
      useJpExtra: true,
      sbv2Root,
      stages: ["initialize", "resample", "preprocess-text", "bert-gen", "style-gen", "train"],
      settings: {
        batchSize: 2,
        epochs: 100,
        saveEverySteps: 1000,
        yomiError: "skip",
      },
    });
    expect(plan.commands.map((command) => command.stage)).toEqual([
      "resample",
      "preprocess-text",
      "bert-gen",
      "style-gen",
      "train",
    ]);
    expect(plan.commands.at(-1)?.args).toContain("train_ms_jp_extra.py");
  });

  it("orders selected stages in the canonical sequence", async () => {
    const { manifestPath } = await createPreparedManifest(false);
    const { plan } = await createTrainingPlan({
      manifestPath,
      stages: ["train", "resample", "preprocess-text"] as Sbv2TrainingStage[],
      settings: { batchSize: 4, yomiError: "use" },
    });

    expect(plan.stages).toEqual(["resample", "preprocess-text", "train"]);
    expect(plan.settings.batchSize).toBe(4);
    expect(plan.commands.at(-1)?.args).toContain("train_ms.py");
    expect(plan.commands.find((command) => command.stage === "preprocess-text")?.args).toContain("use");
  });

  it("runs stages with a mock runner and records a training job", async () => {
    const { manifestPath, sbv2Root, modelName } = await createPreparedManifest(true);
    const calls: string[] = [];
    const runner: TrainingCommandRunner = async (_executable, args, options) => {
      calls.push(options.stage);
      options.onOutput?.("stdout", `${options.stage} progress\n`);
      const datasetPath = path.join(sbv2Root, "Data", modelName);
      if (options.stage === "resample") {
        mkdirSync(path.join(datasetPath, "wavs"), { recursive: true });
      }
      if (options.stage === "preprocess-text") {
        writeFileSync(path.join(datasetPath, "train.list"), "sample-0.wav|x\n");
        writeFileSync(path.join(datasetPath, "val.list"), "");
      }
      if (options.stage === "train") {
        mkdirSync(path.join(sbv2Root, "model_assets", modelName), { recursive: true });
      }
      expect(args[0]).toBe("run");
      return {};
    };

    const result = await runTraining({
      jobsRoot: tempRoot("sbv2-training-jobs-"),
      manifestPath,
      commandRunner: runner,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "training123",
    });

    expect(calls).toEqual(["resample", "preprocess-text", "bert-gen", "style-gen", "train"]);
    expect(result.job).toMatchObject({
      operation: "training-run",
      state: "succeeded",
    });
    expect(readFileSync(result.job.logPath, "utf8")).toContain("stdout: train progress");
    expect(JSON.parse(readFileSync(path.join(result.job.outputDir, "summary.json"), "utf8"))).toEqual(result.plan);
    expect(readFileSync(path.join(sbv2Root, "config.yml"), "utf8")).toContain("model_name: old");
  });

  it("fails preflight when initialize would overwrite training models", async () => {
    const { manifestPath, sbv2Root, modelName } = await createPreparedManifest(true);
    mkdirSync(path.join(sbv2Root, "Data", modelName, "models"), { recursive: true });

    await expect(
      runTraining({
        jobsRoot: tempRoot("sbv2-training-jobs-"),
        manifestPath,
        commandRunner: async () => ({}),
      }),
    ).rejects.toThrow(/Training models directory already exists/);
  });
});
