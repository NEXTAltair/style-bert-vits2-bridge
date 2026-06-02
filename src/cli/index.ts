#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingestDataset, prepareDataset, type Sbv2DatasetLanguage } from "../datasets.js";
import {
  createTrainingPlan,
  parseTrainingStage,
  runTraining,
  type Sbv2TrainingSettings,
  type Sbv2TrainingStage,
} from "../training.js";
import {
  evaluateModelCandidate,
  readEvaluationManifest,
  updateEvaluationNote,
  type Sbv2EvaluationDecision,
} from "../evaluation.js";
import { listModelCandidates, promoteModel } from "../model-registry.js";
import {
  createModelMergePlan,
  parseModelMergeMethod,
  runModelMerge,
  type Sbv2ModelMergeMethod,
} from "../model-merge.js";
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
  confirmModelName?: string;
  backupExisting?: boolean;
  baseUrl?: string;
  language?: Sbv2DatasetLanguage;
  useJpExtra?: boolean;
  manifestPath?: string;
  testSetPath?: string;
  evaluationPath?: string;
  caseId?: string;
  decision?: Sbv2EvaluationDecision;
  mergeMethod?: Sbv2ModelMergeMethod;
  outputModelName?: string;
  confirmOutputModelName?: string;
  modelA?: string;
  modelAFile?: string;
  modelB?: string;
  modelBFile?: string;
  modelC?: string;
  modelCFile?: string;
  voiceWeight?: number;
  voicePitchWeight?: number;
  speechStyleWeight?: number;
  tempoWeight?: number;
  modelACoeff?: number;
  modelBCoeff?: number;
  modelCCoeff?: number;
  slerp?: boolean;
  stages?: Sbv2TrainingStage[];
  trainingSettings: Partial<Sbv2TrainingSettings>;
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
  training plan          Print an agent-safe SBV2 training plan without running it.
  training run           Run selected SBV2 training stages and write a job.
  models candidates      List promotable SBV2 model artifact candidates.
  models merge-plan      Print an agent-safe SBV2 model merge plan without running it.
  models merge-run       Run a planned SBV2 model merge and write a job.
  models promote         Promote model artifacts into SBV2 model_assets.
  evaluation run         Generate sample WAVs and an evaluation report for a model candidate.
  evaluation note        Add or update a human listening note in an evaluation report.
  evaluation summary     Print an evaluation report summary.
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
  --method <name>          Model merge method: usual, add-diff, weighted-sum, add-null.
  --output-model-name <name>
                            New model name for model merge output.
  --source <path>          Source audio file or directory for dataset ingest.
                            For models promote, source model artifact directory.
  --manifest <path>        Dataset manifest path for datasets prepare/training.
  --confirm-model-name <name>
                            Required exact model name confirmation for models promote.
  --confirm-output-model-name <name>
                            Required exact output model name confirmation for models merge-run.
  --model-a <name>         Model A for model merge.
  --model-a-file <name>    Model A top-level safetensors filename inside its model directory.
  --model-b <name>         Model B for model merge.
  --model-b-file <name>    Model B top-level safetensors filename inside its model directory.
  --model-c <name>         Model C for add-diff and weighted-sum.
  --model-c-file <name>    Model C top-level safetensors filename inside its model directory.
  --voice-weight <n>       Voice quality weight for usual/add-diff/add-null.
  --voice-pitch-weight <n> Voice pitch weight for usual/add-diff/add-null.
  --speech-style-weight <n>
                            Speech style weight for usual/add-diff/add-null.
  --tempo-weight <n>       Tempo weight for usual/add-diff/add-null.
  --model-a-coeff <n>      Model A coefficient for weighted-sum.
  --model-b-coeff <n>      Model B coefficient for weighted-sum.
  --model-c-coeff <n>      Model C coefficient for weighted-sum.
  --slerp                  Use spherical interpolation for usual merge.
  --backup-existing        Back up an existing model_assets target before promoting.
  --base-url <url>         SBV2 API base URL for /models/refresh and /models/info checks.
  --test-set <path>        JSON evaluation test set. Defaults to built-in Japanese cases.
  --evaluation <path>      Evaluation manifest path for evaluation note/summary.
  --case <id>              Evaluation test case id for evaluation note.
  --decision <mode>        Listening decision: adopt, hold, or reject.
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

function parseNonNegativeInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseFiniteNumber(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function parseLanguage(value: string | undefined): Sbv2DatasetLanguage {
  if (value === "ja" || value === "en" || value === "zh") {
    return value;
  }
  throw new Error("--language must be one of: ja, en, zh");
}

function parseYomiError(value: string | undefined): "raise" | "skip" | "use" {
  if (value === "raise" || value === "skip" || value === "use") {
    return value;
  }
  throw new Error("--yomi-error must be one of: raise, skip, use");
}

function parseEvaluationDecision(value: string | undefined): Sbv2EvaluationDecision {
  if (value === "adopt" || value === "hold" || value === "reject") {
    return value;
  }
  throw new Error("--decision must be one of: adopt, hold, reject");
}

function parseArgs(argv: string[]): ParsedCommand {
  const options: CliOptions = { json: false, fail: false, trainingSettings: {} };
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
    } else if (arg === "--method" && next) {
      options.mergeMethod = parseModelMergeMethod(next);
      index += 1;
    } else if (arg === "--output-model-name" && next) {
      options.outputModelName = next;
      index += 1;
    } else if (arg === "--source" && next) {
      options.sourceAudioPath = next;
      index += 1;
    } else if (arg === "--confirm-model-name" && next) {
      options.confirmModelName = next;
      index += 1;
    } else if (arg === "--confirm-output-model-name" && next) {
      options.confirmOutputModelName = next;
      index += 1;
    } else if (arg === "--model-a" && next) {
      options.modelA = next;
      index += 1;
    } else if (arg === "--model-a-file" && next) {
      options.modelAFile = next;
      index += 1;
    } else if (arg === "--model-b" && next) {
      options.modelB = next;
      index += 1;
    } else if (arg === "--model-b-file" && next) {
      options.modelBFile = next;
      index += 1;
    } else if (arg === "--model-c" && next) {
      options.modelC = next;
      index += 1;
    } else if (arg === "--model-c-file" && next) {
      options.modelCFile = next;
      index += 1;
    } else if (arg === "--voice-weight" && next) {
      options.voiceWeight = parseFiniteNumber(next, "--voice-weight");
      index += 1;
    } else if (arg === "--voice-pitch-weight" && next) {
      options.voicePitchWeight = parseFiniteNumber(next, "--voice-pitch-weight");
      index += 1;
    } else if (arg === "--speech-style-weight" && next) {
      options.speechStyleWeight = parseFiniteNumber(next, "--speech-style-weight");
      index += 1;
    } else if (arg === "--tempo-weight" && next) {
      options.tempoWeight = parseFiniteNumber(next, "--tempo-weight");
      index += 1;
    } else if (arg === "--model-a-coeff" && next) {
      options.modelACoeff = parseFiniteNumber(next, "--model-a-coeff");
      index += 1;
    } else if (arg === "--model-b-coeff" && next) {
      options.modelBCoeff = parseFiniteNumber(next, "--model-b-coeff");
      index += 1;
    } else if (arg === "--model-c-coeff" && next) {
      options.modelCCoeff = parseFiniteNumber(next, "--model-c-coeff");
      index += 1;
    } else if (arg === "--slerp") {
      options.slerp = true;
    } else if (arg === "--backup-existing") {
      options.backupExisting = true;
    } else if (arg === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (arg === "--manifest" && next) {
      options.manifestPath = next;
      index += 1;
    } else if (arg === "--test-set" && next) {
      options.testSetPath = next;
      index += 1;
    } else if (arg === "--evaluation" && next) {
      options.evaluationPath = next;
      index += 1;
    } else if (arg === "--case" && next) {
      options.caseId = next;
      index += 1;
    } else if (arg === "--decision" && next) {
      options.decision = parseEvaluationDecision(next);
      index += 1;
    } else if (arg === "--stage" && next) {
      options.stages = [...(options.stages ?? []), parseTrainingStage(next)];
      index += 1;
    } else if (arg === "--batch-size" && next) {
      options.trainingSettings.batchSize = parsePositiveInteger(next, "--batch-size");
      index += 1;
    } else if (arg === "--epochs" && next) {
      options.trainingSettings.epochs = parsePositiveInteger(next, "--epochs");
      index += 1;
    } else if (arg === "--save-every-steps" && next) {
      options.trainingSettings.saveEverySteps = parsePositiveInteger(next, "--save-every-steps");
      index += 1;
    } else if (arg === "--log-interval" && next) {
      options.trainingSettings.logInterval = parsePositiveInteger(next, "--log-interval");
      index += 1;
    } else if (arg === "--num-processes" && next) {
      options.trainingSettings.numProcesses = parsePositiveInteger(next, "--num-processes");
      index += 1;
    } else if (arg === "--val-per-lang" && next) {
      options.trainingSettings.valPerLang = parseNonNegativeInteger(next, "--val-per-lang");
      index += 1;
    } else if (arg === "--yomi-error" && next) {
      options.trainingSettings.yomiError = parseYomiError(next);
      index += 1;
    } else if (arg === "--normalize") {
      options.trainingSettings.normalize = true;
    } else if (arg === "--trim") {
      options.trainingSettings.trim = true;
    } else if (arg === "--skip-default-style") {
      options.trainingSettings.skipDefaultStyle = true;
    } else if (arg === "--speedup") {
      options.trainingSettings.speedup = true;
    } else if (arg === "--not-use-custom-batch-sampler") {
      options.trainingSettings.notUseCustomBatchSampler = true;
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

  if (
    positional[0] !== "jobs" &&
    positional[0] !== "datasets" &&
    positional[0] !== "training" &&
    positional[0] !== "models" &&
    positional[0] !== "evaluation"
  ) {
    throw new Error("Expected command group: jobs, datasets, training, models, or evaluation");
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

function buildModelMergeOptions(options: CliOptions) {
  return {
    sbv2Root: options.sbv2Root,
    method: requireValue(options.mergeMethod, "--method"),
    outputModelName: requireString(options.outputModelName, "--output-model-name"),
    modelA: requireString(options.modelA, "--model-a"),
    modelAFile: options.modelAFile,
    modelB: requireString(options.modelB, "--model-b"),
    modelBFile: options.modelBFile,
    modelC: options.modelC,
    modelCFile: options.modelCFile,
    weights: {
      voiceWeight: options.voiceWeight,
      voicePitchWeight: options.voicePitchWeight,
      speechStyleWeight: options.speechStyleWeight,
      tempoWeight: options.tempoWeight,
    },
    coefficients: {
      modelACoeff: options.modelACoeff,
      modelBCoeff: options.modelBCoeff,
      modelCCoeff: options.modelCCoeff,
    },
    slerp: options.slerp,
  };
}

function requireValue<T>(value: T | undefined, name: string): T {
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
        } else {
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
        } else {
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
          sourcePath: options.sourceAudioPath,
        });
        if (options.json) {
          printJson(stdout, { ok: true, candidates });
        } else {
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
      if (parsed.command === "merge-plan") {
        const result = await createModelMergePlan(buildModelMergeOptions(options));
        if (options.json) {
          printJson(stdout, { ok: true, plan: result });
        } else {
          writeLine(stdout, `model merge plan ${result.outputModelName}`);
          writeLine(stdout, `method: ${result.method}`);
          writeLine(stdout, `output: ${result.outputDir}`);
          writeLine(stdout, `compatible: ${result.compatibility.compatible ? "yes" : "no"}`);
          for (const error of result.compatibility.errors) writeLine(stdout, `error: ${error}`);
          for (const warning of result.compatibility.warnings) writeLine(stdout, `warning: ${warning}`);
          writeLine(stdout, `command: ${result.command.executable} ${result.command.args.slice(0, 3).join(" ")}`);
        }
        return result.compatibility.compatible ? 0 : 1;
      }
      if (parsed.command === "merge-run") {
        const result = await runModelMerge({
          ...buildModelMergeOptions(options),
          jobsRoot: options.jobsRoot,
          confirmOutputModelName: requireString(options.confirmOutputModelName, "--confirm-output-model-name"),
          baseUrl: options.baseUrl,
        });
        if (options.json) {
          printJson(stdout, { ok: true, plan: result.plan, candidate: result.candidate, summary: result.summary, job: result.job });
        } else {
          writeLine(stdout, `merged ${result.summary.outputModelName}`);
          writeLine(stdout, `method: ${result.summary.method}`);
          writeLine(stdout, `output: ${result.summary.outputDir}`);
          if (result.summary.refresh) {
            writeLine(stdout, `refresh: ${result.summary.refresh.foundInModelsInfo ? "found" : "missing"}`);
          }
          writeLine(stdout, `summary: ${result.job.outputDir}/summary.json`);
          writeLine(stdout, `job: ${result.job.jobId}`);
          writeLine(stdout, `log: ${result.job.logPath}`);
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
          evaluationPath: options.evaluationPath,
        });
        if (options.json) {
          printJson(stdout, { ok: true, candidate: result.candidate, summary: result.summary, job: result.job });
        } else {
          writeLine(stdout, `promoted ${result.summary.modelName}`);
          writeLine(stdout, `source: ${result.summary.sourceDir}`);
          writeLine(stdout, `target: ${result.summary.targetDir}`);
          if (result.summary.backupDir) writeLine(stdout, `backup: ${result.summary.backupDir}`);
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

    if (parsed.group === "evaluation") {
      if (parsed.command === "run") {
        const result = await evaluateModelCandidate({
          jobsRoot: options.jobsRoot,
          manifestPath: options.manifestPath,
          sbv2Root: options.sbv2Root,
          modelName: options.modelName,
          sourcePath: options.sourceAudioPath,
          baseUrl: requireString(options.baseUrl, "--base-url"),
          testSetPath: options.testSetPath,
        });
        if (options.json) {
          printJson(stdout, { ok: true, evaluation: result.evaluation, summary: result.summary, job: result.job });
        } else {
          writeLine(stdout, `evaluated ${result.summary.modelName}`);
          writeLine(stdout, `samples: ${result.summary.successCount}/${result.summary.sampleCount}`);
          writeLine(stdout, `recommendation: ${result.summary.recommendation}`);
          writeLine(stdout, `evaluation: ${result.job.outputDir}/evaluation.json`);
          writeLine(stdout, `summary: ${result.job.outputDir}/summary.json`);
          writeLine(stdout, `job: ${result.job.jobId}`);
          writeLine(stdout, `log: ${result.job.logPath}`);
        }
        return 0;
      }
      if (parsed.command === "note") {
        const evaluation = await updateEvaluationNote({
          evaluationPath: requireString(options.evaluationPath, "--evaluation"),
          caseId: requireString(options.caseId, "--case"),
          decision: options.decision ?? "hold",
          note: requireString(options.message, "--message"),
        });
        if (options.json) {
          printJson(stdout, { ok: true, evaluation });
        } else {
          writeLine(stdout, `noted ${evaluation.modelName}`);
          writeLine(stdout, `decision: ${evaluation.decision ?? "none"}`);
          writeLine(stdout, `recommendation: ${evaluation.recommendation}`);
        }
        return 0;
      }
      if (parsed.command === "summary") {
        const evaluation = await readEvaluationManifest(requireString(options.evaluationPath, "--evaluation"));
        if (options.json) {
          printJson(stdout, { ok: true, summary: evaluation });
        } else {
          writeLine(stdout, `${evaluation.modelName}\t${evaluation.recommendation}\t${evaluation.successCount}/${evaluation.sampleCount}`);
          for (const reason of evaluation.rationale) {
            writeLine(stdout, `reason: ${reason}`);
          }
        }
        return 0;
      }
      throw new Error(`Unknown evaluation command: ${parsed.command}`);
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
