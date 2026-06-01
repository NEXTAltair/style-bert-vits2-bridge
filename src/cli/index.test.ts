import { chmodSync, mkdirSync, symlinkSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
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

describe("sbv2-bridge CLI", () => {
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
    writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({ model_name: "cli-model" }));
    writeFileSync(path.join(modelDir, "style_vectors.npy"), "style");
    writeFileSync(path.join(modelDir, "cli-model_e1_s100.safetensors"), "model");

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

  it("requires exact confirmation before model promotion", async () => {
    const stderr = createWriter();
    await expect(
      runCli(
        [
          "models",
          "promote",
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
});
