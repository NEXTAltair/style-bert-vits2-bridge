import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createJobManifest } from "./jobs.js";
import { Sbv2Client } from "./sbv2-client.js";
import { listModelCandidates } from "./model-registry.js";
const MAX_SAFETENSORS_HEADER_BYTES = 100 * 1024 * 1024;
export function parseModelMergeMethod(value) {
    const normalized = value.replace(/_/g, "-");
    if (normalized === "usual" || normalized === "add-diff" || normalized === "weighted-sum" || normalized === "add-null") {
        return normalized;
    }
    throw new Error("--method must be one of: usual, add-diff, weighted-sum, add-null");
}
export async function createModelMergePlan(options) {
    validateModelName(options.outputModelName, "--output-model-name");
    validateMethodParameters(options);
    const sbv2Root = resolveUserPath(options.sbv2Root ?? process.env.SBV2_ROOT ?? "~/src/Style-Bert-VITS2");
    const pathConfig = await readSbv2PathConfig(sbv2Root);
    const assetsRoot = pathConfig.assetsRoot;
    const outputDir = path.join(assetsRoot, options.outputModelName);
    const outputSafetensorsPath = path.join(outputDir, `${options.outputModelName}.safetensors`);
    const inputModels = {
        a: await inspectMergeInput({ assetsRoot, modelName: options.modelA, modelFile: options.modelAFile, label: "model A" }),
        b: await inspectMergeInput({ assetsRoot, modelName: options.modelB, modelFile: options.modelBFile, label: "model B" }),
        ...(methodNeedsModelC(options.method)
            ? {
                c: await inspectMergeInput({
                    assetsRoot,
                    modelName: requireValue(options.modelC, "--model-c"),
                    modelFile: options.modelCFile,
                    label: "model C",
                }),
            }
            : {}),
    };
    const compatibility = await checkCompatibility({
        assetsRoot,
        outputModelName: options.outputModelName,
        outputDir,
        inputModels,
    });
    const command = buildMergeCommand({
        sbv2Root,
        method: options.method,
        outputModelName: options.outputModelName,
        inputModels,
        weights: normalizeWeights(options),
        coefficients: normalizeCoefficients(options),
        slerp: Boolean(options.slerp),
    });
    return {
        schemaVersion: 1,
        method: options.method,
        sbv2Root,
        assetsRoot,
        outputModelName: options.outputModelName,
        outputDir,
        outputSafetensorsPath,
        inputModels,
        ...(commandPayloadUsesWeights(options.method) ? { weights: normalizeWeights(options) } : {}),
        ...(options.method === "weighted-sum" ? { coefficients: normalizeCoefficients(options) } : {}),
        slerp: options.method === "usual" ? Boolean(options.slerp) : false,
        compatibility,
        command,
        expectedArtifacts: [
            path.join(outputDir, "config.json"),
            path.join(outputDir, "style_vectors.npy"),
            outputSafetensorsPath,
            path.join(outputDir, "recipe.json"),
        ],
    };
}
export async function runModelMerge(options) {
    const plan = await createModelMergePlan(options);
    if (options.confirmOutputModelName !== plan.outputModelName) {
        throw new Error(`--confirm-output-model-name must exactly match ${plan.outputModelName}`);
    }
    if (!plan.compatibility.compatible) {
        throw new Error(`Model merge plan is not compatible: ${plan.compatibility.errors.join("; ")}`);
    }
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const runner = options.commandRunner ?? runSbv2Command;
    const logLines = [`model merge started for ${plan.outputModelName}`];
    const outputExistedBeforeRun = await pathExists(plan.outputDir);
    const fail = async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!outputExistedBeforeRun && (await pathExists(plan.outputDir))) {
            await cleanupOutputDir(plan.outputDir, logLines);
        }
        await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "model-merge",
            state: "failed",
            inputSummary: {
                method: plan.method,
                outputModelName: plan.outputModelName,
                outputDir: plan.outputDir,
            },
            artifactPaths: [],
            firstError: message,
            retryable: false,
            progressSummary: `Model merge failed for ${plan.outputModelName}.`,
            logLines: [...logLines, message],
            now,
            randomId,
        });
        throw error;
    };
    try {
        await mkdir(path.dirname(plan.outputDir), { recursive: true });
        await runAndLogMergeCommand(runner, plan.command, logLines);
        const [candidate] = await listModelCandidates({
            sbv2Root: plan.sbv2Root,
            modelName: plan.outputModelName,
            sourcePath: plan.outputDir,
        });
        if (!candidate?.promotable) {
            throw new Error(`Merged model candidate is not promotable: ${candidate?.errors.join("; ") ?? "not found"}`);
        }
        const summary = {
            schemaVersion: 1,
            method: plan.method,
            outputModelName: plan.outputModelName,
            outputDir: plan.outputDir,
            plan,
            candidate,
            nextSteps: [
                ...(options.baseUrl
                    ? [`sbv2-bridge evaluation run --model-name ${plan.outputModelName} --base-url ${options.baseUrl} --json`]
                    : ["Run SBV2 /models/refresh, then sbv2-bridge evaluation run with --base-url."]),
            ],
        };
        if (options.baseUrl) {
            const modelsInfo = await new Sbv2Client({ baseUrl: options.baseUrl }).refreshModels();
            const found = modelInfoContains(modelsInfo, plan.outputModelName);
            summary.refresh = {
                baseUrl: options.baseUrl,
                refreshed: true,
                foundInModelsInfo: found,
                modelsInfoCount: modelsInfo.length,
            };
            logLines.push(`refreshed SBV2 models from ${options.baseUrl}`);
            if (!found) {
                throw new Error(`Merged model "${plan.outputModelName}" was not found in /models/info after refresh`);
            }
        }
        const job = await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "model-merge",
            inputSummary: {
                method: plan.method,
                outputModelName: plan.outputModelName,
                outputDir: plan.outputDir,
            },
            artifactPaths: collectMergeArtifacts(plan, candidate),
            progressSummary: `Model merge completed for ${plan.outputModelName}.`,
            logLines: [...logLines, `model merge succeeded for ${plan.outputModelName}`],
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
        return { plan, candidate, summary, job: updatedJob };
    }
    catch (error) {
        return fail(error);
    }
}
async function inspectMergeInput(options) {
    validateModelName(options.modelName, `--${options.label.replace(" ", "-")}`);
    const modelDir = path.join(options.assetsRoot, options.modelName);
    const configJsonPath = path.join(modelDir, "config.json");
    const styleVectorsPath = path.join(modelDir, "style_vectors.npy");
    const safetensorsPath = await resolveModelSafetensors(modelDir, options.modelFile, options.label);
    const config = await readConfigSummary(configJsonPath);
    const styleVectorShape = await readNpyShape(styleVectorsPath);
    const safetensorsTensors = await readSafetensorsTensorMap(safetensorsPath);
    if (config.styleCount !== undefined && styleVectorShape[0] !== config.styleCount) {
        throw new Error(`${options.label} style_vectors.npy row count does not match config.json data.num_styles`);
    }
    return {
        modelName: options.modelName,
        modelDir,
        safetensorsPath,
        configJsonPath,
        styleVectorsPath,
        speakerCount: config.speakerCount,
        styleVectorShape,
        safetensorsTensors,
    };
}
async function resolveModelSafetensors(modelDir, modelFile, label) {
    if (modelFile) {
        const resolved = path.resolve(modelDir, modelFile);
        const relative = path.relative(modelDir, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative) || !resolved.endsWith(".safetensors")) {
            throw new Error(`${label} file must be a .safetensors file inside ${modelDir}`);
        }
        await requireNonEmptyFile(resolved, `${label} file`);
        return resolved;
    }
    let entries;
    try {
        entries = await readdir(modelDir);
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            throw new Error(`${label} model directory was not found: ${modelDir}`);
        }
        throw error;
    }
    const files = [];
    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
        if (!entry.endsWith(".safetensors") || entry.startsWith("."))
            continue;
        const filePath = path.join(modelDir, entry);
        if (await isNonEmptyFile(filePath))
            files.push(filePath);
    }
    if (files.length === 1)
        return files[0];
    if (!files.length)
        throw new Error(`${label} has no non-empty .safetensors file in ${modelDir}`);
    throw new Error(`${label} has multiple .safetensors files; pass an explicit --${label.replace(" ", "-")}-file`);
}
async function checkCompatibility(args) {
    const errors = [];
    const warnings = [];
    const inputs = [args.inputModels.a, args.inputModels.b, ...(args.inputModels.c ? [args.inputModels.c] : [])];
    if (inputs.some((input) => input.modelName === args.outputModelName)) {
        errors.push("output model name must not match any input model name");
    }
    if (await pathExists(args.outputDir)) {
        errors.push(`output model assets already exist: ${args.outputDir}`);
    }
    const speakerCount = inputs[0]?.speakerCount;
    if (speakerCount !== undefined && inputs.some((input) => input.speakerCount !== speakerCount)) {
        errors.push("input models must have the same speaker count");
    }
    const styleVectorTail = inputs[0]?.styleVectorShape.slice(1).join("x");
    if (styleVectorTail && inputs.some((input) => input.styleVectorShape.slice(1).join("x") !== styleVectorTail)) {
        errors.push("input models must have matching style vector dimensions");
    }
    const tensorErrors = compareSafetensorsTensorMaps(inputs);
    errors.push(...tensorErrors);
    return { compatible: errors.length === 0, errors, warnings };
}
function compareSafetensorsTensorMaps(inputs) {
    const [first, ...rest] = inputs;
    if (!first)
        return [];
    const firstEntries = Object.entries(first.safetensorsTensors);
    const errors = [];
    for (const input of rest) {
        const inputKeys = new Set(Object.keys(input.safetensorsTensors));
        for (const [key, tensor] of firstEntries) {
            const other = input.safetensorsTensors[key];
            if (!other) {
                errors.push(`safetensors tensor "${key}" is missing from ${input.modelName}`);
                continue;
            }
            if (tensor.shape.join("x") !== other.shape.join("x")) {
                errors.push(`safetensors tensor "${key}" shape differs between ${first.modelName} and ${input.modelName}`);
            }
        }
        for (const key of inputKeys) {
            if (!first.safetensorsTensors[key]) {
                errors.push(`safetensors tensor "${key}" is missing from ${first.modelName}`);
            }
        }
    }
    return errors;
}
function buildMergeCommand(args) {
    return {
        executable: "uv",
        args: [
            "run",
            "python",
            "-c",
            MERGE_SCRIPT,
            JSON.stringify({
                method: toUpstreamMethod(args.method),
                outputName: args.outputModelName,
                modelPathA: args.inputModels.a.safetensorsPath,
                modelPathB: args.inputModels.b.safetensorsPath,
                modelPathC: args.inputModels.c?.safetensorsPath,
                weights: args.weights,
                coefficients: args.coefficients,
                slerp: args.slerp,
            }),
        ],
        cwd: args.sbv2Root,
    };
}
const MERGE_SCRIPT = `
import json
import sys
from gradio_tabs import merge

payload = json.loads(sys.argv[1])
method = payload["method"]
weights = payload.get("weights") or {}
coeffs = payload.get("coefficients") or {}
if method == "usual":
    merge.merge_models_usual(payload["modelPathA"], payload["modelPathB"], weights["voiceWeight"], weights["voicePitchWeight"], weights["speechStyleWeight"], weights["tempoWeight"], payload["outputName"], bool(payload.get("slerp")))
elif method == "add_diff":
    merge.merge_models_add_diff(payload["modelPathA"], payload["modelPathB"], payload["modelPathC"], weights["voiceWeight"], weights["voicePitchWeight"], weights["speechStyleWeight"], weights["tempoWeight"], payload["outputName"])
elif method == "weighted_sum":
    merge.merge_models_weighted_sum(payload["modelPathA"], payload["modelPathB"], payload["modelPathC"], coeffs["modelACoeff"], coeffs["modelBCoeff"], coeffs["modelCCoeff"], payload["outputName"])
elif method == "add_null":
    merge.merge_models_add_null(payload["modelPathA"], payload["modelPathB"], weights["voiceWeight"], weights["voicePitchWeight"], weights["speechStyleWeight"], weights["tempoWeight"], payload["outputName"])
else:
    raise ValueError(f"Unknown merge method: {method}")
`;
async function runSbv2Command(executable, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => options.onOutput?.("stdout", chunk));
        child.stderr?.on("data", (chunk) => options.onOutput?.("stderr", chunk));
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (code === 0) {
                resolve({});
                return;
            }
            const signalText = signal ? ` signal ${signal}` : "";
            reject(new Error(`${executable} ${args.slice(0, 3).join(" ")} failed with exit code ${code ?? "unknown"}${signalText}`));
        });
    });
}
async function runAndLogMergeCommand(runner, command, logLines) {
    logLines.push(`running model merge: ${command.executable} ${command.args.slice(0, 3).join(" ")}`);
    const result = await runner(command.executable, command.args, {
        cwd: command.cwd,
        onOutput: (stream, chunk) => appendCommandOutput(logLines, stream, chunk),
    });
    appendCommandOutput(logLines, "stdout", result.stdout ?? "");
    appendCommandOutput(logLines, "stderr", result.stderr ?? "");
}
function appendCommandOutput(logLines, stream, chunk) {
    for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed)
            logLines.push(`${stream}: ${trimmed}`);
    }
}
function validateMethodParameters(options) {
    if (methodNeedsModelC(options.method) && !options.modelC)
        throw new Error(`--model-c is required for ${options.method}`);
    if (!methodNeedsModelC(options.method) && options.modelC)
        throw new Error(`--model-c is only valid for add-diff and weighted-sum`);
    if (options.method !== "usual" && options.slerp)
        throw new Error("--slerp is only valid for usual");
    if (commandPayloadUsesWeights(options.method)) {
        normalizeWeights(options);
        if (hasCoefficients(options.coefficients))
            throw new Error(`model coefficients are only valid for weighted-sum`);
    }
    else {
        normalizeCoefficients(options);
        if (hasWeights(options.weights))
            throw new Error("part weights are not valid for weighted-sum");
    }
}
function normalizeWeights(options) {
    if (!commandPayloadUsesWeights(options.method))
        return undefined;
    return {
        voiceWeight: requireWeight(options.weights?.voiceWeight, "--voice-weight"),
        voicePitchWeight: requireWeight(options.weights?.voicePitchWeight, "--voice-pitch-weight"),
        speechStyleWeight: requireWeight(options.weights?.speechStyleWeight, "--speech-style-weight"),
        tempoWeight: requireWeight(options.weights?.tempoWeight, "--tempo-weight"),
    };
}
function normalizeCoefficients(options) {
    if (options.method !== "weighted-sum")
        return undefined;
    return {
        modelACoeff: requireFinite(options.coefficients?.modelACoeff, "--model-a-coeff"),
        modelBCoeff: requireFinite(options.coefficients?.modelBCoeff, "--model-b-coeff"),
        modelCCoeff: requireFinite(options.coefficients?.modelCCoeff, "--model-c-coeff"),
    };
}
function requireFinite(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`${name} must be a finite number`);
    return value;
}
function requireWeight(value, name) {
    const number = requireFinite(value, name);
    if (number < 0 || number > 1)
        throw new Error(`${name} must be between 0 and 1`);
    return number;
}
function hasWeights(value) {
    return value !== undefined && Object.values(value).some((entry) => entry !== undefined);
}
function hasCoefficients(value) {
    return value !== undefined && Object.values(value).some((entry) => entry !== undefined);
}
function methodNeedsModelC(method) {
    return method === "add-diff" || method === "weighted-sum";
}
function commandPayloadUsesWeights(method) {
    return method === "usual" || method === "add-diff" || method === "add-null";
}
function toUpstreamMethod(method) {
    return method.replace(/-/g, "_");
}
async function readSbv2PathConfig(sbv2Root) {
    const pathsPath = path.join(sbv2Root, "configs", "paths.yml");
    const defaultPathsPath = path.join(sbv2Root, "configs", "default_paths.yml");
    const configPath = (await pathExists(pathsPath))
        ? pathsPath
        : (await pathExists(defaultPathsPath))
            ? defaultPathsPath
            : null;
    if (!configPath)
        return { assetsRoot: path.join(sbv2Root, "model_assets") };
    const text = await readFile(configPath, "utf8");
    return {
        assetsRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "assets_root") ?? "model_assets"),
    };
}
async function readConfigSummary(configJsonPath) {
    await requireNonEmptyFile(configJsonPath, "config.json");
    const parsed = JSON.parse(await readFile(configJsonPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.data))
        throw new Error(`config.json is missing data object: ${configJsonPath}`);
    const data = parsed.data;
    const spk2id = data.spk2id;
    if (!isRecord(spk2id) || Object.keys(spk2id).length === 0)
        throw new Error(`config.json data.spk2id must be a non-empty object: ${configJsonPath}`);
    const nSpeakers = data.n_speakers;
    const speakerCount = typeof nSpeakers === "number" && Number.isInteger(nSpeakers) && nSpeakers > 0 ? nSpeakers : Object.keys(spk2id).length;
    const numStyles = data.num_styles;
    return {
        speakerCount,
        ...(typeof numStyles === "number" && Number.isInteger(numStyles) && numStyles > 0 ? { styleCount: numStyles } : {}),
    };
}
async function readNpyShape(filePath) {
    await requireNonEmptyFile(filePath, "style_vectors.npy");
    const header = parseNpyHeader(await readFile(filePath));
    if (!header || header.shape.length < 2)
        throw new Error(`style_vectors.npy is not a valid 2D NumPy file: ${filePath}`);
    return header.shape;
}
function parseNpyHeader(buffer) {
    if (buffer.length < 10 || buffer.toString("latin1", 0, 6) !== "\x93NUMPY")
        return undefined;
    const major = buffer[6];
    const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
    if (!headerLengthBytes || buffer.length < 8 + headerLengthBytes)
        return undefined;
    const headerLength = headerLengthBytes === 2 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
    const headerStart = 8 + headerLengthBytes;
    const headerEnd = headerStart + headerLength;
    if (buffer.length < headerEnd)
        return undefined;
    const match = buffer.toString("latin1", headerStart, headerEnd).match(/'shape'\s*:\s*\(([^)]*)\)/);
    if (!match)
        return undefined;
    const shape = match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map(Number);
    return shape.length && shape.every((part) => Number.isInteger(part) && part >= 0) ? { shape } : undefined;
}
async function readSafetensorsTensorMap(filePath) {
    const fileStat = await requireNonEmptyFile(filePath, "safetensors file");
    const header = await readSafetensorsHeader(filePath, fileStat.size);
    if (!header || !isRecord(header))
        throw new Error(`safetensors file is not valid: ${filePath}`);
    const result = {};
    for (const [key, value] of Object.entries(header)) {
        if (key === "__metadata__")
            continue;
        if (!isRecord(value) || !Array.isArray(value.shape) || !value.shape.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0)) {
            throw new Error(`safetensors tensor "${key}" has invalid shape metadata: ${filePath}`);
        }
        result[key] = {
            ...(typeof value.dtype === "string" ? { dtype: value.dtype } : {}),
            shape: value.shape,
        };
    }
    if (!Object.keys(result).length)
        throw new Error(`safetensors file has no tensor entries: ${filePath}`);
    return result;
}
async function readSafetensorsHeader(filePath, fileSize) {
    if (fileSize < 8)
        return undefined;
    const file = await open(filePath, "r");
    try {
        const lengthBuffer = Buffer.alloc(8);
        const lengthRead = await file.read(lengthBuffer, 0, lengthBuffer.length, 0);
        if (lengthRead.bytesRead !== lengthBuffer.length)
            return undefined;
        const headerLengthBig = lengthBuffer.readBigUInt64LE(0);
        if (headerLengthBig > BigInt(Number.MAX_SAFE_INTEGER))
            return undefined;
        const headerLength = Number(headerLengthBig);
        if (headerLength < 2 || headerLength > MAX_SAFETENSORS_HEADER_BYTES || 8 + headerLength > fileSize)
            return undefined;
        const headerBuffer = Buffer.alloc(headerLength);
        const headerRead = await file.read(headerBuffer, 0, headerLength, 8);
        if (headerRead.bytesRead !== headerLength)
            return undefined;
        return JSON.parse(headerBuffer.toString("utf8"));
    }
    finally {
        await file.close();
    }
}
async function requireNonEmptyFile(filePath, name) {
    try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile() || fileStat.size === 0)
            throw new Error(`${name} is missing or empty: ${filePath}`);
        return { size: fileStat.size };
    }
    catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
            throw new Error(`${name} is missing or empty: ${filePath}`);
        throw error;
    }
}
async function isNonEmptyFile(filePath) {
    try {
        const fileStat = await stat(filePath);
        return fileStat.isFile() && fileStat.size > 0;
    }
    catch (error) {
        if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
            return false;
        throw error;
    }
}
function collectMergeArtifacts(plan, candidate) {
    return [
        candidate.configJsonPath,
        candidate.styleVectorsPath,
        ...candidate.safetensors.map((file) => file.path),
        path.join(plan.outputDir, "recipe.json"),
    ];
}
async function cleanupOutputDir(outputDir, logLines) {
    try {
        await rm(outputDir, { recursive: true, force: true });
        logLines.push(`removed incomplete merged model assets: ${outputDir}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLines.push(`warning: failed to remove incomplete merged model assets ${outputDir}: ${message}`);
    }
}
function modelInfoContains(modelsInfo, modelName) {
    return modelsInfo.some((model) => model.name === modelName || model.modelName === modelName || model.model_name === modelName);
}
function validateModelName(value, name) {
    if (!value.trim() || value === "." || value === ".." || value.startsWith(".") || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
        throw new Error(`Invalid SBV2 model name for ${name}: ${value}`);
    }
}
function requireValue(value, name) {
    if (!value)
        throw new Error(`Missing ${name}`);
    return value;
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
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
