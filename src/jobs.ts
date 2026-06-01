import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_JOBS_ROOT = "~/.openclaw/state/style-bert-vits2-bridge/jobs";

export type Sbv2JobState = "running" | "succeeded" | "failed" | "cancelled";

export interface Sbv2JobCancellation {
  supported: boolean;
  reason?: string;
}

export interface Sbv2JobManifest {
  schemaVersion: 1;
  jobId: string;
  operation: "dummy";
  state: Sbv2JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  inputSummary: Record<string, unknown>;
  outputDir: string;
  artifactPaths: string[];
  logPath: string;
  firstError: string | null;
  retryable: boolean;
  cancellation: Sbv2JobCancellation;
  progressSummary: string;
}

export interface CreateDummyJobOptions {
  jobsRoot?: string;
  message?: string;
  fail?: boolean;
  retriedFrom?: string;
  now?: () => Date;
  randomId?: () => string;
}

export interface ReadJobOptions {
  jobsRoot?: string;
}

export interface TailJobLogOptions extends ReadJobOptions {
  lines?: number;
}

export interface CancelJobResult {
  ok: false;
  job: Sbv2JobManifest;
  reason: string;
}

export type ResumeJobResult = CancelJobResult;

export type RetryJobResult =
  | {
      ok: true;
      sourceJob: Sbv2JobManifest;
      job: Sbv2JobManifest;
    }
  | {
      ok: false;
      sourceJob: Sbv2JobManifest;
      reason: string;
    };

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function resolveJobsRoot(value: string | undefined): string {
  return resolveUserPath(value?.trim() || DEFAULT_JOBS_ROOT);
}

function manifestPath(jobDir: string): string {
  return path.join(jobDir, "manifest.json");
}

function logPath(jobDir: string): string {
  return path.join(jobDir, "job.log");
}

function makeJobId(now: Date, randomId: () => string): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `sbv2-job-${stamp}-${randomId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}

function assertSafeJobId(jobId: string): void {
  if (!/^sbv2-job-[a-zA-Z0-9-]+$/.test(jobId)) {
    throw new Error(`Invalid SBV2 job id: ${jobId}`);
  }
}

export async function createDummyJob(options: CreateDummyJobOptions = {}): Promise<Sbv2JobManifest> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const created = now();
  const jobId = makeJobId(created, randomId);
  const root = resolveJobsRoot(options.jobsRoot);
  const jobDir = path.join(root, jobId);
  const resolvedLogPath = logPath(jobDir);
  const startedAt = now().toISOString();
  const finishedAt = now().toISOString();
  const message = options.message?.trim() || "dummy job completed";
  const failed = options.fail ?? false;

  await mkdir(jobDir, { recursive: true });

  const manifest: Sbv2JobManifest = {
    schemaVersion: 1,
    jobId,
    operation: "dummy",
    state: failed ? "failed" : "succeeded",
    createdAt: created.toISOString(),
    startedAt,
    finishedAt,
    inputSummary: {
      message,
      ...(options.retriedFrom ? { retriedFrom: options.retriedFrom } : {}),
    },
    outputDir: jobDir,
    artifactPaths: [],
    logPath: resolvedLogPath,
    firstError: failed ? "Dummy job failed by request." : null,
    retryable: failed,
    cancellation: {
      supported: false,
      reason: "Dummy jobs finish synchronously and cannot be cancelled.",
    },
    progressSummary: failed ? "Dummy job failed." : "Dummy job succeeded.",
  };

  await writeFile(
    resolvedLogPath,
    [
      `[${startedAt}] dummy job started`,
      `[${finishedAt}] ${message}`,
      `[${finishedAt}] dummy job ${failed ? "failed" : "succeeded"}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(manifestPath(jobDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifest;
}

export async function readJobManifest(jobId: string, options: ReadJobOptions = {}): Promise<Sbv2JobManifest> {
  assertSafeJobId(jobId);
  const root = resolveJobsRoot(options.jobsRoot);
  const filePath = manifestPath(path.join(root, jobId));
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isSbv2JobManifest(parsed)) {
    throw new Error(`Invalid SBV2 job manifest: ${filePath}`);
  }
  return parsed;
}

export async function listJobManifests(options: ReadJobOptions = {}): Promise<Sbv2JobManifest[]> {
  const root = resolveJobsRoot(options.jobsRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const results = await Promise.allSettled(
    entries
      .filter((entry) => entry.startsWith("sbv2-job-"))
      .map(async (entry) => readJobManifest(entry, { jobsRoot: root })),
  );
  const jobs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function tailJobLog(jobId: string, options: TailJobLogOptions = {}): Promise<string> {
  const manifest = await readJobManifest(jobId, options);
  const text = await readFile(manifest.logPath, "utf8");
  const lines = options.lines;
  if (lines === undefined || lines <= 0) {
    return text;
  }
  const logLines = text.split(/\r?\n/);
  while (logLines.at(-1) === "") {
    logLines.pop();
  }
  return logLines.slice(-lines).join("\n");
}

export async function cancelJob(jobId: string, options: ReadJobOptions = {}): Promise<CancelJobResult> {
  const job = await readJobManifest(jobId, options);
  return {
    ok: false,
    job,
    reason: job.cancellation.reason ?? "This job does not support cancellation.",
  };
}

export async function resumeJob(jobId: string, options: ReadJobOptions = {}): Promise<ResumeJobResult> {
  const job = await readJobManifest(jobId, options);
  return {
    ok: false,
    job,
    reason: "Dummy jobs are synchronous terminal jobs and cannot be resumed.",
  };
}

export async function retryJob(jobId: string, options: ReadJobOptions = {}): Promise<RetryJobResult> {
  const sourceJob = await readJobManifest(jobId, options);
  if (!sourceJob.retryable) {
    return {
      ok: false,
      sourceJob,
      reason: "This job is not marked retryable.",
    };
  }

  const message =
    typeof sourceJob.inputSummary.message === "string"
      ? sourceJob.inputSummary.message
      : "dummy retry completed";
  const job = await createDummyJob({
    jobsRoot: options.jobsRoot,
    message,
    retriedFrom: sourceJob.jobId,
  });

  return { ok: true, sourceJob, job };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSbv2JobManifest(value: unknown): value is Sbv2JobManifest {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.jobId === "string" &&
    value.operation === "dummy" &&
    typeof value.state === "string" &&
    typeof value.createdAt === "string" &&
    isRecord(value.inputSummary) &&
    typeof value.outputDir === "string" &&
    Array.isArray(value.artifactPaths) &&
    value.artifactPaths.every((entry) => typeof entry === "string") &&
    typeof value.logPath === "string" &&
    (typeof value.firstError === "string" || value.firstError === null) &&
    typeof value.retryable === "boolean" &&
    isRecord(value.cancellation) &&
    typeof value.cancellation.supported === "boolean" &&
    typeof value.progressSummary === "string"
  );
}
