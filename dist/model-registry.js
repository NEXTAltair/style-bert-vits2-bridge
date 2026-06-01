import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createJobManifest } from "./jobs.js";
import { readDatasetManifest } from "./datasets.js";
import { Sbv2Client } from "./sbv2-client.js";
export async function listModelCandidates(options) {
    const context = await resolveModelContext(options);
    return [await inspectModelCandidate(context)];
}
export async function promoteModel(options) {
    const context = await resolveModelContext(options);
    if (options.confirmModelName !== context.modelName) {
        throw new Error(`--confirm-model-name must exactly match ${context.modelName}`);
    }
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const logLines = [`model promotion started for ${context.modelName}`];
    let backupDir = null;
    let copied = false;
    let cleanupTargetOnFailure = false;
    let candidate = await inspectModelCandidate(context);
    const fail = async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "model-promote",
            state: "failed",
            inputSummary: {
                modelName: context.modelName,
                sourceDir: context.sourceDir,
                targetDir: context.targetDir,
            },
            artifactPaths: candidate ? collectCandidateArtifacts(candidate) : [],
            firstError: message,
            retryable: false,
            progressSummary: `Model promotion failed for ${context.modelName}.`,
            logLines: [...logLines, message],
            now,
            randomId,
        });
        throw error;
    };
    try {
        if (!candidate.promotable) {
            throw new Error(`Model candidate is not promotable: ${candidate.errors.join("; ")}`);
        }
        const sameDirectory = await samePath(context.sourceDir, context.targetDir);
        if (!sameDirectory) {
            if (await pathExists(context.targetDir)) {
                if (!options.backupExisting) {
                    throw new Error(`SBV2 model assets already exist: ${context.targetDir}`);
                }
                const pendingBackupDir = await makeBackupDir(context.assetsRoot, context.modelName, now());
                await mkdir(path.dirname(pendingBackupDir), { recursive: true });
                await rename(context.targetDir, pendingBackupDir);
                backupDir = pendingBackupDir;
                logLines.push(`backed up existing model assets: ${backupDir}`);
            }
            else {
                cleanupTargetOnFailure = true;
            }
            await cp(context.sourceDir, context.targetDir, {
                recursive: true,
                errorOnExist: true,
                force: false,
                dereference: true,
            });
            copied = true;
            logLines.push(`copied model assets to ${context.targetDir}`);
            candidate = await inspectModelCandidate({ ...context, sourceDir: context.targetDir });
            if (!candidate.promotable) {
                throw new Error(`Copied model candidate is not promotable: ${candidate.errors.join("; ")}`);
            }
        }
        else {
            logLines.push(`model assets already exist at target: ${context.targetDir}`);
        }
        const summary = {
            schemaVersion: 1,
            modelName: context.modelName,
            sourceDir: context.sourceDir,
            targetDir: context.targetDir,
            copied,
            backupDir,
            candidate,
        };
        if (options.baseUrl) {
            const client = new Sbv2Client({ baseUrl: options.baseUrl });
            const modelsInfo = await client.refreshModels();
            const found = modelInfoContains(modelsInfo, context.modelName);
            summary.refresh = {
                baseUrl: options.baseUrl,
                refreshed: true,
                foundInModelsInfo: found,
                modelsInfoCount: modelsInfo.length,
            };
            logLines.push(`refreshed SBV2 models from ${options.baseUrl}`);
            if (!found) {
                throw new Error(`Promoted model "${context.modelName}" was not found in /models/info after refresh`);
            }
        }
        const job = await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "model-promote",
            inputSummary: {
                modelName: context.modelName,
                sourceDir: context.sourceDir,
                targetDir: context.targetDir,
                copied,
                backupDir,
            },
            artifactPaths: collectCandidateArtifacts(candidate),
            progressSummary: `Model promotion completed for ${context.modelName}.`,
            logLines: [...logLines, `model promotion succeeded for ${context.modelName}`],
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
        return { candidate, summary, job: updatedJob };
    }
    catch (error) {
        if (backupDir) {
            await rollbackBackup(context.targetDir, backupDir, logLines);
        }
        else if (cleanupTargetOnFailure) {
            await cleanupCopiedTarget(context.targetDir, logLines);
        }
        return fail(error);
    }
}
async function inspectModelCandidate(context) {
    const sourceDir = resolveUserPath(context.sourceDir);
    const warnings = [];
    const errors = [];
    const configJsonPath = path.join(sourceDir, "config.json");
    const styleVectorsPath = path.join(sourceDir, "style_vectors.npy");
    let configModelName;
    const sourceStat = await directoryStat(sourceDir);
    if (!sourceStat.exists) {
        errors.push(`candidate directory was not found: ${sourceDir}`);
    }
    else if (!sourceStat.isDirectory) {
        errors.push(`candidate path is not a directory: ${sourceDir}`);
    }
    const configStat = await nonEmptyFileStat(configJsonPath);
    if (!configStat) {
        errors.push(`config.json is missing or empty: ${configJsonPath}`);
    }
    else {
        try {
            const config = JSON.parse(await readFile(configJsonPath, "utf8"));
            configModelName = readConfigModelName(config);
            if (configModelName && configModelName !== context.modelName) {
                errors.push(`config.json model_name "${configModelName}" does not match "${context.modelName}"`);
            }
            errors.push(...validateConfigShape(config));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`config.json is not valid JSON: ${message}`);
        }
    }
    if (!(await nonEmptyFileStat(styleVectorsPath))) {
        errors.push(`style_vectors.npy is missing or empty: ${styleVectorsPath}`);
    }
    else {
        errors.push(...(await validateStyleVectorsFile(styleVectorsPath)));
    }
    const safetensors = await listSafetensors(sourceDir);
    if (!safetensors.length) {
        errors.push(`no non-empty .safetensors files were found in ${sourceDir}`);
    }
    if (!configModelName) {
        warnings.push("config.json does not include model_name; using CLI/model directory name for promotion.");
    }
    return {
        schemaVersion: 1,
        candidateId: `${context.modelName}:${path.basename(sourceDir)}`,
        modelName: context.modelName,
        sbv2Root: context.sbv2Root,
        sourceDir,
        targetDir: context.targetDir,
        configJsonPath,
        styleVectorsPath,
        safetensors,
        ...(configModelName ? { configModelName } : {}),
        warnings,
        errors,
        promotable: errors.length === 0,
    };
}
async function resolveModelContext(options) {
    const fromManifest = options.manifestPath ? await readDatasetManifest(resolveUserPath(options.manifestPath)) : undefined;
    const sbv2Root = resolveUserPath(options.sbv2Root ?? fromManifest?.sbv2Root ?? process.env.SBV2_ROOT ?? "~/src/Style-Bert-VITS2");
    const modelName = options.modelName ?? fromManifest?.modelName;
    if (!modelName) {
        throw new Error("Missing --model-name or --manifest");
    }
    validateModelName(modelName);
    const pathConfig = await readSbv2PathConfig(sbv2Root);
    const targetDir = path.join(pathConfig.assetsRoot, modelName);
    return {
        sbv2Root,
        modelName,
        assetsRoot: pathConfig.assetsRoot,
        sourceDir: resolveUserPath(options.sourcePath ?? targetDir),
        targetDir,
    };
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
        return { assetsRoot: path.join(sbv2Root, "model_assets") };
    }
    const text = await readFile(configPath, "utf8");
    return {
        assetsRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "assets_root") ?? "model_assets"),
    };
}
async function listSafetensors(sourceDir) {
    let entries;
    try {
        entries = await readdir(sourceDir);
    }
    catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
            return [];
        throw error;
    }
    const files = [];
    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        if (!entry.endsWith(".safetensors") || entry.startsWith("."))
            continue;
        const filePath = path.join(sourceDir, entry);
        const fileStat = await nonEmptyFileStat(filePath);
        if (fileStat) {
            files.push({ path: filePath, sizeBytes: fileStat.size });
        }
    }
    return files;
}
async function nonEmptyFileStat(filePath) {
    try {
        const result = await stat(filePath);
        return result.isFile() && result.size > 0 ? { size: result.size } : undefined;
    }
    catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
            return undefined;
        throw error;
    }
}
function readConfigModelName(value) {
    if (!isRecord(value))
        return undefined;
    const candidate = value.model_name ?? value.modelName;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}
