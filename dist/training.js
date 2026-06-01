import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { availableParallelism, homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJobManifest } from "./jobs.js";
import { readDatasetManifest } from "./datasets.js";
export const DEFAULT_TRAINING_STAGES = [
    "initialize",
    "resample",
    "preprocess-text",
    "bert-gen",
    "style-gen",
    "train",
];
const DEFAULT_TRAINING_SETTINGS = {
    batchSize: 2,
    epochs: 100,
    saveEverySteps: 1000,
    logInterval: 200,
    normalize: false,
    trim: false,
    numProcesses: Math.max(1, Math.floor(availableParallelism() / 2)),
    valPerLang: 0,
    yomiError: "skip",
    skipDefaultStyle: false,
    speedup: false,
    notUseCustomBatchSampler: false,
    freezeEnBert: false,
    freezeJpBert: false,
    freezeZhBert: false,
    freezeStyle: false,
    freezeDecoder: false,
};
export async function createTrainingPlan(options) {
    const dataset = await readDatasetManifest(resolveUserPath(options.manifestPath));
    validateModelName(dataset.modelName);
    const stageSelection = normalizeStages(options.stages);
    const settings = normalizeSettings(options.settings);
    const pathConfig = await readSbv2PathConfig(dataset.sbv2Root);
    const datasetPath = path.join(pathConfig.datasetRoot, dataset.modelName);
    const assetsPath = path.join(pathConfig.assetsRoot, dataset.modelName);
    const expectedOutputs = {
        rawDir: path.join(datasetPath, "raw"),
        esdListPath: path.join(datasetPath, "esd.list"),
        wavsDir: path.join(datasetPath, "wavs"),
        trainListPath: path.join(datasetPath, "train.list"),
        valListPath: path.join(datasetPath, "val.list"),
        configJsonPath: path.join(datasetPath, "config.json"),
        modelsDir: path.join(datasetPath, "models"),
        assetsPath,
    };
    const commands = buildTrainingCommands(dataset, stageSelection, settings, datasetPath, assetsPath, expectedOutputs);
    const warnings = [
        "Live SBV2 training completion is outside this wrapper verification scope.",
        ...(dataset.warnings ?? []),
    ];
    return {
        dataset,
        plan: {
            schemaVersion: 1,
            workspaceId: dataset.workspaceId,
            modelName: dataset.modelName,
            useJpExtra: dataset.useJpExtra,
            sbv2Root: dataset.sbv2Root,
            datasetPath,
            assetsPath,
            stages: stageSelection,
            settings,
            expectedOutputs,
            commands,
            warnings,
        },
    };
}
export async function runTraining(options) {
    const { dataset, plan } = await createTrainingPlan(options);
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const runner = options.commandRunner ?? runSbv2Command;
    const logLines = [`training run started for ${plan.modelName}`];
    const artifactPaths = [resolveUserPath(options.manifestPath), plan.expectedOutputs.configJsonPath];
    const fail = async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "training-run",
            state: "failed",
            inputSummary: {
                workspaceId: plan.workspaceId,
                modelName: plan.modelName,
                datasetManifestPath: resolveUserPath(options.manifestPath),
                failureClass: classifyFailure(message),
            },
            artifactPaths,
            firstError: message,
            retryable: false,
            progressSummary: `Training run failed for ${plan.modelName}.`,
            logLines: [...logLines, message],
            now,
            randomId,
        });
        throw error;
    };
    try {
        await preflightTrainingPlan(plan);
        let originalConfigYml = null;
        let configYmlPath = null;
        try {
            if (plan.stages.includes("initialize")) {
                const config = await initializeTrainingConfig(plan);
                originalConfigYml = config.originalConfigYml;
                configYmlPath = config.configYmlPath;
                await validateStageOutput(plan, "initialize");
                logLines.push(`generated training config: ${plan.expectedOutputs.configJsonPath}`);
            }
            else if (plan.stages.includes("train")) {
                const config = await writeSbv2ConfigYml(plan);
                originalConfigYml = config.originalConfigYml;
                configYmlPath = config.configYmlPath;
                logLines.push(`updated SBV2 config.yml for training: ${configYmlPath}`);
            }
            for (const command of plan.commands) {
                await runAndLogTrainingCommand(runner, command, logLines);
                await validateStageOutput(plan, command.stage);
            }
        }
        finally {
            if (configYmlPath && originalConfigYml !== null) {
                try {
                    await writeFile(configYmlPath, originalConfigYml, "utf8");
                    logLines.push(`restored SBV2 config.yml: ${configYmlPath}`);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    plan.warnings.push(`Failed to restore SBV2 config.yml: ${message}`);
                    logLines.push(`warning: failed to restore SBV2 config.yml: ${message}`);
                }
            }
        }
        const job = await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "training-run",
            inputSummary: {
                workspaceId: plan.workspaceId,
                modelName: plan.modelName,
                datasetManifestPath: resolveUserPath(options.manifestPath),
                stages: plan.stages,
                datasetPath: plan.datasetPath,
                assetsPath: plan.assetsPath,
            },
            artifactPaths,
            progressSummary: `Training run completed for ${plan.modelName}.`,
            logLines: [
                ...logLines,
                `stages: ${plan.stages.join(", ")}`,
                `training run succeeded for ${plan.modelName}`,
            ],
            now,
            randomId,
        });
        const summaryPath = path.join(job.outputDir, "summary.json");
        await writeFile(summaryPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
        const updatedJob = {
            ...job,
            artifactPaths: [...job.artifactPaths, summaryPath],
        };
        await writeFile(path.join(job.outputDir, "manifest.json"), `${JSON.stringify(updatedJob, null, 2)}\n`, "utf8");
        return { dataset, plan, job: updatedJob };
    }
    catch (error) {
        return fail(error);
    }
}
export function parseTrainingStage(value) {
    if (isTrainingStage(value))
        return value;
    throw new Error(`Unknown training stage: ${value}`);
}
function buildTrainingCommands(dataset, stages, settings, datasetPath, assetsPath, outputs) {
    const commands = [];
    for (const stage of stages) {
        if (stage === "initialize")
            continue;
        if (stage === "resample") {
            const args = [
                "run",
                "python",
                "resample.py",
                "-i",
                outputs.rawDir,
                "-o",
                outputs.wavsDir,
                "--num_processes",
                String(settings.numProcesses),
                "--sr",
                "44100",
            ];
            if (settings.normalize)
                args.push("--normalize");
            if (settings.trim)
                args.push("--trim");
            commands.push({ stage, executable: "uv", args, cwd: dataset.sbv2Root });
        }
        else if (stage === "preprocess-text") {
            const args = [
                "run",
                "python",
                "preprocess_text.py",
                "--config-path",
                outputs.configJsonPath,
                "--transcription-path",
                outputs.esdListPath,
                "--train-path",
                outputs.trainListPath,
                "--val-path",
                outputs.valListPath,
                "--val-per-lang",
                String(settings.valPerLang),
                "--yomi_error",
                settings.yomiError,
                "--correct_path",
            ];
            if (dataset.useJpExtra)
                args.push("--use_jp_extra");
            commands.push({ stage, executable: "uv", args, cwd: dataset.sbv2Root });
        }
        else if (stage === "bert-gen") {
            commands.push({
                stage,
                executable: "uv",
                args: ["run", "python", "bert_gen.py", "--config", outputs.configJsonPath],
                cwd: dataset.sbv2Root,
            });
        }
        else if (stage === "style-gen") {
            commands.push({
                stage,
                executable: "uv",
                args: [
                    "run",
                    "python",
                    "style_gen.py",
                    "--config",
                    outputs.configJsonPath,
                    "--num_processes",
                    String(settings.numProcesses),
                ],
                cwd: dataset.sbv2Root,
            });
        }
        else if (stage === "train") {
            const trainScript = dataset.useJpExtra ? "train_ms_jp_extra.py" : "train_ms.py";
            const args = [
                "run",
                "python",
                trainScript,
                "--config",
                outputs.configJsonPath,
                "--model",
                datasetPath,
                "--assets_root",
                path.dirname(assetsPath),
            ];
            if (settings.skipDefaultStyle)
                args.push("--skip_default_style");
            if (settings.speedup)
                args.push("--speedup");
            if (settings.notUseCustomBatchSampler)
                args.push("--not_use_custom_batch_sampler");
            commands.push({ stage, executable: "uv", args, cwd: dataset.sbv2Root });
        }
    }
    return commands;
}
async function initializeTrainingConfig(plan) {
    const templatePath = path.join(plan.sbv2Root, "configs", plan.useJpExtra ? "config_jp_extra.json" : "config.json");
    const template = JSON.parse(await readFile(templatePath, "utf8"));
    const train = ensureRecord(template.train, "train");
    const data = ensureRecord(template.data, "data");
    template.model_name = plan.modelName;
    data.training_files = plan.expectedOutputs.trainListPath;
    data.validation_files = plan.expectedOutputs.valListPath;
    data.use_jp_extra = plan.useJpExtra;
    train.batch_size = plan.settings.batchSize;
    train.epochs = plan.settings.epochs;
    train.eval_interval = plan.settings.saveEverySteps;
    train.log_interval = plan.settings.logInterval;
    train.freeze_EN_bert = plan.settings.freezeEnBert;
    train.freeze_JP_bert = plan.settings.freezeJpBert;
    train.freeze_ZH_bert = plan.settings.freezeZhBert;
    train.freeze_style = plan.settings.freezeStyle;
    train.freeze_decoder = plan.settings.freezeDecoder;
    train.bf16_run = false;
    await mkdir(plan.datasetPath, { recursive: true });
    await writeFile(plan.expectedOutputs.configJsonPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    const pretrainedDir = path.join(plan.sbv2Root, plan.useJpExtra ? "pretrained_jp_extra" : "pretrained");
    await cp(pretrainedDir, plan.expectedOutputs.modelsDir, { recursive: true, errorOnExist: true, force: false });
    return writeSbv2ConfigYml(plan);
}
async function writeSbv2ConfigYml(plan) {
    const configYmlPath = path.join(plan.sbv2Root, "config.yml");
    const defaultConfigYmlPath = path.join(plan.sbv2Root, "default_config.yml");
    const originalConfigYml = await readFile(configYmlPath, "utf8").catch(async (error) => {
        if (isNodeError(error) && error.code === "ENOENT") {
            return readFile(defaultConfigYmlPath, "utf8");
        }
        throw error;
    });
    const updatedConfigYml = upsertYamlStringField(upsertYamlStringField(originalConfigYml, "model_name", plan.modelName), "dataset_path", plan.datasetPath);
    await writeFile(configYmlPath, updatedConfigYml, "utf8");
    return { originalConfigYml, configYmlPath };
}
async function preflightTrainingPlan(plan) {
    const requiredScripts = new Set();
    if (plan.stages.includes("resample"))
        requiredScripts.add("resample.py");
    if (plan.stages.includes("preprocess-text"))
        requiredScripts.add("preprocess_text.py");
    if (plan.stages.includes("bert-gen"))
        requiredScripts.add("bert_gen.py");
    if (plan.stages.includes("style-gen"))
        requiredScripts.add("style_gen.py");
    if (plan.stages.includes("train"))
        requiredScripts.add(plan.useJpExtra ? "train_ms_jp_extra.py" : "train_ms.py");
    for (const script of requiredScripts) {
        const scriptPath = path.join(plan.sbv2Root, script);
        if (!(await pathExists(scriptPath))) {
            throw new Error(`Required SBV2 training script was not found: ${scriptPath}`);
        }
    }
    if (plan.stages.includes("initialize")) {
        const templatePath = path.join(plan.sbv2Root, "configs", plan.useJpExtra ? "config_jp_extra.json" : "config.json");
        const pretrainedDir = path.join(plan.sbv2Root, plan.useJpExtra ? "pretrained_jp_extra" : "pretrained");
        if (!(await pathExists(templatePath))) {
            throw new Error(`Required SBV2 template config was not found: ${templatePath}`);
        }
        if (!(await pathExists(pretrainedDir))) {
            throw new Error(`Required SBV2 pretrained directory was not found: ${pretrainedDir}`);
        }
    }
    if (!(await pathExists(plan.expectedOutputs.rawDir))) {
        throw new Error(`Training raw directory was not found: ${plan.expectedOutputs.rawDir}`);
    }
    if (!(await pathExists(plan.expectedOutputs.esdListPath))) {
        throw new Error(`Training esd.list was not found: ${plan.expectedOutputs.esdListPath}`);
    }
    if (plan.stages.includes("initialize")) {
        if (await pathExists(plan.expectedOutputs.modelsDir)) {
            throw new Error(`Training models directory already exists: ${plan.expectedOutputs.modelsDir}`);
        }
    }
    if (plan.stages.includes("train") && (await pathExists(plan.assetsPath))) {
        throw new Error(`SBV2 model assets already exist: ${plan.assetsPath}`);
    }
    if (!plan.stages.includes("initialize") && plan.stages.some((stage) => stage !== "resample")) {
        if (!(await pathExists(plan.expectedOutputs.configJsonPath))) {
            throw new Error(`Training config.json was not found: ${plan.expectedOutputs.configJsonPath}`);
        }
    }
    if (!plan.stages.includes("resample") && plan.stages.some((stage) => ["style-gen", "train"].includes(stage))) {
        if (!(await pathExists(plan.expectedOutputs.wavsDir))) {
            throw new Error(`Training wavs directory was not found: ${plan.expectedOutputs.wavsDir}`);
        }
    }
    if (!plan.stages.includes("preprocess-text") && plan.stages.some((stage) => ["bert-gen", "style-gen", "train"].includes(stage))) {
        if (!(await pathExists(plan.expectedOutputs.trainListPath))) {
            throw new Error(`Training train.list was not found: ${plan.expectedOutputs.trainListPath}`);
        }
        if (!(await pathExists(plan.expectedOutputs.valListPath))) {
            throw new Error(`Training val.list was not found: ${plan.expectedOutputs.valListPath}`);
        }
    }
}
async function validateStageOutput(plan, stage) {
    const outputs = plan.expectedOutputs;
    const expected = stage === "initialize"
        ? [outputs.configJsonPath, outputs.modelsDir]
        : stage === "resample"
            ? [outputs.wavsDir]
            : stage === "preprocess-text"
                ? [outputs.trainListPath, outputs.valListPath]
                : stage === "train"
                    ? [outputs.assetsPath]
                    : [];
    for (const output of expected) {
        if (!(await pathExists(output))) {
            throw new Error(`Expected output for ${stage} was not found: ${output}`);
        }
    }
}
async function runSbv2Command(executable, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            options.onOutput?.("stdout", chunk);
        });
        child.stderr?.on("data", (chunk) => {
            options.onOutput?.("stderr", chunk);
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) {
                resolve({});
                return;
            }
            const signalText = signal ? ` signal ${signal}` : "";
            reject(new Error(`${executable} ${args.join(" ")} failed with exit code ${code ?? "unknown"}${signalText}`));
        });
    });
}
async function runAndLogTrainingCommand(runner, command, logLines) {
    logLines.push(`running ${command.stage}: ${command.executable} ${command.args.join(" ")}`);
    const result = await runner(command.executable, command.args, {
        cwd: command.cwd,
        stage: command.stage,
        onOutput: (stream, chunk) => appendCommandOutput(logLines, stream, chunk),
    });
    appendCommandOutput(logLines, "stdout", result.stdout ?? "");
    appendCommandOutput(logLines, "stderr", result.stderr ?? "");
}
function appendCommandOutput(logLines, stream, chunk) {
    for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
            logLines.push(`${stream}: ${trimmed}`);
        }
    }
}
function normalizeStages(stages) {
    const requested = stages?.length ? new Set(stages) : new Set(DEFAULT_TRAINING_STAGES);
    return DEFAULT_TRAINING_STAGES.filter((stage) => requested.has(stage));
}
function normalizeSettings(settings) {
    const merged = { ...DEFAULT_TRAINING_SETTINGS, ...(settings ?? {}) };
    for (const [name, value] of [
        ["batchSize", merged.batchSize],
        ["epochs", merged.epochs],
        ["saveEverySteps", merged.saveEverySteps],
        ["logInterval", merged.logInterval],
        ["numProcesses", merged.numProcesses],
        ["valPerLang", merged.valPerLang],
    ]) {
        if (!Number.isInteger(value) || value < 0 || (name !== "valPerLang" && value === 0)) {
            throw new Error(`${name} must be a positive integer`);
        }
    }
    if (!["raise", "skip", "use"].includes(merged.yomiError)) {
        throw new Error("yomiError must be one of: raise, skip, use");
    }
    return merged;
}
function isTrainingStage(value) {
    return DEFAULT_TRAINING_STAGES.includes(value);
}
function validateModelName(value) {
    if (!value.trim() || value === "." || value === ".." || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
        throw new Error(`Invalid SBV2 model name: ${value}`);
    }
}
function classifyFailure(message) {
    if (/not found|already exists|Invalid|must be/.test(message))
        return "preflight";
    if (/Expected output/.test(message))
        return "missing-output";
    if (/failed with exit code/.test(message))
        return "command-exit";
    return "unknown";
}
async function readSbv2PathConfig(sbv2Root) {
    const pathsPath = path.join(sbv2Root, "configs", "paths.yml");
    const defaultPathsPath = path.join(sbv2Root, "configs", "default_paths.yml");
    const configPath = (await pathExists(pathsPath))
        ? pathsPath
        : (await pathExists(defaultPathsPath))
            ? defaultPathsPath
            : null;
    if (!configPath) {
        return {
            datasetRoot: path.join(sbv2Root, "Data"),
            assetsRoot: path.join(sbv2Root, "model_assets"),
        };
    }
    const text = await readFile(configPath, "utf8");
    return {
        datasetRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "dataset_root") ?? "Data"),
        assetsRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "assets_root") ?? "model_assets"),
    };
}
function parseSimpleYamlString(text, key) {
    for (const line of text.split(/\r?\n/)) {
        const withoutComment = line.replace(/\s+#.*$/, "");
        const match = withoutComment.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
        if (!match || match[1] !== key)
            continue;
        const value = match[2].trim();
        return value ? value.replace(/^['"]|['"]$/g, "") : undefined;
    }
    return undefined;
}
function resolveSbv2ConfigPath(sbv2Root, value) {
    return path.isAbsolute(value) ? value : path.join(sbv2Root, value);
}
function upsertYamlStringField(text, key, value) {
    const line = `${key}: ${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}\\s*:.*$`, "m");
    if (pattern.test(text)) {
        return text.replace(pattern, line);
    }
    return `${line}\n${text}`;
}
function ensureRecord(value, name) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value;
    }
    throw new Error(`SBV2 template config is missing object: ${name}`);
}
async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return false;
        throw error;
    }
}
function resolveUserPath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return path.join(homedir(), value.slice(2));
    return path.resolve(value);
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
