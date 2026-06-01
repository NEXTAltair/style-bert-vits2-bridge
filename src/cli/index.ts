#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingestDataset, prepareDataset, type Sbv2DatasetLanguage } from "../datasets.js";
import {
  cancelJob,
  createDummyJob,
  listJobManifests,
  readJobManifest,
  resumeJob,
  retryJob,
  tailJobLog,
  type Sbv2JobManifest,
} from "../jobs.js";

interface CliIO {
  stdout?: Pick<typeof process.stdout, "write">;
  stderr?: Pick<typeof process.stderr, "write">;
}

interface CliOptions {
  jobsRoot?: string;
  datasetsRoot?: string;
  sbv2Root?: string;
  json: boolean;
  fail: boolean;
  message?: string;
  tailLines?: number;
  modelName?: string;
  sourceAudioPath?: string;
  language?: Sbv2DatasetLanguage;
  useJpExtra?: boolean;
  manifestPath?: string;
}

interface ParsedCommand {
  group: string;
  command: string;
  args: string[];
  options: CliOptions;
}

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

function writeLine(stream: Pick<typeof process.stdout, "write">, value: string): void {
  stream.write(`${value}\n`);
}

function printHelp(stdout: Pick<typeof process.stdout, "write">): void {
  writeLine(
    stdout,
    `Usage: sbv2-bridge <group> <command> [options]

Commands:
  datasets ingest        Copy audio into a bridge dataset workspace and write a manifest.
  datasets prepare       Run SBV2 slice/transcribe for an ingested dataset manifest.
  jobs start-dummy         Start a synchronous dummy job and write manifest/log files.
  jobs list                List known jobs.
  jobs status <jobId>      Print a job manifest.
  jobs log <jobId>         Print a job log.
  jobs cancel <jobId>      Report whether a job can be cancelled.
  jobs resume <jobId>      Report whether a job can be resumed.
  jobs retry <jobId>       Retry a retryable dummy job.

Options:
  --jobs-dir <path>        Job manifest/log root. Defaults to ~/.openclaw/state/style-bert-vits2-bridge/jobs.
  --datasets-dir <path>    Dataset workspace root. Defaults to ~/.openclaw/state/style-bert-vits2-bridge/datasets.
  --sbv2-root <path>       SBV2 repository root. Defaults to SBV2_ROOT, then ~/src/Style-Bert-VITS2.
  --model-name <name>      SBV2 model name for dataset ingest.
  --source <path>          Source audio file or directory for dataset ingest.
  --manifest <path>        Dataset manifest path for datasets prepare.
  --language <ja|en|zh>    Dataset language for downstream SBV2 transcription/preprocess.
  --use-jp-extra           Record JP-Extra as enabled for downstream production.
  --no-use-jp-extra        Record JP-Extra as disabled for downstream production.
  --fail                   Make start-dummy write a failed manifest.
  --message <text>         Dummy job log message.
  --tail <lines>           Print the last N log lines.
  --json                   Print machine-readable JSON.
  -h, --help               Show this help.`,
  );
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseLanguage(value: string | undefined): Sbv2DatasetLanguage {
  if (value === "ja" || value === "en" || value === "zh") {
    return value;
  }
  throw new Error("--language must be one of: ja, en, zh");
}

function parseArgs(argv: string[]): ParsedCommand {
  const options: CliOptions = { json: false, fail: false };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      positional.push("help");
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail") {
      options.fail = true;
    } else if (arg === "--jobs-dir" && next) {
      options.jobsRoot = next;
      index += 1;
    } else if (arg === "--datasets-dir" && next) {
      options.datasetsRoot = next;
      index += 1;
    } else if (arg === "--sbv2-root" && next) {
      options.sbv2Root = next;
      index += 1;
    } else if (arg === "--model-name" && next) {
      options.modelName = next;
      index += 1;
    } else if (arg === "--source" && next) {
      options.sourceAudioPath = next;
      index += 1;
    } else if (arg === "--manifest" && next) {
      options.manifestPath = next;
      index += 1;
    } else if (arg === "--language" && next) {
      options.language = parseLanguage(next);
      index += 1;
    } else if (arg === "--use-jp-extra") {
      options.useJpExtra = true;
    } else if (arg === "--no-use-jp-extra") {
      options.useJpExtra = false;
    } else if (arg === "--message" && next) {
      options.message = next;
      index += 1;
    } else if (arg === "--tail" && next) {
      options.tailLines = parsePositiveInteger(next, "--tail");
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional[0] === "help") {
    return { group: "help", command: "help", args: [], options };
  }

  if (positional[0] !== "jobs" && positional[0] !== "datasets") {
    throw new Error("Expected command group: jobs or datasets");
  }

  return {
    group: positional[0],
    command: positional[1] ?? "help",
    args: positional.slice(2),
    options,
  };
}

function formatJobSummary(job: Sbv2JobManifest): string {
  return `${job.jobId}\t${job.state}\t${job.operation}\t${job.createdAt}\t${job.progressSummary}`;
}

function printJson(stdout: Pick<typeof process.stdout, "write">, value: unknown): void {
  writeLine(stdout, JSON.stringify(value, null, 2));
}

