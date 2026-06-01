#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  json: boolean;
  fail: boolean;
  message?: string;
  tailLines?: number;
}

interface ParsedCommand {
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
    `Usage: sbv2-bridge jobs <command> [options]

Commands:
  jobs start-dummy         Start a synchronous dummy job and write manifest/log files.
  jobs list                List known jobs.
  jobs status <jobId>      Print a job manifest.
  jobs log <jobId>         Print a job log.
  jobs cancel <jobId>      Report whether a job can be cancelled.
  jobs resume <jobId>      Report whether a job can be resumed.
  jobs retry <jobId>       Retry a retryable dummy job.

Options:
  --jobs-dir <path>        Job manifest/log root. Defaults to ~/.openclaw/state/style-bert-vits2-bridge/jobs.
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
    return { command: "help", args: [], options };
  }

  if (positional[0] !== "jobs") {
    throw new Error("Expected command group: jobs");
  }

  return {
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
