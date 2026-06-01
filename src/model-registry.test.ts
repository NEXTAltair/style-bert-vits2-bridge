import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listModelCandidates, promoteModel } from "./model-registry.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createSbv2Root(modelName = "test-voice"): string {
  const sbv2Root = tempRoot("sbv2-model-registry-root-");
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  mkdirSync(path.join(sbv2Root, "model_assets", modelName), { recursive: true });
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
  return sbv2Root;
}

function writeModelAssets(dir: string, modelName = "test-voice"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ model_name: modelName, data: { spk2id: { [modelName]: 0 }, style2id: { Neutral: 0 } } }),
  );
  writeFileSync(path.join(dir, "style_vectors.npy"), "style");
  writeFileSync(path.join(dir, `${modelName}_e1_s100.safetensors`), "model");
}

describe("SBV2 model registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists a promotable model_assets candidate", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(path.join(sbv2Root, "model_assets", "test-voice"));

    const candidates = await listModelCandidates({ sbv2Root, modelName: "test-voice" });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      modelName: "test-voice",
      promotable: true,
      configModelName: "test-voice",
      errors: [],
    });
    expect(candidates[0].safetensors).toHaveLength(1);
  });

  it("marks missing and empty required files as non-promotable", async () => {
    const sbv2Root = createSbv2Root();
    const modelDir = path.join(sbv2Root, "model_assets", "test-voice");
    writeFileSync(path.join(modelDir, "config.json"), "{}");
    writeFileSync(path.join(modelDir, "style_vectors.npy"), "");

    const [candidate] = await listModelCandidates({ sbv2Root, modelName: "test-voice" });

    expect(candidate.promotable).toBe(false);
    expect(candidate.errors.join("\n")).toContain("style_vectors.npy is missing or empty");
    expect(candidate.errors.join("\n")).toContain("no non-empty .safetensors files");
  });

  it("requires minimal SBV2 config data maps", async () => {
    const sbv2Root = createSbv2Root();
    const modelDir = path.join(sbv2Root, "model_assets", "test-voice");
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({ model_name: "test-voice", data: {} }));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), "style");
    writeFileSync(path.join(modelDir, "test-voice_e1_s100.safetensors"), "model");

    const [candidate] = await listModelCandidates({ sbv2Root, modelName: "test-voice" });

    expect(candidate.promotable).toBe(false);
    expect(candidate.errors).toContain("config.json data.spk2id must be a non-empty object");
    expect(candidate.errors).toContain("config.json data.style2id must be a non-empty object");
  });

  it("requires numeric SBV2 config id map values", async () => {
    const sbv2Root = createSbv2Root();
    const modelDir = path.join(sbv2Root, "model_assets", "test-voice");
    writeFileSync(
      path.join(modelDir, "config.json"),
      JSON.stringify({ model_name: "test-voice", data: { spk2id: { "test-voice": "x" }, style2id: { Neutral: "0" } } }),
    );
    writeFileSync(path.join(modelDir, "style_vectors.npy"), "style");
    writeFileSync(path.join(modelDir, "test-voice_e1_s100.safetensors"), "model");

    const [candidate] = await listModelCandidates({ sbv2Root, modelName: "test-voice" });

    expect(candidate.promotable).toBe(false);
    expect(candidate.errors).toContain("config.json data.spk2id values must be finite numbers");
    expect(candidate.errors).toContain("config.json data.style2id values must be finite numbers");
  });

  it("reports regular file sources as blocked candidates", async () => {
    const sbv2Root = tempRoot("sbv2-model-registry-root-");
    const sourceFile = path.join(tempRoot("sbv2-model-registry-source-"), "candidate.safetensors");
    writeFileSync(sourceFile, "model");

    const [candidate] = await listModelCandidates({
      sbv2Root,
      modelName: "test-voice",
      sourcePath: sourceFile,
    });

    expect(candidate.promotable).toBe(false);
    expect(candidate.errors).toContain(`candidate path is not a directory: ${sourceFile}`);
  });

  it("records a failed job when promotion source is not a directory", async () => {
    const sbv2Root = tempRoot("sbv2-model-registry-root-");
    const jobsRoot = tempRoot("sbv2-model-registry-jobs-");
    const sourceFile = path.join(tempRoot("sbv2-model-registry-source-"), "candidate.safetensors");
    writeFileSync(sourceFile, "model");

    await expect(
      promoteModel({
        sbv2Root,
        modelName: "test-voice",
        sourcePath: sourceFile,
        confirmModelName: "test-voice",
        jobsRoot,
        now: () => new Date("2026-06-01T00:00:00.000Z"),
        randomId: () => "nondir123",
      }),
    ).rejects.toThrow("candidate path is not a directory");

    const manifest = readFileSync(path.join(jobsRoot, "sbv2-job-20260601000000-nondir12", "manifest.json"), "utf8");
    expect(manifest).toContain('"state": "failed"');
  });

  it("rejects config model_name mismatches", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(path.join(sbv2Root, "model_assets", "test-voice"), "other-voice");

    const [candidate] = await listModelCandidates({ sbv2Root, modelName: "test-voice" });

    expect(candidate.promotable).toBe(false);
    expect(candidate.errors).toContain('config.json model_name "other-voice" does not match "test-voice"');
  });

  it("promotes an existing model_assets directory without copying", async () => {
    const sbv2Root = createSbv2Root();
    const modelDir = path.join(sbv2Root, "model_assets", "test-voice");
    writeModelAssets(modelDir);
    const jobsRoot = tempRoot("sbv2-model-registry-jobs-");

    const result = await promoteModel({
      sbv2Root,
      modelName: "test-voice",
      confirmModelName: "test-voice",
      jobsRoot,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "promote123",
    });

    expect(result.summary).toMatchObject({
      modelName: "test-voice",
      copied: false,
      backupDir: null,
    });
    expect(result.job.operation).toBe("model-promote");
    expect(existsSync(path.join(result.job.outputDir, "summary.json"))).toBe(true);
  });

  it("copies an external source into model_assets", async () => {
    const sbv2Root = tempRoot("sbv2-model-registry-root-");
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    const source = tempRoot("sbv2-model-registry-source-");
    writeModelAssets(source);

    const result = await promoteModel({
      sbv2Root,
      modelName: "test-voice",
      sourcePath: source,
      confirmModelName: "test-voice",
      jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
    });

    expect(result.summary.copied).toBe(true);
    expect(existsSync(path.join(sbv2Root, "model_assets", "test-voice", "config.json"))).toBe(true);
    expect(existsSync(path.join(sbv2Root, "model_assets", "test-voice", "style_vectors.npy"))).toBe(true);
  });

  it("dereferences symlinked files when copying an external source", async () => {
    const sbv2Root = tempRoot("sbv2-model-registry-root-");
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    const source = tempRoot("sbv2-model-registry-source-");
    const realFiles = tempRoot("sbv2-model-registry-real-");
    writeModelAssets(realFiles);
    symlinkSync(path.join(realFiles, "config.json"), path.join(source, "config.json"));
    symlinkSync(path.join(realFiles, "style_vectors.npy"), path.join(source, "style_vectors.npy"));
    symlinkSync(path.join(realFiles, "test-voice_e1_s100.safetensors"), path.join(source, "test-voice_e1_s100.safetensors"));

    await promoteModel({
      sbv2Root,
      modelName: "test-voice",
      sourcePath: source,
      confirmModelName: "test-voice",
      jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
    });

    const targetFile = path.join(sbv2Root, "model_assets", "test-voice", "test-voice_e1_s100.safetensors");
    expect(lstatSync(targetFile).isSymbolicLink()).toBe(false);
    expect(readFileSync(targetFile, "utf8")).toBe("model");
  });

  it("removes a fresh external-copy target when post-copy verification fails", async () => {
    const sbv2Root = tempRoot("sbv2-model-registry-root-");
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    const source = tempRoot("sbv2-model-registry-source-");
    writeModelAssets(source);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "0": {
              config_path: "model_assets/other/config.json",
              model_path: "model_assets/other/other.safetensors",
              spk2id: { other: 0 },
              style2id: { Neutral: 0 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      promoteModel({
        sbv2Root,
        modelName: "test-voice",
        sourcePath: source,
        confirmModelName: "test-voice",
        jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
        baseUrl: "http://localhost:5000",
      }),
    ).rejects.toThrow('Promoted model "test-voice" was not found');

    expect(existsSync(path.join(sbv2Root, "model_assets", "test-voice"))).toBe(false);
  });

  it("fails on an existing target unless backupExisting is enabled", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(path.join(sbv2Root, "model_assets", "test-voice"));
    const source = tempRoot("sbv2-model-registry-source-");
    writeModelAssets(source);

    await expect(
      promoteModel({
        sbv2Root,
        modelName: "test-voice",
        sourcePath: source,
        confirmModelName: "test-voice",
        jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
      }),
    ).rejects.toThrow("SBV2 model assets already exist");
  });

  it("backs up an existing target before copying an external source", async () => {
    const sbv2Root = createSbv2Root();
    const target = path.join(sbv2Root, "model_assets", "test-voice");
    writeModelAssets(target);
    writeFileSync(path.join(target, "old.txt"), "old");
    const source = tempRoot("sbv2-model-registry-source-");
    writeModelAssets(source);

    const result = await promoteModel({
      sbv2Root,
      modelName: "test-voice",
      sourcePath: source,
      confirmModelName: "test-voice",
      backupExisting: true,
      jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.summary.backupDir).toBe(path.join(sbv2Root, "model_assets", ".bridge-backups", "test-voice-20260601000000"));
    expect(existsSync(path.join(result.summary.backupDir!, "old.txt"))).toBe(true);
    expect(existsSync(path.join(target, "old.txt"))).toBe(false);
  });

  it("uses a unique backup directory when the timestamped backup already exists", async () => {
    const sbv2Root = createSbv2Root();
    const target = path.join(sbv2Root, "model_assets", "test-voice");
    writeModelAssets(target);
    const existingBackup = path.join(sbv2Root, "model_assets", ".bridge-backups", "test-voice-20260601000000");
    mkdirSync(existingBackup, { recursive: true });
    writeFileSync(path.join(existingBackup, "kept.txt"), "kept");
    const source = tempRoot("sbv2-model-registry-source-");
    writeModelAssets(source);

    const result = await promoteModel({
      sbv2Root,
      modelName: "test-voice",
      sourcePath: source,
      confirmModelName: "test-voice",
      backupExisting: true,
      jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.summary.backupDir).toBe(path.join(sbv2Root, "model_assets", ".bridge-backups", "test-voice-20260601000000-2"));
    expect(existsSync(path.join(existingBackup, "kept.txt"))).toBe(true);
  });

  it("refreshes SBV2 models and requires the promoted model in /models/info", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(path.join(sbv2Root, "model_assets", "test-voice"));
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        requests.push(`${url.pathname}`);
        return new Response(
          JSON.stringify({
            "0": {
              config_path: path.join(sbv2Root, "model_assets", "test-voice", "config.json"),
              model_path: path.join(sbv2Root, "model_assets", "test-voice", "test-voice_e1_s100.safetensors"),
              spk2id: { "test-voice": 0 },
              style2id: { Neutral: 0 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await promoteModel({
      sbv2Root,
      modelName: "test-voice",
      confirmModelName: "test-voice",
      jobsRoot: tempRoot("sbv2-model-registry-jobs-"),
      baseUrl: "http://localhost:5000",
    });

    expect(requests).toEqual(["/models/refresh"]);
    expect(result.summary.refresh).toMatchObject({
      refreshed: true,
      foundInModelsInfo: true,
      modelsInfoCount: 1,
    });
  });

  it("records failed jobs for refresh responses that do not include the promoted model", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(path.join(sbv2Root, "model_assets", "test-voice"));
    const jobsRoot = tempRoot("sbv2-model-registry-jobs-");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            "0": {
              config_path: "model_assets/other/config.json",
              model_path: "model_assets/other/other.safetensors",
              spk2id: { other: 0 },
              style2id: { Neutral: 0 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      promoteModel({
        sbv2Root,
        modelName: "test-voice",
        confirmModelName: "test-voice",
        jobsRoot,
        baseUrl: "http://localhost:5000",
        now: () => new Date("2026-06-01T00:00:00.000Z"),
        randomId: () => "promote123",
      }),
    ).rejects.toThrow('Promoted model "test-voice" was not found');

    const jobDirs = readFileSync(path.join(jobsRoot, "sbv2-job-20260601000000-promote1", "manifest.json"), "utf8");
    expect(jobDirs).toContain('"state": "failed"');
  });
});