function collectCandidateArtifacts(candidate) {
    return [
        candidate.configJsonPath,
        candidate.styleVectorsPath,
        ...candidate.safetensors.map((file) => file.path),
    ];
}
function modelInfoContains(modelsInfo, modelName) {
    return modelsInfo.some((model) => model.name === modelName || model.modelName === modelName || model.model_name === modelName);
}
async function samePath(left, right) {
    return path.resolve(left) === path.resolve(right);
}
async function makeBackupDir(assetsRoot, modelName, now) {
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const base = path.join(assetsRoot, ".bridge-backups", `${modelName}-${stamp}`);
    if (!(await pathExists(base)))
        return base;
    for (let index = 2; index < 1000; index += 1) {
        const candidate = `${base}-${index}`;
        if (!(await pathExists(candidate)))
            return candidate;
    }
    throw new Error(`Unable to find an unused backup path for ${modelName}`);
}
async function rollbackBackup(targetDir, backupDir, logLines) {
    try {
        await rm(targetDir, { recursive: true, force: true });
        await rename(backupDir, targetDir);
        logLines.push(`rolled back model assets from backup: ${backupDir}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLines.push(`warning: failed to roll back model assets from ${backupDir}: ${message}`);
    }
}
async function cleanupCopiedTarget(targetDir, logLines) {
    try {
        await rm(targetDir, { recursive: true, force: true });
        logLines.push(`removed incomplete promoted model assets: ${targetDir}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLines.push(`warning: failed to remove incomplete model assets ${targetDir}: ${message}`);
    }
}
function validateConfigShape(value) {
    if (!isRecord(value)) {
        return ["config.json root must be an object"];
    }
    const data = value.data;
    if (!isRecord(data)) {
        return ["config.json is missing data object"];
    }
    const spk2id = data.spk2id;
    const style2id = data.style2id;
    const errors = [];
    errors.push(...validateIdMap(spk2id, "data.spk2id"));
    errors.push(...validateIdMap(style2id, "data.style2id"));
    return errors;
}
function validateModelName(value) {
    if (!value.trim() || value === "." || value === ".." || value.startsWith(".") || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
        throw new Error(`Invalid SBV2 model name: ${value}`);
    }
}
async function validateStyleVectorsFile(filePath) {
    const buffer = await readFile(filePath);
    const shape = parseNpyShape(buffer);
    if (!shape) {
        return [`style_vectors.npy is not a valid NumPy .npy file: ${filePath}`];
    }
    if (shape.length < 2 || shape[0] < 1) {
        return [`style_vectors.npy must have at least one 2D style vector row: ${filePath}`];
    }
    return [];
}
function parseNpyShape(buffer) {
    if (buffer.length < 10 || buffer.toString("latin1", 0, 6) !== "\x93NUMPY") {
        return undefined;
    }
    const major = buffer[6];
    const minor = buffer[7];
    const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
    if (!headerLengthBytes || minor === undefined || buffer.length < 8 + headerLengthBytes) {
        return undefined;
    }
    const headerLength = headerLengthBytes === 2 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
    const headerStart = 8 + headerLengthBytes;
    const headerEnd = headerStart + headerLength;
    if (buffer.length < headerEnd) {
        return undefined;
    }
    const header = buffer.toString("latin1", headerStart, headerEnd);
    const match = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
    if (!match) {
        return undefined;
    }
    const shape = match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number(part));
    return shape.length && shape.every((part) => Number.isInteger(part) && part >= 0) ? shape : undefined;
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
async function directoryStat(filePath) {
    try {
        const result = await stat(filePath);
        return { exists: true, isDirectory: result.isDirectory() };
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return { exists: false, isDirectory: false };
        throw error;
    }
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateIdMap(value, name) {
    if (!isRecord(value) || Object.keys(value).length === 0) {
        return [`config.json ${name} must be a non-empty object`];
    }
    if (!Object.values(value).every((id) => typeof id === "number" && Number.isFinite(id))) {
        return [`config.json ${name} values must be finite numbers`];
    }
    return [];
}
