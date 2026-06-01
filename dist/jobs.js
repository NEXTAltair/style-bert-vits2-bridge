import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
export const DEFAULT_JOBS_ROOT = "~/.openclaw/state/style-bert-vits2-bridge/jobs";
function resolveUserPath(value) {
    if (value === "~") {
        return homedir();
    }
    if (value.startsWith("~/")) {
        return path.join(homedir(), value.slice(2));
    }
    return path.resolve(value);
}
export function resolveJobsRoot(value) {
    return resolveUserPath(value?.trim() || DEFAULT_JOBS_ROOT);
}
function manifestPath(jobDir) {
    return path.join(jobDir, "manifest.json");
}
function logPath(jobDir) {
    return path.join(jobDir, "job.log");
}
function makeJobId(now, randomId) {
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `sbv2-job-${stamp}-${randomId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}
function assertSafeJobId(jobId) {
    if (!/^sbv2-job-[a-zA-Z0-9-]+$/.test(jobId)) {
        throw new Error(`Invalid SBV2 job id: ${jobId}`);
    }
}
export async function createJobManifest(options) {
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const created = now();
    const jobId = makeJobId(created, randomId);
    const root = resolveJobsRoot(options.jobsRoot);
    const jobDir = path.join(root, jobId);
    const resolvedLogPath = logPath(jobDir);
    const startedAt = now().toISOString();
    const finishedAt = now().toISOString();
    const state = options.state ?? "succeeded";
    await mkdir(jobDir, { recursive: true });
    const manifest = {
        schemaVersion: 1,
        jobId,
        operation: options.operation,
        state,
        createdAt: created.toISOString(),
        startedAt,
        finishedAt,
        inputSummary: options.inputSummary,
        outputDir: jobDir,
        artifactPaths: options.artifactPaths ?? [],
        logPath: resolvedLogPath,
        firstError: options.firstError ?? null,
        retryable: options.retryable ?? false,
        cancellation: options.cancellation ?? {
            supported: false,
            reason: "This job is already complete and cannot be cancelled.",
        },
        progressSummary: options.progressSummary,
    };
    const logLines = options.logLines ?? [options.progressSummary];
    await writeFile(resolvedLogPath, [
        `[${startedAt}] ${options.operation} job started`,
        ...logLines.map((line) => `[${finishedAt}] ${line}`),
        `[${finishedAt}] ${options.operation} job ${state}`,
        "",
    ].join("\n"), "utf8");
    await writeFile(manifestPath(jobDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
}
export async function createDummyJob(options = {}) {
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
    const manifest = {
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
    await writeFile(resolvedLogPath, [
        `[${startedAt}] dummy job started`,
        `[${finishedAt}] ${message}`,
        `[${finishedAt}] dummy job ${failed ? "failed" : "succeeded"}`,
        "",
    ].join("\n"), "utf8");
    await writeFile(manifestPath(jobDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
}
export async function readJobManifest(jobId, options = {}) {
    assertSafeJobId(jobId);
    const root = resolveJobsRoot(options.jobsRoot);
    const filePath = manifestPath(path.join(root, jobId));
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!isSbv2JobManifest(parsed)) {
        throw new Error(`Invalid SBV2 job manifest: ${filePath}`);
    }
    return parsed;
}
export async function listJobManifests(options = {}) {
    const root = resolveJobsRoot(options.jobsRoot);
    let entries;
    try {
        entries = await readdir(root);
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const results = await Promise.allSettled(entries
        .filter((entry) => entry.startsWith("sbv2-job-"))
        .map(async (entry) => readJobManifest(entry, { jobsRoot: root })));
    const jobs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
export async function tailJobLog(jobId, options = {}) {
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
export async function cancelJob(jobId, options = {}) {
    const job = await readJobManifest(jobId, options);
    return {
        ok: false,
        job,
        reason: job.cancellation.reason ?? "This job does not support cancellation.",
    };
}
export async function resumeJob(jobId, options = {}) {
    const job = await readJobManifest(jobId, options);
    return {
        ok: false,
        job,
        reason: "Dummy jobs are synchronous terminal jobs and cannot be resumed.",
    };
}
export async function retryJob(jobId, options = {}) {
    const sourceJob = await readJobManifest(jobId, options);
    if (sourceJob.operation !== "dummy") {
        return {
            ok: false,
            sourceJob,
            reason: "Only dummy jobs support retry in this CLI version.",
        };
    }
    if (!sourceJob.retryable) {
        return {
            ok: false,
            sourceJob,
            reason: "This job is not marked retryable.",
        };
    }
    const message = typeof sourceJob.inputSummary.message === "string"
        ? sourceJob.inputSummary.message
        : "dummy retry completed";
    const job = await createDummyJob({
        jobsRoot: options.jobsRoot,
        message,
        retriedFrom: sourceJob.jobId,
    });
    return { ok: true, sourceJob, job };
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSbv2JobManifest(value) {
    return (isRecord(value) &&
        value.schemaVersion === 1 &&
        typeof value.jobId === "string" &&
        (value.operation === "dummy" || value.operation === "dataset-ingest") &&
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
        typeof value.progressSummary === "string");
}
