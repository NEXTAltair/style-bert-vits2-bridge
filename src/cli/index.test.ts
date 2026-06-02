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
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-merge-root-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
    for (const modelName of ["model-a", "model-b", "model-c"]) {
      const modelDir = path.join(sbv2Root, "model_assets", modelName);
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeModelConfig(modelName)));
      writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy([1, 2]));
      writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors());
    }

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

    const parsed = JSON.parse(stdout.output()) as { plan: { method: string; coefficients: Record<string, number> } };
    expect(parsed.plan.method).toBe("weighted-sum");
    expect(parsed.plan.coefficients).toEqual({ modelACoeff: 1, modelBCoeff: -1, modelCCoeff: 0 });
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
      };

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
            "--json",
          ],
          { stdout: prepareOut.stream, stderr: prepareErr.stream },
        ),
      ).resolves.toBe(0);
      expect(prepareErr.output()).toBe("");
      const prepared = JSON.parse(prepareOut.output()) as {
        summary: { rawWavCount: number; esdLineCount: number };
        job: { operation: string };
      };
      expect(prepared.summary).toMatchObject({
        rawWavCount: 1,
        esdLineCount: 1,
      });
      expect(prepared.job.operation).toBe("dataset-prepare");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("prints a training plan and runs a selected training stage", async () => {
    const jobsRoot = tempJobsRoot();
    const datasetsRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-datasets-"));
    const sbv2Root = mkdtempSync(path.join(tmpdir(), "sbv2-cli-root-"));
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-source-"));
    const binRoot = mkdtempSync(path.join(tmpdir(), "sbv2-cli-bin-"));
    mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "dataset_root: Data\nassets_root: model_assets\n");
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
    };
    mkdirSync(path.join(sbv2Root, "Data", "cli-train", "raw"), { recursive: true });
    writeFileSync(path.join(sbv2Root, "Data", "cli-train", "raw", "a-0.wav"), "a");
    writeFileSync(path.join(sbv2Root, "Data", "cli-train", "esd.list"), "a-0.wav|cli-train|JP|こんにちは\n");

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
    };
    expect(planned.plan.stages).toEqual(["resample"]);
    expect(planned.plan.settings.batchSize).toBe(4);

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
      };
      expect(ran.job.operation).toBe("training-run");
      expect(ran.plan.stages).toEqual(["resample"]);
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
    };
    expect(candidates.candidates[0]).toMatchObject({
      modelName: "cli-model",
      promotable: true,
    });

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
    };
    expect(promoted.summary).toMatchObject({ modelName: "cli-model", copied: false });
    expect(promoted.job.operation).toBe("model-promote");
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
