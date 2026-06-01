#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingestDataset, prepareDataset } from "../datasets.js";
import { createTrainingPlan, parseTrainingStage, runTraining, } from "../training.js";
import { listModelCandidates, promoteModel } from "../model-registry.js";
import { cancelJob, createDummyJob, listJobManifests, readJobManifest, resumeJob, retryJob, tailJobLog, } from "../jobs.js";
export function isCliEntrypoint(moduleUrl, argvPath) {
    if (!argvPath)
        return false;
    try {
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
    }
    catch {
        return false;
    }
}
function writeLine(stream, value) {
    stream.write(`${value}\n`);
}
function printHelp(stdout) {
    writeLine(stdout, `Usage: sbv2-bridge <group> <command> [options]

Commands:
  datasets ingest        Copy audio into a bridge dataset workspace and write a manifest.
  datasets prepare       Run SBV2 slice/transcribe for an ingested dataset manifest.
  training plan          Print an agent-safe SBV2 training plan without running it.
  training run           Run selected SBV2 training stages and write a job.
  models candidates      List promotable SBV2 model artifact candidates.
  models promote         Promote model artifacts into SBV2 model_assets.
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
                            For models promote, source model artifact directory.
  --manifest <path>        Dataset manifest path for datasets prepare/training.
  --confirm-model-name <name>
                            Required exact model name confirmation for models promote.
  --backup-existing        Back up an existing model_assets target before promoting.
  --base-url <url>         SBV2 API base URL for /models/refresh and /models/info checks.
  --stage <name>           Training stage. May be repeated. Defaults to all stages.
  --batch-size <n>         Training batch size. Default 2.
  --epochs <n>             Training epochs. Default 100.
  --save-every-steps <n>   Checkpoint/eval interval. Default 1000.
  --log-interval <n>       Training log interval. Default 200.
  --num-processes <n>      Resample/style_gen process count.
  --val-per-lang <n>       Validation rows per speaker/language field. Default 0.
  --yomi-error <mode>      Yomi error mode: raise, skip, or use. Default skip.
  --normalize              Normalize audio during resample.
  --trim                   Trim leading/trailing silence during resample.
  --skip-default-style     Pass --skip_default_style to train_ms.
  --speedup                Pass --speedup to train_ms.
  --not-use-custom-batch-sampler
                            Pass --not_use_custom_batch_sampler to train_ms.
  --language <ja|en|zh>    Dataset language for downstream SBV2 transcription/preprocess.
  --use-jp-extra           Record JP-Extra as enabled for downstream production.
  --no-use-jp-extra        Record JP-Extra as disabled for downstream production.
  --fail                   Make start-dummy write a failed manifest.
  --message <text>         Dummy job log message.
  --tail <lines>           Print the last N log lines.
  --json                   Print machine-readable JSON.
  -h, --help               Show this help.`);
}
function parsePositiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}
function parseNonNegativeInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return parsed;
}
function parseLanguage(value) {
    if (value === "ja" || value === "en" || value === "zh") {
        return value;
    }
    throw new Error("--language must be one of: ja, en, zh");
}
function parseYomiError(value) {
    if (value === "raise" || value === "skip" || value === "use") {
        return value;
    }
    throw new Error("--yomi-error must be one of: raise, skip, use");
}
function parseArgs(argv) {
    const options = { json: false, fail: false, trainingSettings: {} };
    const positional = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === "--") {
            continue;
        }
        else if (arg === "--help" || arg === "-h") {
            positional.push("help");
        }
        else if (arg === "--json") {
            options.json = true;
        }
        else if (arg === "--fail") {
            options.fail = true;
        }
        else if (arg === "--jobs-dir" && next) {
            options.jobsRoot = next;
            index += 1;
        }
        else if (arg === "--datasets-dir" && next) {
            options.datasetsRoot = next;
            index += 1;
        }
        else if (arg === "--sbv2-root" && next) {
            options.sbv2Root = next;
            index += 1;
        }
        else if (arg === "--model-name" && next) {
            options.modelName = next;
            index += 1;
        }
        else if (arg === "--source" && next) {
            options.sourceAudioPath = next;
            index += 1;
        }
        else if (arg === "--confirm-model-name" && next) {
            options.confirmModelName = next;
            index += 1;
        }
        else if (arg === "--backup-existing") {
            options.backupExisting = true;
        }
        else if (arg === "--base-url" && next) {
            options.baseUrl = next;
            index += 1;
        }
        else if (arg === "--manifest" && next) {
            options.manifestPath = next;
            index += 1;
        }
        else if (arg === "--stage" && next) {
            options.stages = [...(options.stages ?? []), parseTrainingStage(next)];
            index += 1;
        }
        else if (arg === "--batch-size" && next) {
            options.trainingSettings.batchSize = parsePositiveInteger(next, "--batch-size");
            index += 1;
        }
        else if (arg === "--epochs" && next) {
            options.trainingSettings.epochs = parsePositiveInteger(next, "--epochs");
            index += 1;
        }
        else if (arg === "--save-every-steps" && next) {
            options.trainingSettings.saveEverySteps = parsePositiveInteger(next, "--save-every-steps");
            index += 1;
        }
        else if (arg === "--log-interval" && next) {
            options.trainingSettings.logInterval = parsePositiveInteger(next, "--log-interval");
            index += 1;
        }
        else if (arg === "--num-processes" && next) {
            options.trainingSettings.numProcesses = parsePositiveInteger(next, "--num-processes");
            index += 1;
        }
        else if (arg === "--val-per-lang" && next) {
            options.trainingSettings.valPerLang = parseNonNegativeInteger(next, "--val-per-lang");
            index += 1;
        }
        else if (arg === "--yomi-error" && next) {
            options.trainingSettings.yomiError = parseYomiError(next);
            index += 1;
        }
        else if (arg === "--normalize") {
            options.trainingSettings.normalize = true;
        }
        else if (arg === "--trim") {
            options.trainingSettings.trim = true;
        }
        else if (arg === "--skip-default-style") {
            options.trainingSettings.skipDefaultStyle = true;
        }
        else if (arg === "--speedup") {
            options.trainingSettings.speedup = true;
        }
        else if (arg === "--not-use-custom-batch-sampler") {
            options.trainingSettings.notUseCustomBatchSampler = true;
        }
        else if (arg === "--language" && next) {
            options.language = parseLanguage(next);
            index += 1;
        }
        else if (arg === "--use-jp-extra") {
            options.useJpExtra = true;
        }
        else if (arg === "--no-use-jp-extra") {
            options.useJpExtra = false;
        }
        else if (arg === "--message" && next) {
            options.message = next;
            index += 1;
        }
        else if (arg === "--tail" && next) {
            options.tailLines = parsePositiveInteger(next, "--tail");
            index += 1;
        }
        else if (arg.startsWith("--")) {
            throw new Error(`Unknown option: ${arg}`);
        }
        else {
            positional.push(arg);
        }
    }
    if (positional[0] === "help") {
        return { group: "help", command: "help", args: [], options };
    }
    if (positional[0] !== "jobs" && positional[0] !== "datasets" && positional[0] !== "training" && positional[0] !== "models") {
        throw new Error("Expected command group: jobs, datasets, training, or models");
    }
    return {
        group: positional[0],
        command: positional[1] ?? "help",
        args: positional.slice(2),
        options,
    };
}
function formatJobSummary(job) {
    return `${job.jobId}\t${job.state}\t${job.operation}\t${job.createdAt}\t${job.progressSummary}`;
}
function printJson(stdout, value) {
    writeLine(stdout, JSON.stringify(value, null, 2));
}
function requireJobId(args) {
    const jobId = args[0];
    if (!jobId) {
        throw new Error("Missing jobId");
    }
    return jobId;
}
function requireString(value, name) {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    return value;
}
function requireBoolean(value, name) {
    if (value === undefined) {
        throw new Error(`Missing ${name}`);
    }
    return value;
}
export async function runCli(argv, io = {}) {
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
                }
                else {
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
            }
            else {
                writeLine(stdout, `ingested ${result.dataset.workspaceId}`);
                writeLine(stdout, `model: ${result.dataset.modelName}`);
                writeLine(stdout, `files: ${result.dataset.files.length}`);
                writeLine(stdout, `manifest: ${result.dataset.manifestPath}`);
                writeLine(stdout, `job: ${result.job.jobId}`);
                writeLine(stdout, `log: ${result.job.logPath}`);
            }
            return 0;
        }
        if (parsed.group === "training") {
            const planOptions = {
                manifestPath: requireString(options.manifestPath, "--manifest"),
                stages: options.stages,
                settings: options.trainingSettings,
            };
            if (parsed.command === "plan") {
                const result = await createTrainingPlan(planOptions);
                if (options.json) {
                    printJson(stdout, { ok: true, dataset: result.dataset, plan: result.plan });
                }
                else {
                    writeLine(stdout, `training plan ${result.plan.workspaceId}`);
                    writeLine(stdout, `model: ${result.plan.modelName}`);
                    writeLine(stdout, `stages: ${result.plan.stages.join(", ")}`);
                    writeLine(stdout, `dataset: ${result.plan.datasetPath}`);
                    writeLine(stdout, `assets: ${result.plan.assetsPath}`);
                    for (const command of result.plan.commands) {
                        writeLine(stdout, `${command.stage}: ${command.executable} ${command.args.join(" ")}`);
                    }
                }
                return 0;
            }
            if (parsed.command === "run") {
                const result = await runTraining({
                    ...planOptions,
                    jobsRoot: options.jobsRoot,
                });
                if (options.json) {
                    printJson(stdout, { ok: true, dataset: result.dataset, plan: result.plan, job: result.job });
                }
                else {
                    writeLine(stdout, `training run ${result.plan.workspaceId}`);
                    writeLine(stdout, `model: ${result.plan.modelName}`);
                    writeLine(stdout, `stages: ${result.plan.stages.join(", ")}`);
                    writeLine(stdout, `summary: ${result.job.outputDir}/summary.json`);
                    writeLine(stdout, `job: ${result.job.jobId}`);
                    writeLine(stdout, `log: ${result.job.logPath}`);
                }
                return 0;
            }
            throw new Error(`Unknown training command: ${parsed.command}`);
        }
        if (parsed.group === "models") {
            if (parsed.command === "candidates") {
                const candidates = await listModelCandidates({
                    manifestPath: options.manifestPath,
                    sbv2Root: options.sbv2Root,
                    modelName: options.modelName,
                });
                if (options.json) {
                    printJson(stdout, { ok: true, candidates });
                }
                else {
                    for (const candidate of candidates) {
                        writeLine(stdout, `${candidate.candidateId}\t${candidate.promotable ? "promotable" : "blocked"}\t${candidate.sourceDir}`);
                        for (const error of candidate.errors) {
                            writeLine(stdout, `error: ${error}`);
                        }
                        for (const warning of candidate.warnings) {
                            writeLine(stdout, `warning: ${warning}`);
                        }
                    }
                }
                return 0;
            }
            if (parsed.command === "promote") {
                const result = await promoteModel({
                    jobsRoot: options.jobsRoot,
                    manifestPath: options.manifestPath,
                    sbv2Root: options.sbv2Root,
                    modelName: options.modelName,
                    sourcePath: options.sourceAudioPath,
                    confirmModelName: requireString(options.confirmModelName, "--confirm-model-name"),
                    backupExisting: options.backupExisting,
                    baseUrl: options.baseUrl,
                });
                if (options.json) {
                    printJson(stdout, { ok: true, candidate: result.candidate, summary: result.summary, job: result.job });
                }
                else {
                    writeLine(stdout, `promoted ${result.summary.modelName}`);
                    writeLine(stdout, `source: ${result.summary.sourceDir}`);
                    writeLine(stdout, `target: ${result.summary.targetDir}`);
                    if (result.summary.backupDir)
                        writeLine(stdout, `backup: ${result.summary.backupDir}`);
                    if (result.summary.refresh) {
                        writeLine(stdout, `refresh: ${result.summary.refresh.foundInModelsInfo ? "found" : "missing"}`);
                    }
                    writeLine(stdout, `summary: ${result.job.outputDir}/summary.json`);
                    writeLine(stdout, `job: ${result.job.jobId}`);
                    writeLine(stdout, `log: ${result.job.logPath}`);
                }
                return 0;
            }
            throw new Error(`Unknown models command: ${parsed.command}`);
        }
        if (parsed.command === "start-dummy") {
            const job = await createDummyJob({
                jobsRoot: options.jobsRoot,
                message: options.message,
                fail: options.fail,
            });
            if (options.json) {
                printJson(stdout, { ok: true, job });
            }
            else {
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
            }
            else if (jobs.length) {
                for (const job of jobs) {
                    writeLine(stdout, formatJobSummary(job));
                }
            }
            else {
                writeLine(stdout, "No SBV2 jobs found.");
            }
            return 0;
        }
        if (parsed.command === "status") {
            const job = await readJobManifest(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
            if (options.json) {
                printJson(stdout, { ok: true, job });
            }
            else {
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
            }
            else {
                writeLine(stdout, `cancel unsupported for ${result.job.jobId}: ${result.reason}`);
            }
            return 2;
        }
        if (parsed.command === "resume") {
            const result = await resumeJob(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
            if (options.json) {
                printJson(stdout, result);
            }
            else {
                writeLine(stdout, `resume unsupported for ${result.job.jobId}: ${result.reason}`);
            }
            return 2;
        }
        if (parsed.command === "retry") {
            const result = await retryJob(requireJobId(parsed.args), { jobsRoot: options.jobsRoot });
            if (options.json) {
                printJson(stdout, result);
            }
            else if (result.ok) {
                writeLine(stdout, `retried ${result.sourceJob.jobId} as ${result.job.jobId}`);
                writeLine(stdout, `state: ${result.job.state}`);
                writeLine(stdout, `manifest: ${result.job.outputDir}/manifest.json`);
                writeLine(stdout, `log: ${result.job.logPath}`);
            }
            else {
                writeLine(stdout, `retry unsupported for ${result.sourceJob.jobId}: ${result.reason}`);
            }
            return result.ok ? 0 : 2;
        }
        throw new Error(`Unknown jobs command: ${parsed.command}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeLine(stderr, `sbv2-bridge: ${message}`);
        return 1;
    }
}
if (isCliEntrypoint(import.meta.url, process.argv[1])) {
    process.exitCode = await runCli(process.argv.slice(2));
}
