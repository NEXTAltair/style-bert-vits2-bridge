import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createJobManifest } from "./jobs.js";
import { Sbv2Client } from "./sbv2-client.js";
export async function createModelRenamePlan(options) {
    validateModelName(options.fromModelName, "--from-model-name");
    validateModelName(options.toModelName, "--to-model-name");
    if (options.fromModelName === options.toModelName) {
        throw new Error("--from-model-name and --to-model-name must differ");
    }
    if (options.renameEsdSpeaker && !options.includeData) {
        throw new Error("--rename-esd-speaker requires --include-data");
    }
    const sbv2Root = resolveUserPath(options.sbv2Root ?? process.env.SBV2_ROOT ?? "~/src/Style-Bert-VITS2");
    const roots = await readSbv2PathConfig(sbv2Root);
    const sourceAssetsDir = path.join(roots.assetsRoot, options.fromModelName);
    const targetAssetsDir = path.join(roots.assetsRoot, options.toModelName);
    const sourceDataDir = path.join(roots.datasetRoot, options.fromModelName);
    const targetDataDir = path.join(roots.datasetRoot, options.toModelName);
    const configJsonPath = path.join(sourceAssetsDir, "config.json");
    const targetConfigJsonPath = path.join(targetAssetsDir, "config.json");
    const styleVectorsPath = path.join(sourceAssetsDir, "style_vectors.npy");
    const errors = [];
    const warnings = [];
    const changes = [
        { kind: "path-move", from: sourceAssetsDir, to: targetAssetsDir },
    ];
    if (!(await isDirectory(sourceAssetsDir))) {
        errors.push(`source model assets directory was not found: ${sourceAssetsDir}`);
    }
    if (await pathExists(targetAssetsDir)) {
        errors.push(`target model assets already exist: ${targetAssetsDir}`);
    }
    const hasConfigJson = await isNonEmptyFile(configJsonPath);
    if (!hasConfigJson) {
        errors.push(`config.json is missing or empty: ${configJsonPath}`);
    }
    if (!(await isNonEmptyFile(styleVectorsPath))) {
        errors.push(`style_vectors.npy is missing or empty: ${styleVectorsPath}`);
    }
    const config = hasConfigJson ? await readConfigForPlan(configJsonPath, errors) : undefined;
    if (config) {
        const configModelName = readConfigModelName(config);
        if (configModelName !== options.fromModelName) {
            errors.push(`config.json model_name "${configModelName ?? ""}" does not match "${options.fromModelName}"`);
        }
        else {
            changes.push({
                kind: "json-field",
                path: configJsonPath,
                jsonPath: "model_name",
                from: options.fromModelName,
                to: options.toModelName,
            });
        }
        changes.push(...configSpeakerChanges(config, configJsonPath, options.fromModelName, options.toModelName));
    }
    const safetensorsKept = await listTopLevelFiles(sourceAssetsDir, ".safetensors");
    for (const filePath of safetensorsKept) {
        if (path.basename(filePath).includes(options.fromModelName)) {
            warnings.push(`safetensors filename contains the old model name but will not be changed: ${filePath}`);
        }
    }
    if (options.includeData) {
        if (await pathExists(targetDataDir)) {
            errors.push(`target dataset directory already exists: ${targetDataDir}`);
        }
        if (await pathExists(sourceDataDir)) {
            changes.push({ kind: "path-move", from: sourceDataDir, to: targetDataDir });
            if (options.renameEsdSpeaker) {
                const esdPath = path.join(sourceDataDir, "esd.list");
                const esdChange = await planEsdSpeakerChange(esdPath, options.fromModelName, options.toModelName);
                if (esdChange)
                    changes.push(esdChange);
            }
        }
        else {
            warnings.push(`dataset directory was not found and will not be moved: ${sourceDataDir}`);
        }
    }
    return {
        schemaVersion: 1,
        sbv2Root,
        assetsRoot: roots.assetsRoot,
        datasetRoot: roots.datasetRoot,
        fromModelName: options.fromModelName,
        toModelName: options.toModelName,
        sourceAssetsDir,
        targetAssetsDir,
        sourceDataDir,
        targetDataDir,
        includeData: Boolean(options.includeData),
        renameEsdSpeaker: Boolean(options.renameEsdSpeaker),
        configJsonPath,
        targetConfigJsonPath,
        styleVectorsPath,
        safetensorsKept,
        changes,
        compatibility: {
            compatible: errors.length === 0,
            errors,
            warnings,
        },
    };
}
export async function runModelRename(options) {
    const plan = await createModelRenamePlan(options);
    if (options.confirmToModelName !== plan.toModelName) {
        throw new Error(`--confirm-to-model-name must exactly match ${plan.toModelName}`);
    }
    if (!plan.compatibility.compatible) {
        throw new Error(`Model rename plan is not compatible: ${plan.compatibility.errors.join("; ")}`);
    }
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const logLines = [`model rename started from ${plan.fromModelName} to ${plan.toModelName}`];
    const rollbackActions = [];
    const rollbackWarnings = [];
    const changesApplied = [];
    let shouldRollback = true;
    let refreshForFailedJob;
    const buildSummary = (outputAssetsRetained) => ({
        schemaVersion: 1,
        fromModelName: plan.fromModelName,
        toModelName: plan.toModelName,
        sourceAssetsDir: plan.sourceAssetsDir,
        targetAssetsDir: plan.targetAssetsDir,
        sourceDataDir: plan.sourceDataDir,
        targetDataDir: plan.targetDataDir,
        plan,
        changesApplied,
        outputAssetsRetained,
        rollbackWarnings,
        ...(refreshForFailedJob ? { refresh: refreshForFailedJob } : {}),
        nextSteps: [
            ...(options.baseUrl
                ? [`sbv2-bridge evaluation run --model-name ${plan.toModelName} --base-url ${options.baseUrl} --json`]
                : ["Run SBV2 /models/refresh, then sbv2-bridge evaluation run with --base-url."]),
        ],
    });
    const fail = async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (shouldRollback) {
            await rollback(rollbackActions, rollbackWarnings, logLines);
        }
        const outputAssetsRetained = await pathExists(plan.targetAssetsDir);
        const job = await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "model-rename",
            state: "failed",
            inputSummary: buildModelRenameInputSummary(plan, {
                refresh: refreshForFailedJob,
                outputAssetsRetained,
            }),
            artifactPaths: outputAssetsRetained ? collectRenameArtifacts(plan) : [],
            firstError: message,
            retryable: false,
            progressSummary: `Model rename failed from ${plan.fromModelName} to ${plan.toModelName}.`,
            logLines: [...logLines, message],
            now,
            randomId,
        });
        const summaryPath = path.join(job.outputDir, "summary.json");
        await writeFile(summaryPath, `${JSON.stringify({ ...buildSummary(outputAssetsRetained), state: "failed", firstError: message }, null, 2)}\n`, "utf8");
        const updatedJob = {
            ...job,
            artifactPaths: [...job.artifactPaths, summaryPath],
        };
        await writeFile(path.join(job.outputDir, "manifest.json"), `${JSON.stringify(updatedJob, null, 2)}\n`, "utf8");
        throw error;
    };
    try {
        const originalConfig = await readFile(plan.configJsonPath, "utf8");
        const updatedConfig = updateConfigJson(JSON.parse(originalConfig), plan.fromModelName, plan.toModelName);
        await writeFile(plan.configJsonPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, "utf8");
        rollbackActions.push(async () => writeFile(plan.configJsonPath, originalConfig, "utf8"));
        changesApplied.push(...plan.changes.filter((change) => change.kind === "json-field"));
        logLines.push(`updated config.json for ${plan.toModelName}`);
        await mkdir(path.dirname(plan.targetAssetsDir), { recursive: true });
        await rename(plan.sourceAssetsDir, plan.targetAssetsDir);
        rollbackActions.push(async () => rename(plan.targetAssetsDir, plan.sourceAssetsDir));
        changesApplied.push({ kind: "path-move", from: plan.sourceAssetsDir, to: plan.targetAssetsDir });
        logLines.push(`moved model assets to ${plan.targetAssetsDir}`);
        if (plan.includeData && (await pathExists(plan.sourceDataDir))) {
            await mkdir(path.dirname(plan.targetDataDir), { recursive: true });
            await rename(plan.sourceDataDir, plan.targetDataDir);
            rollbackActions.push(async () => rename(plan.targetDataDir, plan.sourceDataDir));
            changesApplied.push({ kind: "path-move", from: plan.sourceDataDir, to: plan.targetDataDir });
            logLines.push(`moved dataset directory to ${plan.targetDataDir}`);
            if (plan.renameEsdSpeaker) {
                const esdPath = path.join(plan.targetDataDir, "esd.list");
                if (await pathExists(esdPath)) {
                    const originalEsd = await readFile(esdPath, "utf8");
                    const updatedEsd = rewriteEsdSpeaker(originalEsd, plan.fromModelName, plan.toModelName);
                    if (updatedEsd.changedLineCount > 0) {
                        await writeFile(esdPath, updatedEsd.text, "utf8");
                        rollbackActions.push(async () => writeFile(esdPath, originalEsd, "utf8"));
                        changesApplied.push({
                            kind: "esd-speaker",
                            path: esdPath,
                            from: plan.fromModelName,
                            to: plan.toModelName,
                            lineCount: updatedEsd.changedLineCount,
                        });
                        logLines.push(`updated ${updatedEsd.changedLineCount} esd.list speaker rows`);
                    }
                }
            }
        }
        shouldRollback = false;
        const summary = buildSummary(true);
        if (options.baseUrl) {
            refreshForFailedJob = {
                baseUrl: options.baseUrl,
                refreshed: false,
                foundNewInModelsInfo: false,
                foundOldInModelsInfo: false,
                modelsInfoCount: 0,
                outputAssetsRetained: true,
            };
            const modelsInfo = await new Sbv2Client({ baseUrl: options.baseUrl }).refreshModels();
            const foundNew = modelInfoContains(modelsInfo, plan.toModelName);
            const foundOld = modelInfoContains(modelsInfo, plan.fromModelName);
            summary.refresh = {
                baseUrl: options.baseUrl,
                refreshed: true,
                foundNewInModelsInfo: foundNew,
                foundOldInModelsInfo: foundOld,
                modelsInfoCount: modelsInfo.length,
                outputAssetsRetained: true,
            };
            refreshForFailedJob = summary.refresh;
            logLines.push(`refreshed SBV2 models from ${options.baseUrl}`);
            if (!foundNew || foundOld) {
                throw new Error(`Renamed model refresh verification failed: new=${foundNew ? "found" : "missing"}, old=${foundOld ? "still-present" : "absent"}`);
            }
        }
        const job = await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "model-rename",
            inputSummary: buildModelRenameInputSummary(plan, { refresh: summary.refresh, outputAssetsRetained: true }),
            artifactPaths: collectRenameArtifacts(plan),
            progressSummary: `Model rename completed from ${plan.fromModelName} to ${plan.toModelName}.`,
            logLines: [...logLines, `model rename succeeded for ${plan.toModelName}`],
            now,
            randomId,
        });
        const summaryPath = path.join(job.outputDir, "summary.json");
        await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
        const updatedJob = {
            ...job,
            artifactPaths: [...job.artifactPaths, summaryPath],
        };
        await writeFile(path.join(job.outputDir, "manifest.json"), `${JSON.stringify(updatedJob, null, 2)}\n`, "utf8");
        return { plan, summary, job: updatedJob };
    }
    catch (error) {
        return fail(error);
    }
}
function buildModelRenameInputSummary(plan, options = {}) {
    return {
        fromModelName: plan.fromModelName,
        toModelName: plan.toModelName,
        sourceAssetsDir: plan.sourceAssetsDir,
        targetAssetsDir: plan.targetAssetsDir,
        sourceDataDir: plan.sourceDataDir,
        targetDataDir: plan.targetDataDir,
        includeData: plan.includeData,
        renameEsdSpeaker: plan.renameEsdSpeaker,
        changes: plan.changes,
        safetensorsKept: plan.safetensorsKept,
        compatibility: plan.compatibility,
        ...(options.refresh ? { refresh: options.refresh } : {}),
        ...(options.outputAssetsRetained !== undefined ? { outputAssetsRetained: options.outputAssetsRetained } : {}),
    };
}
function collectRenameArtifacts(plan) {
    const artifacts = [
        plan.targetConfigJsonPath,
        path.join(plan.targetAssetsDir, "style_vectors.npy"),
        ...plan.safetensorsKept.map((filePath) => path.join(plan.targetAssetsDir, path.basename(filePath))),
    ];
    if (plan.includeData) {
        artifacts.push(plan.targetDataDir);
        if (plan.renameEsdSpeaker)
            artifacts.push(path.join(plan.targetDataDir, "esd.list"));
    }
    return artifacts;
}
function updateConfigJson(value, fromModelName, toModelName) {
    if (!isRecord(value)) {
        throw new Error("config.json root must be an object");
    }
    const next = { ...value, model_name: toModelName };
    if (isRecord(next.data)) {
        next.data = updateConfigData(next.data, fromModelName, toModelName);
    }
    return next;
}
function updateConfigData(data, fromModelName, toModelName) {
    const next = { ...data };
    if (isRecord(next.spk2id) && Object.prototype.hasOwnProperty.call(next.spk2id, fromModelName)) {
        const spk2id = {};
        for (const [key, value] of Object.entries(next.spk2id)) {
            spk2id[key === fromModelName ? toModelName : key] = value;
        }
        next.spk2id = spk2id;
    }
    if (isRecord(next.id2spk)) {
        const id2spk = {};
        for (const [key, value] of Object.entries(next.id2spk)) {
            id2spk[key] = value === fromModelName ? toModelName : value;
        }
        next.id2spk = id2spk;
    }
    return next;
}
function configSpeakerChanges(config, configJsonPath, fromModelName, toModelName) {
    if (!isRecord(config.data))
        return [];
    const changes = [];
    if (isRecord(config.data.spk2id) && Object.prototype.hasOwnProperty.call(config.data.spk2id, fromModelName)) {
        changes.push({
            kind: "json-field",
            path: configJsonPath,
            jsonPath: "data.spk2id",
            from: fromModelName,
            to: toModelName,
        });
    }
    if (isRecord(config.data.id2spk) && Object.values(config.data.id2spk).some((value) => value === fromModelName)) {
        changes.push({
            kind: "json-field",
            path: configJsonPath,
            jsonPath: "data.id2spk",
            from: fromModelName,
            to: toModelName,
        });
    }
    return changes;
}
async function planEsdSpeakerChange(esdPath, fromModelName, toModelName) {
    if (!(await pathExists(esdPath)))
        return undefined;
    const text = await readFile(esdPath, "utf8");
    const changedLineCount = rewriteEsdSpeaker(text, fromModelName, toModelName).changedLineCount;
    return changedLineCount > 0
        ? {
            kind: "esd-speaker",
            path: esdPath,
            from: fromModelName,
            to: toModelName,
            lineCount: changedLineCount,
        }
        : undefined;
}
function rewriteEsdSpeaker(text, fromModelName, toModelName) {
    let changedLineCount = 0;
    const hadTrailingNewline = text.endsWith("\n");
    const lines = text.split(/\r?\n/);
    if (hadTrailingNewline)
        lines.pop();
    const updated = lines.map((line) => {
        const parts = line.split("|");
        if (parts.length > 1 && parts[1] === fromModelName) {
            parts[1] = toModelName;
            changedLineCount += 1;
            return parts.join("|");
        }
        return line;
    });
    return {
        text: `${updated.join("\n")}${hadTrailingNewline ? "\n" : ""}`,
        changedLineCount,
    };
}
async function rollback(actions, warnings, logLines) {
    for (const action of [...actions].reverse()) {
        try {
            await action();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const warning = `rollback warning: ${message}`;
            warnings.push(warning);
            logLines.push(warning);
        }
    }
}
async function readConfigForPlan(filePath, errors) {
    try {
        const parsed = JSON.parse(await readFile(filePath, "utf8"));
        if (!isRecord(parsed)) {
            errors.push(`config.json root must be an object: ${filePath}`);
            return undefined;
        }
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`config.json is not valid JSON: ${message}`);
        return undefined;
    }
}
function readConfigModelName(value) {
    const candidate = value.model_name ?? value.modelName;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
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
            assetsRoot: path.join(sbv2Root, "model_assets"),
            datasetRoot: path.join(sbv2Root, "Data"),
        };
    }
    const text = await readFile(configPath, "utf8");
    return {
        assetsRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "assets_root") ?? "model_assets"),
        datasetRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "dataset_root") ?? "Data"),
    };
}
async function listTopLevelFiles(dir, suffix) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
            return [];
        throw error;
    }
    const files = [];
    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        if (entry.startsWith(".") || !entry.endsWith(suffix))
            continue;
        const filePath = path.join(dir, entry);
        if (await isFile(filePath))
            files.push(filePath);
    }
    return files;
}
function modelInfoContains(modelsInfo, modelName) {
    return modelsInfo.some((model) => model.name === modelName || model.modelName === modelName || model.model_name === modelName);
}
function validateModelName(value, name) {
    if (!value.trim() || value === "." || value === ".." || value.startsWith(".") || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
        throw new Error(`Invalid SBV2 model name for ${name}: ${value}`);
    }
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
function resolveUserPath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return path.join(homedir(), value.slice(2));
    return path.resolve(value);
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
async function isDirectory(filePath) {
    try {
        const result = await stat(filePath);
        return result.isDirectory();
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function isFile(filePath) {
    try {
        const result = await stat(filePath);
        return result.isFile();
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return false;
        throw error;
    }
}
async function isNonEmptyFile(filePath) {
    try {
        const result = await stat(filePath);
        return result.isFile() && result.size > 0;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return false;
        throw error;
    }
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
