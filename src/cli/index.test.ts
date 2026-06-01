import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

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
});
