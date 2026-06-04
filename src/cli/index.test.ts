import { chmodSync, mkdirSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCliEntrypoint, runCli } from "./index.js";

function tempJobsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sbv2-cli-jobs-"));
}

function createWriter() {
  let output = "";
  return {
    stream: {
      write: (chunk: string) => {
        output += chunk;
        return true;
      },
    },
    output: () => output,
  };
}

function makeNpy(shape: number[]): Buffer {
  const shapeText = shape.length === 1 ? `${shape[0]},` : shape.join(", ");
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shapeText}), }`;
  const magicLength = 10;
  const padding = 16 - ((magicLength + header.length + 1) % 16);
  const paddedHeader = `${header}${" ".repeat(padding)}\n`;
  const result = Buffer.alloc(magicLength + paddedHeader.length + shape.reduce((total, value) => total * value, 1) * 4);
  result.write("\x93NUMPY", 0, "latin1");
  result[6] = 1;
  result[7] = 0;
  result.writeUInt16LE(paddedHeader.length, 8);
  result.write(paddedHeader, magicLength, "latin1");
  return result;
}

function makeModelConfig(modelName: string): Record<string, unknown> {
  return {
    model_name: modelName,
    model: {},
    train: {},
    data: {
      num_styles: 1,
      spk2id: { [modelName]: 0 },
      style2id: { Neutral: 0 },
    },
  };
}

function makeSafetensors(): Buffer {
  const payload = Buffer.alloc(4);
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, payload.length] } }), "utf8");
  const result = Buffer.alloc(8 + header.length + payload.length);
  result.writeBigUInt64LE(BigInt(header.length), 0);
  header.copy(result, 8);
  payload.copy(result, 8 + header.length);
  return result;
}

function createMergeCliRoot(modelNames: string[]): string {
  const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-merge-root-"));
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
  for (const modelName of modelNames) {
    const modelDir = path.join(sbv2Root, "model_assets", modelName);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig(modelName)));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors());
  }
  return sbv2Root;
}

function makeWav(samples = 3200, value = 1000): Buffer {
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) {
    buffer.writeInt16LE(value, offset);
  }
  return buffer;
}

describe("sbv2-bridge CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("detects invocation through a package bin symlink", () => {
    const dir = tempJobsRoot();
    const target = path.join(dir, "index.js");
    const link = path.join(dir, "sbv2-bridge");
    writeFileSync(target, "");
    symlinkSync(target, link);

    expect(isCliEntrypoint(pathToFileURL(target).href, link)).toBe(true);
  });

  it("documents datasets prepare slice flags in help", async () => {
    const stdout = createWriter();
    await expect(runCli(["--help"], { stdout: stdout.stream, stderr: createWriter().stream })).resolves.toBe(0);

    expect(stdout.output()).toContain("--slice-min-sec <n>");
    expect(stdout.output()).toContain("--slice-max-sec <n>");
    expect(stdout.output()).toContain("--slice-min-silence-dur-ms <n>");
    expect(stdout.output()).toContain("--slice-num-processes <n>");
  });

  it("prints command-specific help for model merge plan without requiring merge args", async () => {
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(runCli(["models", "merge-plan", "--help"], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(
      0,
    );

    expect(stderr.output()).toBe("");
    expect(stdout.output()).toContain("Usage: sbv2-bridge models merge-plan [options]");
    expect(stdout.output()).toContain("--method <name>");
    expect(stdout.output()).toContain("--model-a <name>");
    expect(stdout.output()).toContain("--model-b <name>");
    expect(stdout.output()).toContain("--output-model-name <name>");
    expect(stdout.output()).toContain("--model-c <name>");
    expect(stdout.output()).toContain("--style-recipe <path>");
    expect(stdout.output()).toContain("usual                   Blend two models by part weights.");
    expect(stdout.output()).toContain("Voice quality weight for the B contribution, or B-C diff in add-diff. Default 0.5.");
    expect(stdout.output()).toContain("Model A contribution coefficient. Default 0.5.");
    expect(stdout.output()).toContain("Defaults keep omitted values at a visible half-strength blend.");
    expect(stdout.output()).toContain("Smoke:      sbv2-bridge models merge-plan");
    expect(stdout.output()).toContain("Experiment: sbv2-bridge models merge-plan");
    expect(stdout.output()).toContain("Candidate:  sbv2-bridge models merge-plan");
    expect(stdout.output()).toContain("--json");
    expect(stdout.output()).toContain("--json-summary");
    expect(stdout.output()).not.toContain("datasets ingest");
  });

  it("accepts short help after a command with required args", async () => {
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(runCli(["models", "merge-plan", "-h"], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(
      0,
    );

    expect(stderr.output()).toBe("");
    expect(stdout.output()).toContain("Usage: sbv2-bridge models merge-plan [options]");
  });

  it("prints merge-run help with confirmation and refresh options", async () => {
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(runCli(["models", "merge-run", "--help"], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(
      0,
    );

    expect(stderr.output()).toBe("");
    expect(stdout.output()).toContain("Usage: sbv2-bridge models merge-run [options]");
    expect(stdout.output()).toContain("--confirm-output-model-name <name>");
    expect(stdout.output()).toContain("--base-url <url>");
    expect(stdout.output()).toContain("--style-recipe <path>");
    expect(stdout.output()).toContain("Speaking tempo weight for B, or B-C diff in add-diff. Default 0.5.");
    expect(stdout.output()).toContain("Model C contribution coefficient. Default 0.5.");
    expect(stdout.output()).toContain("/models/info registration, config.json style2id, style_vectors.npy");
    expect(stdout.output()).toContain("Candidate:  sbv2-bridge models merge-run");
    expect(stdout.output()).toContain("--json-summary");
  });

  it("prints rename help with data and confirmation options", async () => {
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(runCli(["models", "rename-run", "--help"], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(
      0,
    );

    expect(stderr.output()).toBe("");
    expect(stdout.output()).toContain("Usage: sbv2-bridge models rename-run [options]");
    expect(stdout.output()).toContain("--from-model-name <name>");
    expect(stdout.output()).toContain("--to-model-name <name>");
    expect(stdout.output()).toContain("--confirm-to-model-name <name>");
    expect(stdout.output()).toContain("--include-data");
    expect(stdout.output()).toContain(".safetensors filenames are not renamed");
  });

  it("reports unknown commands even when command help is requested", async () => {
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(runCli(["models", "missing", "--help"], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(1);

    expect(stdout.output()).toBe("");
    expect(stderr.output()).toContain("Unknown models command: missing");
  });

  it("keeps global help available", async () => {
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(runCli(["--help"], { stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(0);

    expect(stderr.output()).toBe("");
    expect(stdout.output()).toContain("Usage: sbv2-bridge <group> <command> [options]");
    expect(stdout.output()).toContain("models merge-plan");
    expect(stdout.output()).toContain("datasets ingest");
  });

  it("starts a dummy job and reads its status as JSON", async () => {
    const jobsRoot = tempJobsRoot();
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(
      runCli(
        ["jobs", "start-dummy", "--jobs-dir", jobsRoot, "--message", "hello", "--json"],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");

    const started = JSON.parse(stdout.output()) as { job: { jobId: string; state: string } };
    expect(started.job.state).toBe("succeeded");

    const statusOut = createWriter();
    await expect(
      runCli(["jobs", "status", started.job.jobId, "--jobs-dir", jobsRoot, "--json"], {
        stdout: statusOut.stream,
        stderr: stderr.stream,
      }),
    ).resolves.toBe(0);

    const status = JSON.parse(statusOut.output()) as { job: { jobId: string } };
    expect(status.job.jobId).toBe(started.job.jobId);
  });

  it("prints logs and returns a distinct code for unsupported cancel", async () => {
    const jobsRoot = tempJobsRoot();
    const startOut = createWriter();
    await runCli(["jobs", "start-dummy", "--jobs-dir", jobsRoot, "--json"], {
      stdout: startOut.stream,
      stderr: createWriter().stream,
    });
    const jobId = (JSON.parse(startOut.output()) as { job: { jobId: string } }).job.jobId;

    const logOut = createWriter();
    await expect(
      runCli(["jobs", "log", jobId, "--jobs-dir", jobsRoot, "--tail", "1"], {
        stdout: logOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(0);
    expect(logOut.output()).toContain("dummy job succeeded");

    const cancelOut = createWriter();
    await expect(
      runCli(["jobs", "cancel", jobId, "--jobs-dir", jobsRoot], {
        stdout: cancelOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(2);
    expect(cancelOut.output()).toContain("cancel unsupported");
  });

  it("can create and retry a failed dummy job for firstError smoke coverage", async () => {
    const jobsRoot = tempJobsRoot();
    const stdout = createWriter();
    await expect(
      runCli(["jobs", "start-dummy", "--jobs-dir", jobsRoot, "--fail", "--json"], {
        stdout: stdout.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(0);

    const started = JSON.parse(stdout.output()) as {
      job: { jobId: string; state: string; firstError: string; retryable: boolean };
    };
    expect(started.job).toMatchObject({
      state: "failed",
      firstError: "Dummy job failed by request.",
      retryable: true,
    });

    const retryOut = createWriter();
    await expect(
      runCli(["jobs", "retry", started.job.jobId, "--jobs-dir", jobsRoot, "--json"], {
        stdout: retryOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(0);
    const retried = JSON.parse(retryOut.output()) as {
      job: { state: string; inputSummary: { retriedFrom: string } };
    };
    expect(retried.job.state).toBe("succeeded");
    expect(retried.job.inputSummary.retriedFrom).toBe(started.job.jobId);
  });

  it("reports resume as unsupported for terminal dummy jobs", async () => {
    const jobsRoot = tempJobsRoot();
    const startOut = createWriter();
    await runCli(["jobs", "start-dummy", "--jobs-dir", jobsRoot, "--json"], {
      stdout: startOut.stream,
      stderr: createWriter().stream,
    });
    const jobId = (JSON.parse(startOut.output()) as { job: { jobId: string } }).job.jobId;

    const resumeOut = createWriter();
    await expect(
      runCli(["jobs", "resume", jobId, "--jobs-dir", jobsRoot], {
        stdout: resumeOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(2);
    expect(resumeOut.output()).toContain("resume unsupported");
  });

  it("ingests a dataset and exposes the resulting job through jobs status", async () => {
    const jobsRoot = tempJobsRoot();
    const datasetsRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-datasets-"));
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-root-"));
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-source-"));
    mkdirSync(path.join(sourceRoot, "bright"));
    mkdirSync(path.join(sourceRoot, "soft"));
    writeFileSync(path.join(sourceRoot, "bright", "a.wav"), "a");
    writeFileSync(path.join(sourceRoot, "soft", "b.wav"), "b");

    const stdout = createWriter();
    const stderr = createWriter();
    await expect(
      runCli(
        [
          "datasets",
          "ingest",
          "--jobs-dir",
          jobsRoot,
          "--datasets-dir",
          datasetsRoot,
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "cli-voice",
          "--source",
          sourceRoot,
          "--language",
          "ja",
          "--use-jp-extra",
          "--json",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");

    const ingested = JSON.parse(stdout.output()) as {
      dataset: { modelName: string; styleMode: string; files: unknown[] };
      job: { jobId: string; operation: string };
    };
    expect(ingested.dataset).toMatchObject({
      modelName: "cli-voice",
      styleMode: "directory",
    });
    expect(ingested.dataset.files).toHaveLength(2);
    expect(ingested.job.operation).toBe("dataset-ingest");

    const statusOut = createWriter();
    await expect(
      runCli(["jobs", "status", ingested.job.jobId, "--jobs-dir", jobsRoot, "--json"], {
        stdout: statusOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(0);
    const status = JSON.parse(statusOut.output()) as { job: { operation: string } };
    expect(status.job.operation).toBe("dataset-ingest");
  });

  it("prints a weighted-sum model merge plan as JSON", async () => {
    const sbv2Root = createMergeCliRoot(["model-a", "model-b", "model-c"]);

    const stdout = createWriter();
    const stderr = createWriter();
    await expect(
      runCli(
        [
          "models",
          "merge-plan",
          "--sbv2-root",
          sbv2Root,
          "--method",
          "weighted-sum",
          "--output-model-name",
          "merged",
          "--model-a",
          "model-a",
          "--model-b",
          "model-b",
          "--model-c",
          "model-c",
          "--model-a-coeff",
          "1",
          "--model-b-coeff",
          "-1",
          "--model-c-coeff",
          "0",
          "--json",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");

    const parsed = JSON.parse(stdout.output()) as {
      plan: {
        method: string;
        coefficients: Record<string, number>;
        inputModels: { a: { safetensorsTensors: Record<string, unknown> } };
      };
    };
    expect(parsed.plan.method).toBe("weighted-sum");
    expect(parsed.plan.coefficients).toEqual({ modelACoeff: 1, modelBCoeff: -1, modelCCoeff: 0 });
    expect(parsed.plan.inputModels.a.safetensorsTensors).toHaveProperty("weight");
  });

  it("prints a compact model merge plan summary without tensor maps", async () => {
    const sbv2Root = createMergeCliRoot(["model-a", "model-b"]);
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(
      runCli(
        [
          "models",
          "merge-plan",
          "--sbv2-root",
          sbv2Root,
          "--method",
          "usual",
          "--output-model-name",
          "merged",
          "--model-a",
          "model-a",
          "--model-b",
          "model-b",
          "--json-summary",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");
    expect(stdout.output()).not.toContain("safetensorsTensors");

    const parsed = JSON.parse(stdout.output()) as {
      plan?: unknown;
      summary: {
        method: string;
        inputModels: { a: { modelName: string; safetensorsPath: string }; b: { safetensorsPath: string } };
        weights: Record<string, number>;
        compatibility: { compatible: boolean };
        expectedArtifacts: string[];
      };
      pathRoles: { sbv2LoadableModel: string; recipe: string };
    };
    expect(parsed.plan).toBeUndefined();
    expect(parsed.summary.method).toBe("usual");
    expect(parsed.summary.inputModels.a.modelName).toBe("model-a");
    expect(parsed.summary.inputModels.a.safetensorsPath).toBe(path.join(sbv2Root, "model_assets", "model-a", "model-a.safetensors"));
    expect(parsed.summary.inputModels.b.safetensorsPath).toBe(path.join(sbv2Root, "model_assets", "model-b", "model-b.safetensors"));
    expect(parsed.summary.weights).toEqual({
      voiceWeight: 0.5,
      voicePitchWeight: 0.5,
      speechStyleWeight: 0.5,
      tempoWeight: 0.5,
    });
    expect(parsed.summary.compatibility.compatible).toBe(true);
    expect(parsed.summary.expectedArtifacts).toContain(path.join(sbv2Root, "model_assets", "merged", "merged.safetensors"));
    expect(parsed.pathRoles).toEqual({
      sbv2LoadableModel: path.join(sbv2Root, "model_assets", "merged"),
      recipe: path.join(sbv2Root, "model_assets", "merged", "recipe.json"),
    });
  });

  it("prints default usual merge weights as JSON when omitted", async () => {
    const sbv2Root = createMergeCliRoot(["model-a", "model-b"]);
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(
      runCli(
        [
          "models",
          "merge-plan",
          "--sbv2-root",
          sbv2Root,
          "--method",
          "usual",
          "--output-model-name",
          "merged",
          "--model-a",
          "model-a",
          "--model-b",
          "model-b",
          "--json",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");

    const parsed = JSON.parse(stdout.output()) as { plan: { weights: Record<string, number>; coefficients?: unknown } };
    expect(parsed.plan.weights).toEqual({
      voiceWeight: 0.5,
      voicePitchWeight: 0.5,
      speechStyleWeight: 0.5,
      tempoWeight: 0.5,
    });
    expect(parsed.plan.coefficients).toBeUndefined();
  });

  it("prints default weighted-sum coefficients as JSON when omitted", async () => {
    const sbv2Root = createMergeCliRoot(["model-a", "model-b", "model-c"]);
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(
      runCli(
        [
          "models",
          "merge-plan",
          "--sbv2-root",
          sbv2Root,
          "--method",
          "weighted-sum",
          "--output-model-name",
          "merged",
          "--model-a",
          "model-a",
          "--model-b",
          "model-b",
          "--model-c",
          "model-c",
          "--json",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");

    const parsed = JSON.parse(stdout.output()) as { plan: { coefficients: Record<string, number>; weights?: unknown } };
    expect(parsed.plan.coefficients).toEqual({ modelACoeff: 0.5, modelBCoeff: 0.5, modelCCoeff: 0.5 });
    expect(parsed.plan.weights).toBeUndefined();
  });

  it("prints a model merge plan with style recipe as JSON", async () => {
    const sbv2Root = createMergeCliRoot(["model-a", "model-b"]);
    const styleRecipePath = path.join(sbv2Root, "styles.json");
    writeFileSync(
      styleRecipePath,
      `${JSON.stringify({
        schemaVersion: 1,
        styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
      })}\n`,
    );
    const stdout = createWriter();
    const stderr = createWriter();

    await expect(
      runCli(
        [
          "models",
          "merge-plan",
          "--sbv2-root",
          sbv2Root,
          "--method",
          "usual",
          "--model-a",
          "model-a",
          "--model-b",
          "model-b",
          "--output-model-name",
          "merged",
          "--style-recipe",
          styleRecipePath,
          "--json",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(0);
    expect(stderr.output()).toBe("");

    const parsed = JSON.parse(stdout.output()) as {
      plan: { outputModelName: string; styleMergeApplied: boolean; styleRecipePath: string; outputStyle2id: Record<string, number> };
    };
    expect(parsed.plan.outputModelName).toBe("merged");
    expect(parsed.plan.styleMergeApplied).toBe(true);
    expect(parsed.plan.styleRecipePath).toBe(styleRecipePath);
    expect(parsed.plan.outputStyle2id).toEqual({ Neutral: 0 });
  });

  it("prints model merge run path roles as JSON", async () => {
    const jobsRoot = tempJobsRoot();
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-merge-root-"));
    const binRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-bin-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    for (const modelName of ["model-a", "model-b"]) {
      const modelDir = path.join(sbv2Root, "model_assets", modelName);
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig(modelName)));
      writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
      writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors());
    }
    const fakeUv = path.join(binRoot, "uv");
    writeFileSync(
      fakeUv,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const payload = JSON.parse(process.argv[process.argv.length - 1]);
const outputDir = path.join(process.cwd(), "model_assets", payload.outputName);
const modelADir = path.dirname(payload.modelPathA);
fs.mkdirSync(outputDir, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(modelADir, "config.json"), "utf8"));
config.model_name = payload.outputName;
config.data.spk2id = { [payload.outputName]: 0 };
fs.writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(config));
fs.copyFileSync(path.join(modelADir, "style_vectors.npy"), path.join(outputDir, "style_vectors.npy"));
fs.copyFileSync(payload.modelPathA, path.join(outputDir, payload.outputName + ".safetensors"));
fs.writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: payload.method }));
`,
    );
    chmodSync(fakeUv, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binRoot}:${previousPath ?? ""}`;
    try {
      const stdout = createWriter();
      const stderr = createWriter();
      await expect(
        runCli(
          [
            "models",
            "merge-run",
            "--jobs-dir",
            jobsRoot,
            "--sbv2-root",
            sbv2Root,
            "--method",
            "usual",
            "--output-model-name",
            "merged",
            "--confirm-output-model-name",
            "merged",
            "--model-a",
            "model-a",
            "--model-b",
            "model-b",
            "--voice-weight",
            "0.1",
            "--voice-pitch-weight",
            "0.2",
            "--speech-style-weight",
            "0.3",
            "--tempo-weight",
            "0.4",
            "--json",
          ],
          { stdout: stdout.stream, stderr: stderr.stream },
        ),
      ).resolves.toBe(0);
      expect(stderr.output()).toBe("");

      const parsed = JSON.parse(stdout.output()) as {
        summary: { recipePath: string };
        job: { outputDir: string; logPath: string; inputSummary: { recipePath?: string } };
        pathRoles: {
          bridgeState?: string;
          sbv2LoadableModel?: string;
          recipe?: string;
          summary?: string;
          jobLog?: string;
        };
      };
      expect(parsed.summary.recipePath).toBe(path.join(sbv2Root, "model_assets", "merged", "recipe.json"));
      expect(parsed.job.inputSummary.recipePath).toBe(parsed.summary.recipePath);
      expect(parsed.pathRoles).toEqual({
        bridgeState: parsed.job.outputDir,
        sbv2LoadableModel: path.join(sbv2Root, "model_assets", "merged"),
        recipe: path.join(sbv2Root, "model_assets", "merged", "recipe.json"),
        summary: path.join(parsed.job.outputDir, "summary.json"),
        jobLog: parsed.job.logPath,
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("prints a compact model merge run summary with job artifacts and no tensor maps", async () => {
    const jobsRoot = tempJobsRoot();
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-merge-summary-root-"));
    const binRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-bin-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    for (const modelName of ["model-a", "model-b"]) {
      const modelDir = path.join(sbv2Root, "model_assets", modelName);
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig(modelName)));
      writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
      writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors());
    }
    const fakeUv = path.join(binRoot, "uv");
    writeFileSync(
      fakeUv,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const payload = JSON.parse(process.argv[process.argv.length - 1]);
const outputDir = path.join(process.cwd(), "model_assets", payload.outputName);
const modelADir = path.dirname(payload.modelPathA);
fs.mkdirSync(outputDir, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(modelADir, "config.json"), "utf8"));
config.model_name = payload.outputName;
config.data.spk2id = { [payload.outputName]: 0 };
fs.writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(config));
fs.copyFileSync(path.join(modelADir, "style_vectors.npy"), path.join(outputDir, "style_vectors.npy"));
fs.copyFileSync(payload.modelPathA, path.join(outputDir, payload.outputName + ".safetensors"));
fs.writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: payload.method }));
`,
    );
    chmodSync(fakeUv, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binRoot}:${previousPath ?? ""}`;
    try {
      const stdout = createWriter();
      const stderr = createWriter();
      await expect(
        runCli(
          [
            "models",
            "merge-run",
            "--jobs-dir",
            jobsRoot,
            "--sbv2-root",
            sbv2Root,
            "--method",
            "usual",
            "--output-model-name",
            "merged",
            "--confirm-output-model-name",
            "merged",
            "--model-a",
            "model-a",
            "--model-b",
            "model-b",
            "--json-summary",
          ],
          { stdout: stdout.stream, stderr: stderr.stream },
        ),
      ).resolves.toBe(0);
      expect(stderr.output()).toBe("");
      expect(stdout.output()).not.toContain("safetensorsTensors");

      const parsed = JSON.parse(stdout.output()) as {
        plan?: unknown;
        candidate?: unknown;
        summary: {
          method: string;
          inputModels: { a: { safetensorsPath: string } };
          candidate: { modelName: string; safetensorsPaths: string[] };
          expectedArtifacts: string[];
        };
        job: {
          jobId: string;
          state: string;
          outputDir: string;
          logPath: string;
          artifactPaths: string[];
          inputSummary: { recipePath?: string };
        };
        pathRoles: {
          bridgeState?: string;
          sbv2LoadableModel?: string;
          recipe?: string;
          summary?: string;
          jobLog?: string;
        };
      };
      expect(parsed.plan).toBeUndefined();
      expect(parsed.candidate).toBeUndefined();
      expect(parsed.summary.method).toBe("usual");
      expect(parsed.summary.inputModels.a.safetensorsPath).toBe(
        path.join(sbv2Root, "model_assets", "model-a", "model-a.safetensors"),
      );
      expect(parsed.summary.candidate).toMatchObject({
        modelName: "merged",
        safetensorsPaths: [path.join(sbv2Root, "model_assets", "merged", "merged.safetensors")],
      });
      expect(parsed.summary.expectedArtifacts).toContain(path.join(sbv2Root, "model_assets", "merged", "recipe.json"));
      expect(parsed.job.jobId).toMatch(/^sbv2-job-/);
      expect(parsed.job.state).toBe("succeeded");
      expect(parsed.job.artifactPaths).toContain(path.join(sbv2Root, "model_assets", "merged", "recipe.json"));
      expect(parsed.job.inputSummary.recipePath).toBe(path.join(sbv2Root, "model_assets", "merged", "recipe.json"));
      expect(parsed.pathRoles).toEqual({
        bridgeState: parsed.job.outputDir,
        sbv2LoadableModel: path.join(sbv2Root, "model_assets", "merged"),
        recipe: path.join(sbv2Root, "model_assets", "merged", "recipe.json"),
        summary: path.join(parsed.job.outputDir, "summary.json"),
        jobLog: parsed.job.logPath,
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("prints model rename plan and run path roles as JSON", async () => {
    const jobsRoot = tempJobsRoot();
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-rename-root-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "dataset_root: Data\nassets_root: model_assets\n");
    const modelDir = path.join(sbv2Root, "model_assets", "old-voice");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig("old-voice")));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(modelDir, "old-voice.safetensors"), makeSafetensors());

    const planOut = createWriter();
    await expect(
      runCli(
        [
          "models",
          "rename-plan",
          "--sbv2-root",
          sbv2Root,
          "--from-model-name",
          "old-voice",
          "--to-model-name",
          "new-voice",
          "--json",
        ],
        { stdout: planOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const planned = JSON.parse(planOut.output()) as { plan: { targetAssetsDir: string }; pathRoles: { sbv2LoadableModel?: string } };
    expect(planned.pathRoles.sbv2LoadableModel).toBe(path.join(sbv2Root, "model_assets", "new-voice"));
    expect(planned.plan.targetAssetsDir).toBe(planned.pathRoles.sbv2LoadableModel);

    const runOut = createWriter();
    await expect(
      runCli(
        [
          "models",
          "rename-run",
          "--jobs-dir",
          jobsRoot,
          "--sbv2-root",
          sbv2Root,
          "--from-model-name",
          "old-voice",
          "--to-model-name",
          "new-voice",
          "--confirm-to-model-name",
          "new-voice",
          "--json",
        ],
        { stdout: runOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const parsed = JSON.parse(runOut.output()) as {
      summary: { targetAssetsDir: string };
      job: { jobId: string; outputDir: string; logPath: string };
      pathRoles: { bridgeState?: string; sbv2LoadableModel?: string; summary?: string; jobLog?: string };
    };
    expect(parsed.summary.targetAssetsDir).toBe(path.join(sbv2Root, "model_assets", "new-voice"));
    expect(parsed.pathRoles).toEqual({
      bridgeState: parsed.job.outputDir,
      sbv2LoadableModel: path.join(sbv2Root, "model_assets", "new-voice"),
      summary: path.join(parsed.job.outputDir, "summary.json"),
      jobLog: parsed.job.logPath,
    });

    const statusOut = createWriter();
    await expect(
      runCli(["jobs", "status", parsed.job.jobId, "--jobs-dir", jobsRoot, "--json"], {
        stdout: statusOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(0);
    const status = JSON.parse(statusOut.output()) as { job: { operation: string } };
    expect(status.job.operation).toBe("model-rename");
  });

  it("omits dataset path roles when rename includes missing Data source", async () => {
    const jobsRoot = tempJobsRoot();
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-rename-root-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "dataset_root: Data\nassets_root: model_assets\n");
    const modelDir = path.join(sbv2Root, "model_assets", "old-voice");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig("old-voice")));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(modelDir, "old-voice.safetensors"), makeSafetensors());

    const stdout = createWriter();
    await expect(
      runCli(
        [
          "models",
          "rename-run",
          "--jobs-dir",
          jobsRoot,
          "--sbv2-root",
          sbv2Root,
          "--from-model-name",
          "old-voice",
          "--to-model-name",
          "new-voice",
          "--confirm-to-model-name",
          "new-voice",
          "--include-data",
          "--json",
        ],
        { stdout: stdout.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const parsed = JSON.parse(stdout.output()) as { pathRoles: { sbv2Dataset?: string }; job: { artifactPaths: string[] } };
    expect(parsed.pathRoles.sbv2Dataset).toBeUndefined();
    expect(parsed.job.artifactPaths).not.toContain(path.join(sbv2Root, "Data", "new-voice"));
  });

  it("rejects mismatched model merge parameters at the CLI layer", async () => {
    const stdout = createWriter();
    const stderr = createWriter();
    await expect(
      runCli(
        [
          "models",
          "merge-plan",
          "--method",
          "weighted-sum",
          "--output-model-name",
          "merged",
          "--model-a",
          "model-a",
          "--model-b",
          "model-b",
          "--model-c",
          "model-c",
          "--voice-weight",
          "0.1",
          "--voice-pitch-weight",
          "0.2",
          "--speech-style-weight",
          "0.3",
          "--tempo-weight",
          "0.4",
          "--model-a-coeff",
          "1",
          "--model-b-coeff",
          "-1",
          "--model-c-coeff",
          "0",
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(1);
    expect(stderr.output()).toContain("part weights are not valid for weighted-sum");
  });

  it("requires an explicit JP-Extra choice for dataset ingest", async () => {
    const stdout = createWriter();
    const stderr = createWriter();
    await expect(
      runCli(
        [
          "datasets",
          "ingest",
          "--model-name",
          "missing-choice",
          "--source",
          mkdtempSync(path.join(tmpdir(), "sbv2-cli-source-")),
        ],
        { stdout: stdout.stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(1);
    expect(stderr.output()).toContain("Missing --use-jp-extra or --no-use-jp-extra");
  });

  it("prepares an ingested dataset through a fake SBV2 uv command", async () => {
    const jobsRoot = tempJobsRoot();
    const datasetsRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-datasets-"));
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-root-"));
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-source-"));
    const binRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-bin-"));
    writeFileSync(path.join(sbv2Root, "slice.py"), "");
    writeFileSync(path.join(sbv2Root, "transcribe.py"), "");
    writeFileSync(path.join(sourceRoot, "a.wav"), "a");
    const fakeUv = path.join(binRoot, "uv");
    writeFileSync(
      fakeUv,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const modelName = args[args.indexOf("--model_name") + 1];
const root = process.cwd();
if (args.includes("slice.py")) {
  const raw = path.join(root, "Data", modelName, "raw");
  fs.mkdirSync(raw, { recursive: true });
  fs.writeFileSync(path.join(raw, "a-0.wav"), "a");
}
if (args.includes("transcribe.py")) {
  const dir = path.join(root, "Data", modelName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "esd.list"), "a-0.wav|" + modelName + "|JP|こんにちは\\n");
}
`,
    );
    chmodSync(fakeUv, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binRoot}:${previousPath ?? ""}`;
    try {
      const ingestOut = createWriter();
      await expect(
        runCli(
          [
            "datasets",
            "ingest",
            "--jobs-dir",
            jobsRoot,
            "--datasets-dir",
            datasetsRoot,
            "--sbv2-root",
            sbv2Root,
            "--model-name",
            "cli-prepare",
            "--source",
            sourceRoot,
            "--language",
            "ja",
            "--use-jp-extra",
            "--json",
          ],
          { stdout: ingestOut.stream, stderr: createWriter().stream },
        ),
      ).resolves.toBe(0);
      const ingested = JSON.parse(ingestOut.output()) as {
        dataset: { manifestPath: string };
        pathRoles: { bridgeState: string; sbv2Dataset: string; sbv2LoadableModel: string; jobLog: string };
      };
      expect(ingested.pathRoles).toMatchObject({
        sbv2Dataset: path.join(sbv2Root, "Data", "cli-prepare"),
        sbv2LoadableModel: path.join(sbv2Root, "model_assets", "cli-prepare"),
      });
      expect(ingested.pathRoles.bridgeState).toContain(datasetsRoot);
      expect(ingested.pathRoles.jobLog).toContain(jobsRoot);

      const prepareOut = createWriter();
      const prepareErr = createWriter();
      await expect(
        runCli(
          [
            "datasets",
            "prepare",
            "--jobs-dir",
            jobsRoot,
            "--manifest",
            ingested.dataset.manifestPath,
            "--slice-min-sec",
            "0.7",
            "--slice-max-sec",
            "8.5",
            "--slice-min-silence-dur-ms",
            "300",
            "--slice-num-processes",
            "2",
            "--json",
          ],
          { stdout: prepareOut.stream, stderr: prepareErr.stream },
        ),
      ).resolves.toBe(0);
      expect(prepareErr.output()).toBe("");
      const prepared = JSON.parse(prepareOut.output()) as {
        summary: {
          rawWavCount: number;
          esdLineCount: number;
          sliceOptions: { minSec: number; maxSec: number; minSilenceDurMs: number; numProcesses: number };
        };
        job: {
          operation: string;
          inputSummary: {
            sliceOptions: { minSec: number; maxSec: number; minSilenceDurMs: number; numProcesses: number };
          };
        };
        pathRoles: { bridgeState: string; sbv2Dataset: string; sbv2LoadableModel: string; jobLog: string };
      };
      expect(prepared.summary).toMatchObject({
        rawWavCount: 1,
        esdLineCount: 1,
        sliceOptions: {
          minSec: 0.7,
          maxSec: 8.5,
          minSilenceDurMs: 300,
          numProcesses: 2,
        },
      });
      expect(prepared.job.operation).toBe("dataset-prepare");
      expect(prepared.job.inputSummary.sliceOptions).toEqual(prepared.summary.sliceOptions);
      expect(prepared.pathRoles).toMatchObject({
        sbv2Dataset: path.join(sbv2Root, "Data", "cli-prepare"),
        sbv2LoadableModel: path.join(sbv2Root, "model_assets", "cli-prepare"),
      });
      expect(prepared.pathRoles.bridgeState).toContain(jobsRoot);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("rejects invalid datasets prepare slice flags at the CLI layer", async () => {
    const cases: Array<{ argv: string[]; message: string }> = [
      {
        argv: ["datasets", "prepare", "--slice-min-sec", "0"],
        message: "--slice-min-sec must be a positive finite number",
      },
      {
        argv: ["datasets", "prepare", "--slice-min-sec", "9", "--slice-max-sec", "8"],
        message: "--slice-min-sec must be less than or equal to --slice-max-sec",
      },
      {
        argv: ["datasets", "prepare", "--slice-min-sec", "20"],
        message: "--slice-min-sec must be less than or equal to --slice-max-sec",
      },
      {
        argv: ["datasets", "prepare", "--slice-max-sec", "1"],
        message: "--slice-min-sec must be less than or equal to --slice-max-sec",
      },
      {
        argv: ["datasets", "prepare", "--slice-num-processes", "1.5"],
        message: "--slice-num-processes must be a positive integer",
      },
    ];

    for (const testCase of cases) {
      const stderr = createWriter();
      await expect(
        runCli(testCase.argv, { stdout: createWriter().stream, stderr: stderr.stream }),
      ).resolves.toBe(1);
      expect(stderr.output()).toContain(testCase.message);
    }
  });

  it("prints a training plan and runs a selected training stage", async () => {
    const jobsRoot = tempJobsRoot();
    const datasetsRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-datasets-"));
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-root-"));
    const configuredDatasetRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-configured-data-"));
    const configuredAssetsRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-configured-assets-"));
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-source-"));
    const binRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-bin-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(
      path.join(sbv2Root, "configs", "paths.yml"),
      `dataset_root: ${configuredDatasetRoot}\nassets_root: ${configuredAssetsRoot}\n`,
    );
    writeFileSync(path.join(sbv2Root, "resample.py"), "");
    writeFileSync(path.join(sourceRoot, "a.wav"), "a");
    const fakeUv = path.join(binRoot, "uv");
    writeFileSync(
      fakeUv,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("resample.py")) {
  const output = args[args.indexOf("-o") + 1];
  fs.mkdirSync(output, { recursive: true });
}
`,
    );
    chmodSync(fakeUv, 0o755);

    const ingestOut = createWriter();
    await expect(
      runCli(
        [
          "datasets",
          "ingest",
          "--jobs-dir",
          jobsRoot,
          "--datasets-dir",
          datasetsRoot,
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "cli-train",
          "--source",
          sourceRoot,
          "--language",
          "ja",
          "--use-jp-extra",
          "--json",
        ],
        { stdout: ingestOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const ingested = JSON.parse(ingestOut.output()) as {
      dataset: { manifestPath: string };
      pathRoles: { sbv2Dataset: string; sbv2LoadableModel: string };
    };
    expect(ingested.pathRoles).toMatchObject({
      sbv2Dataset: path.join(configuredDatasetRoot, "cli-train"),
      sbv2LoadableModel: path.join(configuredAssetsRoot, "cli-train"),
    });
    mkdirSync(path.join(configuredDatasetRoot, "cli-train", "raw"), { recursive: true });
    writeFileSync(path.join(configuredDatasetRoot, "cli-train", "raw", "a-0.wav"), "a");
    writeFileSync(path.join(configuredDatasetRoot, "cli-train", "esd.list"), "a-0.wav|cli-train|JP|こんにちは\n");

    const planOut = createWriter();
    await expect(
      runCli(
        [
          "training",
          "plan",
          "--manifest",
          ingested.dataset.manifestPath,
          "--stage",
          "resample",
          "--batch-size",
          "4",
          "--json",
        ],
        { stdout: planOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const planned = JSON.parse(planOut.output()) as {
      plan: { stages: string[]; settings: { batchSize: number } };
      pathRoles: { sbv2Dataset: string; sbv2LoadableModel: string };
    };
    expect(planned.plan.stages).toEqual(["resample"]);
    expect(planned.plan.settings.batchSize).toBe(4);
    expect(planned.pathRoles).toMatchObject({
      sbv2Dataset: path.join(configuredDatasetRoot, "cli-train"),
      sbv2LoadableModel: path.join(configuredAssetsRoot, "cli-train"),
    });

    const textPlanOut = createWriter();
    await expect(
      runCli(
        [
          "training",
          "plan",
          "--manifest",
          ingested.dataset.manifestPath,
          "--stage",
          "resample",
        ],
        { stdout: textPlanOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    expect(textPlanOut.output()).toContain(`SBV2 dataset: ${path.join(configuredDatasetRoot, "cli-train")}`);
    expect(textPlanOut.output()).toContain(`SBV2 loadable model: ${path.join(configuredAssetsRoot, "cli-train")}`);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binRoot}:${previousPath ?? ""}`;
    try {
      const runOut = createWriter();
      await expect(
        runCli(
          [
            "training",
            "run",
            "--jobs-dir",
            jobsRoot,
            "--manifest",
            ingested.dataset.manifestPath,
            "--stage",
            "resample",
            "--json",
          ],
          { stdout: runOut.stream, stderr: createWriter().stream },
        ),
      ).resolves.toBe(0);
      const ran = JSON.parse(runOut.output()) as {
        job: { operation: string };
        plan: { stages: string[] };
        pathRoles: { bridgeState: string; sbv2Dataset: string; sbv2LoadableModel: string; jobLog: string };
      };
      expect(ran.job.operation).toBe("training-run");
      expect(ran.plan.stages).toEqual(["resample"]);
      expect(ran.pathRoles).toMatchObject({
        sbv2Dataset: path.join(configuredDatasetRoot, "cli-train"),
        sbv2LoadableModel: path.join(configuredAssetsRoot, "cli-train"),
      });
      expect(ran.pathRoles.bridgeState).toContain(jobsRoot);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("lists and promotes SBV2 model candidates", async () => {
    const jobsRoot = tempJobsRoot();
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-model-root-"));
    const modelDir = path.join(sbv2Root, "model_assets", "cli-model");
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    writeFileSync(
      path.join(modelDir, "config.json"),
      JSON.stringify(makeModelConfig("cli-model")),
    );
    writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(modelDir, "cli-model_e1_s100.safetensors"), makeSafetensors());

    const candidatesOut = createWriter();
    await expect(
      runCli(
        ["models", "candidates", "--sbv2-root", sbv2Root, "--model-name", "cli-model", "--json"],
        { stdout: candidatesOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const candidates = JSON.parse(candidatesOut.output()) as {
      candidates: Array<{ modelName: string; promotable: boolean }>;
      pathRoles: { sbv2LoadableModel: string };
    };
    expect(candidates.candidates[0]).toMatchObject({
      modelName: "cli-model",
      promotable: true,
    });
    expect(candidates.pathRoles.sbv2LoadableModel).toBe(modelDir);

    const promoteOut = createWriter();
    await expect(
      runCli(
        [
          "models",
          "promote",
          "--jobs-dir",
          jobsRoot,
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "cli-model",
          "--confirm-model-name",
          "cli-model",
          "--json",
        ],
        { stdout: promoteOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const promoted = JSON.parse(promoteOut.output()) as {
      summary: { modelName: string; copied: boolean };
      job: { operation: string };
      pathRoles: { bridgeState: string; sbv2LoadableModel: string; jobLog: string };
    };
    expect(promoted.summary).toMatchObject({ modelName: "cli-model", copied: false });
    expect(promoted.job.operation).toBe("model-promote");
    expect(promoted.pathRoles.sbv2LoadableModel).toBe(modelDir);
    expect(promoted.pathRoles.bridgeState).toContain(jobsRoot);
  });

  it("passes --source through when listing model candidates", async () => {
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-model-root-"));
    const source = mkdtempSync(path.join(tmpdir(), "sbv2-cli-model-source-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    writeFileSync(
      path.join(source, "config.json"),
      JSON.stringify(makeModelConfig("external-model")),
    );
    writeFileSync(path.join(source, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(source, "external-model_e1_s100.safetensors"), makeSafetensors());

    const stdout = createWriter();
    await expect(
      runCli(
        [
          "models",
          "candidates",
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "external-model",
          "--source",
          source,
          "--json",
        ],
        { stdout: stdout.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(stdout.output()) as {
      candidates: Array<{ sourceDir: string; promotable: boolean }>;
    };
    expect(result.candidates[0]).toMatchObject({ sourceDir: source, promotable: true });
  });

  it("explains bridge workspaces passed as model candidate sources", async () => {
    const datasetsRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-datasets-"));
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-root-"));
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-source-"));
    writeFileSync(path.join(sourceRoot, "a.wav"), "a");

    const ingestOut = createWriter();
    await expect(
      runCli(
        [
          "datasets",
          "ingest",
          "--datasets-dir",
          datasetsRoot,
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "workspace-source",
          "--source",
          sourceRoot,
          "--language",
          "ja",
          "--use-jp-extra",
          "--json",
        ],
        { stdout: ingestOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const ingested = JSON.parse(ingestOut.output()) as {
      pathRoles: { bridgeState: string };
    };

    const candidatesOut = createWriter();
    await expect(
      runCli(
        [
          "models",
          "candidates",
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "workspace-source",
          "--source",
          ingested.pathRoles.bridgeState,
          "--json",
        ],
        { stdout: candidatesOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);

    const result = JSON.parse(candidatesOut.output()) as {
      candidates: Array<{ errors: string[]; promotable: boolean }>;
    };
    expect(result.candidates[0].promotable).toBe(false);
    expect(result.candidates[0].errors.join("\n")).toContain("bridge dataset/job workspace");
    expect(result.candidates[0].errors.join("\n")).toContain(path.join(sbv2Root, "model_assets", "workspace-source"));
  });

  it("requires exact confirmation before model promotion", async () => {
    const stderr = createWriter();
    await expect(
      runCli(
        [
          "models",
          "promote",
          "--jobs-dir",
          tempJobsRoot(),
          "--sbv2-root",
          mkdtempSync(path.join(tmpdir(), "sbv2-cli-model-root-")),
          "--model-name",
          "cli-model",
          "--confirm-model-name",
          "wrong",
        ],
        { stdout: createWriter().stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(1);
    expect(stderr.output()).toContain("--confirm-model-name must exactly match cli-model");
  });

  it("runs evaluation commands and records listening notes", async () => {
    const jobsRoot = tempJobsRoot();
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-eval-root-"));
    const modelDir = path.join(sbv2Root, "model_assets", "eval-model");
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig("eval-model")));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(modelDir, "eval-model_e1_s100.safetensors"), makeSafetensors());

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => makeWav().buffer,
      })),
    );

    const evalOut = createWriter();
    await expect(
      runCli(
        [
          "evaluation",
          "run",
          "--jobs-dir",
          jobsRoot,
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "eval-model",
          "--base-url",
          "http://localhost:5000",
          "--json",
        ],
        { stdout: evalOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);

    const evaluated = JSON.parse(evalOut.output()) as {
      summary: { recommendation: string; successCount: number };
      job: { outputDir: string; operation: string };
    };
    expect(evaluated.summary).toMatchObject({
      recommendation: "adopt_candidate",
      successCount: 5,
    });
    expect(evaluated.job.operation).toBe("model-evaluate");

    const evaluationPath = path.join(evaluated.job.outputDir, "evaluation.json");
    const noteOut = createWriter();
    await expect(
      runCli(
        [
          "evaluation",
          "note",
          "--evaluation",
          evaluationPath,
          "--case",
          "ja-short",
          "--decision",
          "hold",
          "--message",
          "needs listening review",
          "--json",
        ],
        { stdout: noteOut.stream, stderr: createWriter().stream },
      ),
    ).resolves.toBe(0);
    const noted = JSON.parse(noteOut.output()) as {
      evaluation: { decision: string; recommendation: string; notes: unknown[] };
    };
    expect(noted.evaluation).toMatchObject({
      decision: "hold",
      recommendation: "hold",
    });
    expect(noted.evaluation.notes).toHaveLength(1);

    const summaryOut = createWriter();
    await expect(
      runCli(["evaluation", "summary", "--evaluation", evaluationPath], {
        stdout: summaryOut.stream,
        stderr: createWriter().stream,
      }),
    ).resolves.toBe(0);
    expect(summaryOut.output()).toContain("eval-model");
    expect(summaryOut.output()).toContain("hold");
  });

  it("blocks promotion when an evaluation explicitly rejects the model", async () => {
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-eval-root-"));
    const modelDir = path.join(sbv2Root, "model_assets", "rejected-model");
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig("rejected-model")));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
    writeFileSync(path.join(modelDir, "rejected-model_e1_s100.safetensors"), makeSafetensors());
    const evaluationPath = path.join(mkdtempSync(path.join(tmpdir(), "sbv2-cli-eval-")), "evaluation.json");
    writeFileSync(
      evaluationPath,
      JSON.stringify({
        schemaVersion: 1,
        modelName: "rejected-model",
        sourceDir: modelDir,
        candidate: { sourceDir: modelDir },
        decision: "reject",
        recommendation: "reject",
      }),
    );

    const stderr = createWriter();
    await expect(
      runCli(
        [
          "models",
          "promote",
          "--jobs-dir",
          tempJobsRoot(),
          "--sbv2-root",
          sbv2Root,
          "--model-name",
          "rejected-model",
          "--confirm-model-name",
          "rejected-model",
          "--evaluation",
          evaluationPath,
        ],
        { stdout: createWriter().stream, stderr: stderr.stream },
      ),
    ).resolves.toBe(1);
    expect(stderr.output()).toContain("Model evaluation does not allow promotion");
  });
});
