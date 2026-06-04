import { mkdirSync, mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cancelJob,
  createDummyJob,
  createJobManifest,
  listJobManifests,
  readJobManifest,
  resolveJobsRoot,
  resumeJob,
  retryJob,
  tailJobLog,
} from "./jobs.js";

function tempJobsRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "sbv2-jobs-"));
}

describe("SBV2 jobs", () => {
  it("resolves the default user-level plugin state directory", () => {
    expect(resolveJobsRoot(undefined)).toMatch(
      /\/\.openclaw\/state\/style-bert-vits2-bridge\/jobs$/,
    );
  });

  it("creates a completed dummy job manifest and log", async () => {
    const jobsRoot = tempJobsRoot();
    const job = await createDummyJob({
      jobsRoot,
      message: "dummy check",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "abcdef123456",
    });

    expect(job).toMatchObject({
      jobId: "sbv2-job-20260601000000-abcdef12",
      operation: "dummy",
      state: "succeeded",
      firstError: null,
      retryable: false,
      cancellation: {
        supported: false,
        reason: "Dummy jobs finish synchronously and cannot be cancelled.",
      },
    });
    expect(job.outputDir).toBe(path.join(jobsRoot, job.jobId));
    expect(job.logPath).toBe(path.join(jobsRoot, job.jobId, "job.log"));

    const manifest = await readJobManifest(job.jobId, { jobsRoot });
    expect(manifest).toEqual(job);
    expect(readFileSync(job.logPath, "utf8")).toContain("dummy check");
  });

  it("creates running job manifests without a finished timestamp", async () => {
    const jobsRoot = tempJobsRoot();
    const job = await createJobManifest({
      jobsRoot,
      operation: "model-evaluate",
      state: "running",
      inputSummary: { modelName: "eval-voice" },
      progressSummary: "Model evaluation started.",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "running",
    });

    expect(job).toMatchObject({
      state: "running",
      cancellation: {
        supported: false,
        reason: "Cancellation is not supported for this job.",
      },
    });
    expect(job.finishedAt).toBeUndefined();
    await expect(readJobManifest(job.jobId, { jobsRoot })).resolves.toEqual(job);
  });

  it("reads and lists style merge job manifests", async () => {
    const jobsRoot = tempJobsRoot();
    const job = await createJobManifest({
      jobsRoot,
      operation: "model-style-merge",
      inputSummary: { outputModelName: "merged" },
      progressSummary: "Style merge completed.",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "stylejob",
    });

    await expect(readJobManifest(job.jobId, { jobsRoot })).resolves.toEqual(job);
    await expect(listJobManifests({ jobsRoot })).resolves.toEqual([job]);
  });

  it("lists jobs newest first", async () => {
    const jobsRoot = tempJobsRoot();
    const older = await createDummyJob({
      jobsRoot,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "older",
    });
    const newer = await createDummyJob({
      jobsRoot,
      now: () => new Date("2026-06-01T01:00:00.000Z"),
      randomId: () => "newer",
    });

    await expect(listJobManifests({ jobsRoot })).resolves.toEqual([newer, older]);
  });

  it("skips incomplete job directories when listing", async () => {
    const jobsRoot = tempJobsRoot();
    const job = await createDummyJob({
      jobsRoot,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "complete",
    });
    mkdirSync(path.join(jobsRoot, "sbv2-job-20260601010000-incomplete"));

    await expect(listJobManifests({ jobsRoot })).resolves.toEqual([job]);
  });

  it("records dummy failures with firstError and retryability", async () => {
    const jobsRoot = tempJobsRoot();
    const job = await createDummyJob({
      jobsRoot,
      fail: true,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "failed",
    });

    expect(job).toMatchObject({
      state: "failed",
      firstError: "Dummy job failed by request.",
      retryable: true,
      progressSummary: "Dummy job failed.",
    });
    await expect(tailJobLog(job.jobId, { jobsRoot, lines: 1 })).resolves.toContain(
      "dummy job failed",
    );
  });

  it("retries retryable dummy jobs into a new succeeded job", async () => {
    const jobsRoot = tempJobsRoot();
    const failed = await createDummyJob({
      jobsRoot,
      message: "retry target",
      fail: true,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "failed",
    });

    const result = await retryJob(failed.jobId, { jobsRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.job).toMatchObject({
      state: "succeeded",
      firstError: null,
      retryable: false,
      inputSummary: {
        message: "retry target",
        retriedFrom: failed.jobId,
      },
    });
  });

  it("tails job logs and reports unsupported cancellation", async () => {
    const jobsRoot = tempJobsRoot();
    const job = await createDummyJob({
      jobsRoot,
      message: "tail target",
      now: () => new Date("2026-06-01T00:00:00.000Z"),
      randomId: () => "tailtest",
    });

    await expect(tailJobLog(job.jobId, { jobsRoot, lines: 2 })).resolves.toContain(
      "dummy job succeeded",
    );
    await expect(cancelJob(job.jobId, { jobsRoot })).resolves.toMatchObject({
      ok: false,
      reason: "Dummy jobs finish synchronously and cannot be cancelled.",
      job,
    });
    await expect(resumeJob(job.jobId, { jobsRoot })).resolves.toMatchObject({
      ok: false,
      reason: "Synchronous terminal jobs cannot be resumed.",
      job,
    });
    await expect(retryJob(job.jobId, { jobsRoot })).resolves.toMatchObject({
      ok: false,
      reason: "This job is not marked retryable.",
      sourceJob: job,
    });
  });

  it("rejects unsafe job ids", async () => {
    await expect(readJobManifest("../escape", { jobsRoot: tempJobsRoot() })).rejects.toThrow(
      /Invalid SBV2 job id/,
    );
  });
});