function requireJobId(args: string[]): string {
  const jobId = args[0];
  if (!jobId) {
    throw new Error("Missing jobId");
  }
  return jobId;
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function requireBoolean(value: boolean | undefined, name: string): boolean {
  if (value === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const parsed = parseArgs(argv);
    const { options } = parsed;

    if (parsed.command === "help") {
      printHelp(stdout);
      return 0;
    }

    if (parsed.group === "datasets") {
      if (parsed.command === "prepare") {
        const result = await prepareDataset({
          jobsRoot: options.jobsRoot,
          manifestPath: requireString(options.manifestPath, "--manifest"),
        });
        if (options.json) {
          printJson(stdout, { ok: true, dataset: result.dataset, summary: result.summary, job: result.job });
        } else {
          writeLine(stdout, `prepared ${result.dataset.workspaceId}`);
          writeLine(stdout, `model: ${result.dataset.modelName}`);
          writeLine(stdout, `raw wavs: ${result.summary.rawWavCount}`);
          writeLine(stdout, `esd lines: ${result.summary.esdLineCount}`);
          writeLine(stdout, `summary: ${result.job.outputDir}/summary.json`);
          writeLine(stdout, `job: ${result.job.jobId}`);
          writeLine(stdout, `log: ${result.job.logPath}`);
        }
        return 0;
      }
      if (parsed.command !== "ingest") {
        throw new Error(`Unknown datasets command: ${parsed.command}`);
      }
      const result = await ingestDataset({
        datasetsRoot: options.datasetsRoot,
        jobsRoot: options.jobsRoot,
        sbv2Root: options.sbv2Root,
        modelName: requireString(options.modelName, "--model-name"),
        sourceAudioPath: requireString(options.sourceAudioPath, "--source"),
        language: options.language ?? "ja",
        useJpExtra: requireBoolean(options.useJpExtra, "--use-jp-extra or --no-use-jp-extra"),
      });
      if (options.json) {
        printJson(stdout, { ok: true, dataset: result.dataset, job: result.job });
      } else {
        writeLine(stdout, `ingested ${result.dataset.workspaceId}`);
        writeLine(stdout, `model: ${result.dataset.modelName}`);
        writeLine(stdout, `files: ${result.dataset.files.length}`);
        writeLine(stdout, `manifest: ${result.dataset.manifestPath}`);
        writeLine(stdout, `job: ${result.job.jobId}`);
        writeLine(stdout, `log: ${result.job.logPath}`);
      }
      return 0;
    }

    if (parsed.command === "start-dummy") {
      const job = await createDummyJob({
        jobsRoot: options.jobsRoot,
        message: options.message,
        fail: options.fail,
      });
      if (options.json) {
        printJson(stdout, { ok: true, job });
      } else {
        writeLine(stdout, `started ${job.jobId}`);
        writeLine(stdout, `state: ${job.state}`);
        writeLine(stdout, `manifest: ${job.outputDir}/manifest.json`);
        writeLine(stdout, `log: ${job.logPath}`);
      }
      return 0;
    }

    if (parsed.command === "list") {
      const jobs = await listJobManifests({ jobsRoot: options.jobsRoot });
      if (options.json) {
        printJson(stdout, { ok: true, jobs });
      } else if (jobs.length) {
        for (const job of jobs) {
          writeLine(stdout, formatJobSummary(job));
        }
      } else {
        writeLine(stdout, "No SBV2 jobs found.");
      }
      return 0;
    }

    if (parsed.command === "status") {
      const job = await readJobManifest(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
      if (options.json) {
        printJson(stdout, { ok: true, job });
      } else {
        writeLine(stdout, formatJobSummary(job));
        writeLine(stdout, `log: ${job.logPath}`);
      }
      return 0;
    }

    if (parsed.command === "log") {
      const text = await tailJobLog(requireJobId(parsed.args), {
        jobsRoot: options.jobsRoot,
        lines: options.tailLines,
      });
      stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      return 0;
    }

    if (parsed.command === "cancel") {
      const result = await cancelJob(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
      if (options.json) {
        printJson(stdout, result);
      } else {
        writeLine(stdout, `cancel unsupported for ${result.job.jobId}: ${result.reason}`);
      }
      return 2;
    }

    if (parsed.command === "resume") {
      const result = await resumeJob(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
      if (options.json) {
        printJson(stdout, result);
      } else {
        writeLine(stdout, `resume unsupported for ${result.job.jobId}: ${result.reason}`);
      }
      return 2;
    }

    if (parsed.command === "retry") {
      const result = await retryJob(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
      if (options.json) {
        printJson(stdout, result);
      } else if (result.ok) {
        writeLine(stdout, `retried ${result.sourceJob.jobId} as ${result.job.jobId}`);
        writeLine(stdout, `state: ${result.job.state}`);
        writeLine(stdout, `manifest: ${result.job.outputDir}/manifest.json`);
        writeLine(stdout, `log: ${result.job.logPath}`);
      } else {
        writeLine(stdout, `retry unsupported for ${result.sourceJob.jobId}: ${result.reason}`);
      }
      return result.ok ? 0 : 2;
    }

    throw new Error(`Unknown jobs command: ${parsed.command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(stderr, `sbv2-bridge: ${message}`);
    return 1;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli(process.argv.slice(2));
}
