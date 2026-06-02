export declare const DEFAULT_JOBS_ROOT = "~/.openclaw/state/style-bert-vits2-bridge/jobs";
export type Sbv2JobState = "running" | "succeeded" | "failed" | "cancelled";
export type Sbv2JobOperation = "dummy" | "dataset-ingest" | "dataset-prepare" | "training-run" | "model-promote" | "model-evaluate";
export interface Sbv2JobCancellation {
    supported: boolean;
    reason?: string;
}
export interface Sbv2JobManifest {
    schemaVersion: 1;
    jobId: string;
    operation: Sbv2JobOperation;
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
export interface CreateJobManifestOptions {
    jobsRoot?: string;
    operation: Sbv2JobOperation;
    state?: Sbv2JobState;
    inputSummary: Record<string, unknown>;
    artifactPaths?: string[];
    progressSummary: string;
    logLines?: string[];
    firstError?: string | null;
    retryable?: boolean;
    cancellation?: Sbv2JobCancellation;
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
export type RetryJobResult = {
    ok: true;
    sourceJob: Sbv2JobManifest;
    job: Sbv2JobManifest;
} | {
    ok: false;
    sourceJob: Sbv2JobManifest;
    reason: string;
};
export declare function resolveJobsRoot(value: string | undefined): string;
export declare function createJobManifest(options: CreateJobManifestOptions): Promise<Sbv2JobManifest>;
export declare function createDummyJob(options?: CreateDummyJobOptions): Promise<Sbv2JobManifest>;
export declare function readJobManifest(jobId: string, options?: ReadJobOptions): Promise<Sbv2JobManifest>;
export declare function listJobManifests(options?: ReadJobOptions): Promise<Sbv2JobManifest[]>;
export declare function tailJobLog(jobId: string, options?: TailJobLogOptions): Promise<string>;
export declare function cancelJob(jobId: string, options?: ReadJobOptions): Promise<CancelJobResult>;
export declare function resumeJob(jobId: string, options?: ReadJobOptions): Promise<ResumeJobResult>;
export declare function retryJob(jobId: string, options?: ReadJobOptions): Promise<RetryJobResult>;
