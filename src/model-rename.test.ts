import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelRenamePlan, runModelRename } from "./model-rename.js";

const originalFetch = globalThis.fetch;

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createSbv2Root(): string {
  const sbv2Root = tempRoot("sbv2-model-rename-root-");
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "dataset_root: Data\nassets_root: model_assets\n");
  return sbv2Root;
}

function writeModelAssets(sbv2Root: string, modelName: string): string {
  const modelDir = path.join(sbv2Root, "model_assets", modelName);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeConfig(modelName)));
  writeFileSync(path.join(modelDir, "style_vectors.npy"), "style vectors");
  writeFileSync(path.join(modelDir, `${modelName}_e1_s100.safetensors`), "weights");
  return modelDir;
}

function makeConfig(modelName: string): Record<string, unknown> {
  return {
    model_name: modelName,
    model: {},
    train: {},
    data: {
      n_speakers: 1,
      num_styles: 1,
      spk2id: { [modelName]: 0 },
      id2spk: { "0": modelName },
      style2id: { Neutral: 0 },
    },
  };
}

describe("SBV2 model rename", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("plans directory and config changes while keeping safetensors filenames", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "old-voice");

    const plan = await createModelRenamePlan({
      sbv2Root,
      fromModelName: "old-voice",
      toModelName: "new-voice",
    });

    expect(plan.compatibility.compatible).toBe(true);
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        { kind: "path-move", from: path.join(sbv2Root, "model_assets", "old-voice"), to: path.join(sbv2Root, "model_assets", "new-voice") },
        expect.objectContaining({ kind: "json-field", jsonPath: "model_name" }),
        expect.objectContaining({ kind: "json-field", jsonPath: "data.spk2id" }),
        expect.objectContaining({ kind: "json-field", jsonPath: "data.id2spk" }),
      ]),
    );
    expect(plan.safetensorsKept).toEqual([path.join(sbv2Root, "model_assets", "old-voice", "old-voice_e1_s100.safetensors")]);
    expect(plan.compatibility.warnings.join("\n")).toContain("safetensors filename contains the old model name");
  });

  it("renames model assets and config without renaming safetensors or styles", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-rename-jobs-");
    writeModelAssets(sbv2Root, "old-voice");

    const result = await runModelRename({
      sbv2Root,
      jobsRoot,
      fromModelName: "old-voice",
      toModelName: "new-voice",
      confirmToModelName: "new-voice",
      now: () => new Date("2026-06-03T00:00:00.000Z"),
      randomId: () => "abcdef12",
    });

    const oldDir = path.join(sbv2Root, "model_assets", "old-voice");
    const newDir = path.join(sbv2Root, "model_assets", "new-voice");
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(path.join(newDir, "old-voice_e1_s100.safetensors"))).toBe(true);
    const config = JSON.parse(readFileSync(path.join(newDir, "config.json"), "utf8")) as {
      model_name: string;
      data: { spk2id: Record<string, number>; id2spk: Record<string, string>; style2id: Record<string, number> };
    };
    expect(config.model_name).toBe("new-voice");
    expect(config.data.spk2id).toEqual({ "new-voice": 0 });
    expect(config.data.id2spk).toEqual({ "0": "new-voice" });
    expect(config.data.style2id).toEqual({ Neutral: 0 });
    expect(readFileSync(path.join(newDir, "style_vectors.npy"), "utf8")).toBe("style vectors");
    expect(result.job).toMatchObject({ operation: "model-rename", state: "succeeded" });
    expect(readFileSync(path.join(result.job.outputDir, "summary.json"), "utf8")).toContain('"toModelName": "new-voice"');
  });

  it("moves Data and optionally rewrites exact esd.list speaker fields", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "old-voice");
    const dataDir = path.join(sbv2Root, "Data", "old-voice");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "esd.list"),
      ["wavs/a.wav|old-voice|JP|hello", "wavs/b.wav|other-speaker|JP|hello"].join("\n") + "\n",
    );

    await runModelRename({
      sbv2Root,
      jobsRoot: tempRoot("sbv2-model-rename-jobs-"),
      fromModelName: "old-voice",
      toModelName: "new-voice",
      confirmToModelName: "new-voice",
      includeData: true,
      renameEsdSpeaker: true,
    });

    const newDataDir = path.join(sbv2Root, "Data", "new-voice");
    expect(existsSync(path.join(sbv2Root, "Data", "old-voice"))).toBe(false);
    expect(readFileSync(path.join(newDataDir, "esd.list"), "utf8")).toBe(
      ["wavs/a.wav|new-voice|JP|hello", "wavs/b.wav|other-speaker|JP|hello"].join("\n") + "\n",
    );
  });

  it("reports incompatible target and config mismatches", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "old-voice");
    writeModelAssets(sbv2Root, "new-voice");
    writeFileSync(path.join(sbv2Root, "model_assets", "old-voice", "config.json"), JSON.stringify(makeConfig("different")));

    const plan = await createModelRenamePlan({
      sbv2Root,
      fromModelName: "old-voice",
      toModelName: "new-voice",
    });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors.join("\n")).toContain("target model assets already exist");
    expect(plan.compatibility.errors.join("\n")).toContain('config.json model_name "different" does not match "old-voice"');
  });

  it("requires at least one top-level non-empty safetensors file", async () => {
    const sbv2Root = createSbv2Root();
    const modelDir = writeModelAssets(sbv2Root, "old-voice");
    writeFileSync(path.join(modelDir, "old-voice_e1_s100.safetensors"), "");

    const plan = await createModelRenamePlan({
      sbv2Root,
      fromModelName: "old-voice",
      toModelName: "new-voice",
    });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors).toContain(`no non-empty .safetensors files were found in ${modelDir}`);
  });

  it("rejects target speaker name collisions before rewriting config maps", async () => {
    const sbv2Root = createSbv2Root();
    const modelDir = writeModelAssets(sbv2Root, "old-voice");
    writeFileSync(
      path.join(modelDir, "config.json"),
      JSON.stringify({
        ...makeConfig("old-voice"),
        data: {
          n_speakers: 2,
          num_styles: 1,
          spk2id: { "old-voice": 0, "new-voice": 1 },
          id2spk: { "0": "old-voice", "1": "new-voice" },
          style2id: { Neutral: 0 },
        },
      }),
    );

    const plan = await createModelRenamePlan({
      sbv2Root,
      fromModelName: "old-voice",
      toModelName: "new-voice",
    });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors).toContain('config.json data.spk2id already contains target speaker "new-voice"');
    expect(plan.compatibility.errors).toContain('config.json data.id2spk already contains target speaker "new-voice"');
  });

  it("does not publish dataset artifacts when includeData is set but Data source is absent", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "old-voice");

    const result = await runModelRename({
      sbv2Root,
      jobsRoot: tempRoot("sbv2-model-rename-jobs-"),
      fromModelName: "old-voice",
      toModelName: "new-voice",
      confirmToModelName: "new-voice",
      includeData: true,
    });

    expect(result.plan.compatibility.warnings.join("\n")).toContain("dataset directory was not found");
    expect(result.job.artifactPaths).not.toContain(path.join(sbv2Root, "Data", "new-voice"));
  });

  it("rejects includeData when Data source is not a directory", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "old-voice");
    mkdirSync(path.join(sbv2Root, "Data"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "Data", "old-voice"), "not a directory");

    const plan = await createModelRenamePlan({
      sbv2Root,
      fromModelName: "old-voice",
      toModelName: "new-voice",
      includeData: true,
    });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors).toContain(`source dataset path is not a directory: ${path.join(sbv2Root, "Data", "old-voice")}`);
  });

  it("does not publish esd.list when renameEsdSpeaker is requested but esd.list is absent", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "old-voice");
    mkdirSync(path.join(sbv2Root, "Data", "old-voice"), { recursive: true });

    const result = await runModelRename({
      sbv2Root,
      jobsRoot: tempRoot("sbv2-model-rename-jobs-"),
      fromModelName: "old-voice",
      toModelName: "new-voice",
      confirmToModelName: "new-voice",
      includeData: true,
      renameEsdSpeaker: true,
    });

    expect(result.job.artifactPaths).toContain(path.join(sbv2Root, "Data", "new-voice"));
    expect(result.job.artifactPaths).not.toContain(path.join(sbv2Root, "Data", "new-voice", "esd.list"));
  });

  it("keeps renamed assets when refresh verification fails", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-rename-jobs-");
    writeModelAssets(sbv2Root, "old-voice");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: [{ model_name: "old-voice" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await expect(
        runModelRename({
          sbv2Root,
          jobsRoot,
          fromModelName: "old-voice",
          toModelName: "new-voice",
          confirmToModelName: "new-voice",
          baseUrl: "http://localhost:5000",
          now: () => new Date("2026-06-03T00:00:00.000Z"),
          randomId: () => "refreshfail",
        }),
      ).rejects.toThrow("refresh verification failed");
      expect(existsSync(path.join(sbv2Root, "model_assets", "new-voice"))).toBe(true);
      expect(existsSync(path.join(sbv2Root, "model_assets", "old-voice"))).toBe(false);
      const jobDir = path.join(jobsRoot, "sbv2-job-20260603000000-refreshf");
      const manifest = JSON.parse(readFileSync(path.join(jobDir, "manifest.json"), "utf8")) as {
        state: string;
        inputSummary: { outputAssetsRetained?: boolean; refresh?: { foundNewInModelsInfo?: boolean; foundOldInModelsInfo?: boolean } };
      };
      expect(manifest.state).toBe("failed");
      expect(manifest.inputSummary.outputAssetsRetained).toBe(true);
      expect(manifest.inputSummary.refresh).toMatchObject({
        foundNewInModelsInfo: false,
        foundOldInModelsInfo: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rolls back asset and config changes when a later file update fails", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-rename-jobs-");
    writeModelAssets(sbv2Root, "old-voice");
    const dataDir = path.join(sbv2Root, "Data", "old-voice");
    mkdirSync(dataDir, { recursive: true });
    const esdPath = path.join(dataDir, "esd.list");
    writeFileSync(esdPath, "wavs/a.wav|old-voice|JP|hello\n");
    chmodSync(esdPath, 0o400);

    try {
      await expect(
        runModelRename({
          sbv2Root,
          jobsRoot,
          fromModelName: "old-voice",
          toModelName: "new-voice",
          confirmToModelName: "new-voice",
          includeData: true,
          renameEsdSpeaker: true,
          now: () => new Date("2026-06-03T00:00:00.000Z"),
          randomId: () => "rollback1",
        }),
      ).rejects.toThrow();
    } finally {
      const oldEsdPath = path.join(sbv2Root, "Data", "old-voice", "esd.list");
      const newEsdPath = path.join(sbv2Root, "Data", "new-voice", "esd.list");
      if (existsSync(oldEsdPath)) chmodSync(oldEsdPath, 0o600);
      if (existsSync(newEsdPath)) chmodSync(newEsdPath, 0o600);
    }

    const oldDir = path.join(sbv2Root, "model_assets", "old-voice");
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(path.join(sbv2Root, "model_assets", "new-voice"))).toBe(false);
    const config = JSON.parse(readFileSync(path.join(oldDir, "config.json"), "utf8")) as { model_name: string };
    expect(config.model_name).toBe("old-voice");
    const manifest = JSON.parse(readFileSync(path.join(jobsRoot, "sbv2-job-20260603000000-rollback", "manifest.json"), "utf8")) as {
      state: string;
      inputSummary: { outputAssetsRetained?: boolean };
    };
    expect(manifest.state).toBe("failed");
    expect(manifest.inputSummary.outputAssetsRetained).toBe(false);
  });
});
