import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJobManifest } from "./jobs.js";
const execFileAsync = promisify(execFile);
export const DEFAULT_DATASETS_ROOT = "~/.openclaw/state/style-bert-vits2-bridge/datasets";
export const DEFAULT_SBV2_ROOT = "~/src/Style-Bert-VITS2";
export const DEFAULT_TRANSCRIPTION_BACKEND = "hf-whisper";
export const DEFAULT_TRANSCRIPTION_MODEL = "litagin/anime-whisper";
export const DEFAULT_TRANSCRIPTION_BATCH_SIZE = 16;
export const DEFAULT_YOMI_ERROR = "skip";
export const DEFAULT_NOT_USE_CUSTOM_BATCH_SAMPLER = false;
export const DEFAULT_SLICE_MIN_SEC = 2;
export const DEFAULT_SLICE_MAX_SEC = 12;
export const DEFAULT_SLICE_MIN_SILENCE_DUR_MS = 700;
export const DEFAULT_SLICE_NUM_PROCESSES = 3;
export const DEFAULT_TRANSCRIPTION_FASTER_WHISPER_MODEL = "large-v3";
export const DEFAULT_TRANSCRIPTION_COMPUTE_TYPE = "bfloat16";
export const DEFAULT_TRANSCRIPTION_NUM_BEAMS = 1;
export const DEFAULT_TRANSCRIPTION_INITIAL_PROMPT = "";
const SUPPORTED_AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".mp3", ".ogg", ".opus", ".m4a"]);
function resolveUserPath(value) {
    if (value === "~") {
        return homedir();
    }
    if (value.startsWith("~/")) {
        return path.join(homedir(), value.slice(2));
    }
    return path.resolve(value);
}
export function resolveDatasetsRoot(value) {
    return resolveUserPath(value?.trim() || DEFAULT_DATASETS_ROOT);
}
export function resolveSbv2Root(value) {
    return resolveUserPath(value?.trim() || process.env.SBV2_ROOT || DEFAULT_SBV2_ROOT);
}
function makeWorkspaceId(now, randomId) {
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `sbv2-dataset-${stamp}-${randomId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}
function validateModelName(value) {
    const modelName = value.trim();
    if (!modelName) {
        throw new Error("modelName is required");
    }
    if (modelName === "." || modelName === ".." || /[\\/]/.test(modelName) || /[\u0000-\u001f]/.test(modelName)) {
        throw new Error(`Invalid SBV2 model name: ${value}`);
    }
    return modelName;
}
function assertLanguage(value) {
    if (!["ja", "en", "zh"].includes(value)) {
        throw new Error(`Unsupported language: ${value}`);
    }
}
function isSupportedAudioPath(filePath) {
    return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
async function pathExists(filePath) {
    try {
        await stat(filePath);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}
function normalizeRelativePath(filePath) {
    return filePath.split(path.sep).join("/");
}
async function collectDirectoryFiles(root, current = root) {
    const entries = await readdir(current, { withFileTypes: true });
    const files = await Promise.all(entries.map(async (entry) => {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
            return collectDirectoryFiles(root, fullPath);
        }
        if (entry.isFile()) {
            return [fullPath];
        }
        return [];
    }));
    return files.flat().sort((left, right) => left.localeCompare(right));
}
async function collectSourceFiles(sourceAudioPath) {
    const sourcePath = resolveUserPath(sourceAudioPath);
    const sourceStat = await stat(sourcePath).catch((error) => {
        if (isNodeError(error) && error.code === "ENOENT") {
            throw new Error(`sourceAudioPath was not found: ${sourcePath}`);
        }
        throw error;
    });
    if (sourceStat.isFile()) {
        if (!isSupportedAudioPath(sourcePath)) {
            throw new Error(`Unsupported audio file extension: ${sourcePath}`);
        }
        return [{ originalPath: sourcePath, relativePath: path.basename(sourcePath) }];
    }
    if (!sourceStat.isDirectory()) {
        throw new Error(`sourceAudioPath must be a file or directory: ${sourcePath}`);
    }
    const allFiles = await collectDirectoryFiles(sourcePath);
    const unsupported = allFiles.filter((file) => !isSupportedAudioPath(file));
    if (unsupported.length) {
        throw new Error(`Unsupported files were found in sourceAudioPath: ${unsupported.join(", ")}`);
    }
    const audioFiles = allFiles.filter(isSupportedAudioPath);
    if (!audioFiles.length) {
        throw new Error(`No supported audio files found in sourceAudioPath: ${sourcePath}`);
    }
    return audioFiles.map((file) => ({
        originalPath: file,
        relativePath: path.relative(sourcePath, file),
    }));
}
async function sha256File(filePath) {
    const hash = createHash("sha256");
    await new Promise((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolve);
    });
    return hash.digest("hex");
}
async function probeAudioWithFfprobe(filePath) {
    try {
        const { stdout } = await execFileAsync("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_name,sample_rate",
            "-of",
            "json",
            filePath,
        ]);
        const parsed = JSON.parse(stdout);
        if (!isRecord(parsed)) {
            return { warning: "ffprobe returned an unsupported response" };
        }
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const firstStream = streams.find(isRecord);
        const format = isRecord(parsed.format) ? parsed.format : {};
        return {
            durationSec: typeof format.duration === "string" ? Number(format.duration) : undefined,
            codec: typeof firstStream?.codec_name === "string" ? firstStream.codec_name : undefined,
            sampleRate: typeof firstStream?.sample_rate === "string" ? Number(firstStream.sample_rate) : undefined,
        };
    }
    catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = rawMessage.replace(/\s+/g, " ").trim();
        return { warning: `ffprobe failed: ${message}` };
    }
}
function buildStyleGroups(files) {
    const groups = new Map();
    for (const file of files) {
        const segments = file.relativePath.split(/[\\/]+/).filter(Boolean);
        if (segments.length > 1) {
            const styleName = segments[0];
            const existing = groups.get(styleName) ?? [];
            existing.push(file.relativePath);
            groups.set(styleName, existing);
        }
    }
    if (groups.size < 2) {
        return { styleMode: "neutral", styleGroups: [] };
    }
    return {
        styleMode: "directory",
        styleGroups: [...groups.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([styleName, groupFiles]) => ({
            styleName,
            relativeDir: styleName,
            fileCount: groupFiles.length,
            files: groupFiles.sort((left, right) => left.localeCompare(right)),
        })),
    };
}
export async function ingestDataset(options) {
    assertLanguage(options.language);
    const modelName = validateModelName(options.modelName);
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const created = now();
    const datasetsRoot = resolveDatasetsRoot(options.datasetsRoot);
    const sbv2Root = resolveSbv2Root(options.sbv2Root);
    const datasetPath = path.join(sbv2Root, "Data", modelName);
    const assetsPath = path.join(sbv2Root, "model_assets", modelName);
    if (await pathExists(datasetPath)) {
        throw new Error(`SBV2 dataset already exists: ${datasetPath}`);
    }
    if (await pathExists(assetsPath)) {
        throw new Error(`SBV2 model assets already exist: ${assetsPath}`);
    }
    const sourceFiles = await collectSourceFiles(options.sourceAudioPath);
    const workspaceId = makeWorkspaceId(created, randomId);
    const workspaceDir = path.join(datasetsRoot, workspaceId);
    const originalsDir = path.join(workspaceDir, "originals");
    const manifestPath = path.join(workspaceDir, "manifest.json");
    const probeAudio = options.probeAudio ?? probeAudioWithFfprobe;
    const warnings = [];
    await mkdir(originalsDir, { recursive: true });
    const files = [];
    for (const sourceFile of sourceFiles) {
        const storedPath = path.join(originalsDir, sourceFile.relativePath);
        await mkdir(path.dirname(storedPath), { recursive: true });
        await copyFile(sourceFile.originalPath, storedPath);
        const [fileStat, sha256, probe] = await Promise.all([
            stat(storedPath),
            sha256File(storedPath),
            probeAudio(storedPath),
        ]);
        if (probe.warning) {
            warnings.push(`${sourceFile.relativePath}: ${probe.warning}`);
        }
        files.push({
            originalPath: sourceFile.originalPath,
            storedPath,
            relativePath: sourceFile.relativePath,
            sizeBytes: fileStat.size,
            sha256,
            extension: path.extname(sourceFile.relativePath).toLowerCase(),
            ...(probe.durationSec !== undefined && Number.isFinite(probe.durationSec) ? { durationSec: probe.durationSec } : {}),
            ...(probe.codec ? { codec: probe.codec } : {}),
            ...(probe.sampleRate !== undefined && Number.isFinite(probe.sampleRate) ? { sampleRate: probe.sampleRate } : {}),
            ...(probe.warning ? { probeWarning: probe.warning } : {}),
        });
    }
    const style = buildStyleGroups(files);
    const dataset = {
        schemaVersion: 1,
        workspaceId,
        modelName,
        language: options.language,
        useJpExtra: options.useJpExtra,
        createdAt: created.toISOString(),
        sourceAudioPath: resolveUserPath(options.sourceAudioPath),
        workspaceDir,
        originalsDir,
        manifestPath,
        sbv2Root,
        datasetPath,
        assetsPath,
        productionDefaults: {
            transcriptionBackend: DEFAULT_TRANSCRIPTION_BACKEND,
            transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
            transcriptionBatchSize: DEFAULT_TRANSCRIPTION_BATCH_SIZE,
            yomiError: DEFAULT_YOMI_ERROR,
            notUseCustomBatchSampler: DEFAULT_NOT_USE_CUSTOM_BATCH_SAMPLER,
            initialPrompt: null,
            sliceOptions: "SBV2 default",
            preprocessOptions: "SBV2 GUI/default",
        },
        styleMode: style.styleMode,
        styleGroups: style.styleGroups,
        files,
        warnings,
    };
    await writeFile(manifestPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
    const job = await createJobManifest({
        jobsRoot: options.jobsRoot,
        operation: "dataset-ingest",
        inputSummary: {
            workspaceId,
            modelName,
            sourceAudioPath: dataset.sourceAudioPath,
            datasetManifestPath: manifestPath,
            datasetWorkspaceDir: workspaceDir,
        },
        artifactPaths: [manifestPath],
        progressSummary: `Dataset ingest completed for ${modelName}.`,
        logLines: [
            `dataset ingest started for ${modelName}`,
            `copied ${files.length} audio file(s) to ${originalsDir}`,
            `manifest written to ${manifestPath}`,
            `dataset ingest succeeded for ${modelName}`,
        ],
        now,
        randomId,
    });
    return { dataset, job };
}
export async function readDatasetManifest(filePath) {
    const resolvedPath = resolveUserPath(filePath);
    const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
    if (!isSbv2DatasetManifest(parsed)) {
        throw new Error(`Invalid SBV2 dataset manifest: ${resolvedPath}`);
    }
    return parsed;
}
export async function prepareDataset(options) {
    const manifestPath = resolveUserPath(options.manifestPath);
    const dataset = await readDatasetManifest(manifestPath);
    const runner = options.commandRunner ?? runSbv2Command;
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const rawDir = path.join(dataset.datasetPath, "raw");
    const esdListPath = path.join(dataset.datasetPath, "esd.list");
    const scriptPaths = [path.join(dataset.sbv2Root, "slice.py"), path.join(dataset.sbv2Root, "transcribe.py")];
    const executedCommands = [];
    const logLines = [`dataset prepare started for ${dataset.modelName}`];
    const fail = async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "dataset-prepare",
            state: "failed",
            inputSummary: {
                workspaceId: dataset.workspaceId,
                modelName: dataset.modelName,
                datasetManifestPath: manifestPath,
            },
            artifactPaths: [manifestPath],
            firstError: message,
            retryable: false,
            progressSummary: `Dataset prepare failed for ${dataset.modelName}.`,
            logLines: [...logLines, message],
            now,
            randomId,
        });
        throw error;
    };
    try {
        assertLanguage(dataset.language);
        validateModelName(dataset.modelName);
        if (!(await pathExists(dataset.originalsDir))) {
            throw new Error(`Dataset originals directory was not found: ${dataset.originalsDir}`);
        }
        for (const scriptPath of scriptPaths) {
            if (!(await pathExists(scriptPath))) {
                throw new Error(`Required SBV2 script was not found: ${scriptPath}`);
            }
        }
        if (await pathExists(rawDir)) {
            throw new Error(`SBV2 raw dataset already exists: ${rawDir}`);
        }
        if (await pathExists(esdListPath)) {
            throw new Error(`SBV2 esd.list already exists: ${esdListPath}`);
        }
        if (await pathExists(dataset.assetsPath)) {
            throw new Error(`SBV2 model assets already exist: ${dataset.assetsPath}`);
        }
        const sliceArgs = [
            "run",
            "python",
            "slice.py",
            "--model_name",
            dataset.modelName,
            "--input_dir",
            dataset.originalsDir,
            "--min_sec",
            String(DEFAULT_SLICE_MIN_SEC),
            "--max_sec",
            String(DEFAULT_SLICE_MAX_SEC),
            "--min_silence_dur_ms",
            String(DEFAULT_SLICE_MIN_SILENCE_DUR_MS),
            "--num_processes",
            String(DEFAULT_SLICE_NUM_PROCESSES),
        ];
        await runAndLogCommand(runner, "uv", sliceArgs, dataset.sbv2Root, executedCommands, logLines);
        const transcribeArgs = [
            "run",
            "python",
            "transcribe.py",
            "--model_name",
            dataset.modelName,
            "--model",
            DEFAULT_TRANSCRIPTION_FASTER_WHISPER_MODEL,
            "--compute_type",
            DEFAULT_TRANSCRIPTION_COMPUTE_TYPE,
            "--language",
            dataset.language,
            "--initial_prompt",
            DEFAULT_TRANSCRIPTION_INITIAL_PROMPT,
            "--num_beams",
            String(DEFAULT_TRANSCRIPTION_NUM_BEAMS),
            "--use_hf_whisper",
            "--hf_repo_id",
            DEFAULT_TRANSCRIPTION_MODEL,
            "--batch_size",
            String(DEFAULT_TRANSCRIPTION_BATCH_SIZE),
        ];
        await runAndLogCommand(runner, "uv", transcribeArgs, dataset.sbv2Root, executedCommands, logLines);
        const summary = await buildPrepareSummary(dataset, rawDir, esdListPath, executedCommands);
        const job = await createJobManifest({
            jobsRoot: options.jobsRoot,
            operation: "dataset-prepare",
            inputSummary: {
                workspaceId: dataset.workspaceId,
                modelName: dataset.modelName,
                datasetManifestPath: manifestPath,
                rawDir,
                esdListPath,
            },
            artifactPaths: [manifestPath, rawDir, esdListPath],
            progressSummary: `Dataset prepare completed for ${dataset.modelName}.`,
            logLines: [
                ...logLines,
                `raw wav files: ${summary.rawWavCount}`,
                `esd.list lines: ${summary.esdLineCount}`,
                `dataset prepare succeeded for ${dataset.modelName}`,
            ],
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
        return { dataset, summary, job: updatedJob };
    }
    catch (error) {
        return fail(error);
    }
}
async function runSbv2Command(executable, args, options) {
    const result = await execFileAsync(executable, args, {
        cwd: options.cwd,
        maxBuffer: 20 * 1024 * 1024,
    });
    return {
        stdout: result.stdout,
        stderr: result.stderr,
    };
}
async function runAndLogCommand(runner, executable, args, cwd, commands, logLines) {
    commands.push({ executable, args, cwd });
    logLines.push(`running: ${executable} ${args.join(" ")}`);
    const result = await runner(executable, args, { cwd });
    if (result.stdout?.trim()) {
        logLines.push(result.stdout.trim());
    }
    if (result.stderr?.trim()) {
        logLines.push(result.stderr.trim());
    }
}
async function buildPrepareSummary(dataset, rawDir, esdListPath, commands) {
    const rawFiles = (await collectDirectoryFiles(rawDir))
        .filter((file) => path.extname(file).toLowerCase() === ".wav")
        .map((file) => normalizeRelativePath(path.relative(rawDir, file)))
        .sort((left, right) => left.localeCompare(right));
    if (!rawFiles.length) {
        throw new Error(`No sliced WAV files were generated in ${rawDir}`);
    }
    const esdText = await readFile(esdListPath, "utf8").catch((error) => {
        if (isNodeError(error) && error.code === "ENOENT") {
            throw new Error(`SBV2 esd.list was not generated: ${esdListPath}`);
        }
        throw error;
    });
    const esdLines = esdText.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!esdLines.length) {
        throw new Error(`SBV2 esd.list is empty: ${esdListPath}`);
    }
    const rawSet = new Set(rawFiles);
    const transcribed = new Set();
    const missingAudioReferences = [];
    const warnings = [...dataset.warnings];
    for (const [index, line] of esdLines.entries()) {
        const parts = line.split("|");
        if (parts.length < 4) {
            warnings.push(`esd.list line ${index + 1} does not have four pipe-delimited fields`);
            continue;
        }
        const [audioRelativePath, speakerName, languageId, text] = parts;
        const normalizedAudioPath = normalizeRelativePath(audioRelativePath.trim());
        transcribed.add(normalizedAudioPath);
        if (!rawSet.has(normalizedAudioPath)) {
            missingAudioReferences.push(normalizedAudioPath);
        }
        if (speakerName !== dataset.modelName) {
            warnings.push(`esd.list line ${index + 1} speaker is ${speakerName}, expected ${dataset.modelName}`);
        }
        const expectedLanguageId = toSbv2LanguageId(dataset.language);
        if (languageId !== expectedLanguageId) {
            warnings.push(`esd.list line ${index + 1} language is ${languageId}, expected ${expectedLanguageId}`);
        }
        if (!text.trim()) {
            warnings.push(`esd.list line ${index + 1} has empty transcription text`);
        }
    }
    const untranscribedWavs = rawFiles.filter((file) => !transcribed.has(file));
    if (missingAudioReferences.length) {
        warnings.push(`${missingAudioReferences.length} esd.list audio reference(s) were not found under raw`);
    }
    if (untranscribedWavs.length) {
        warnings.push(`${untranscribedWavs.length} raw WAV file(s) were not listed in esd.list`);
    }
    return {
        schemaVersion: 1,
        workspaceId: dataset.workspaceId,
        modelName: dataset.modelName,
        rawDir,
        esdListPath,
        rawWavCount: rawFiles.length,
        esdLineCount: esdLines.length,
        styleGroups: dataset.styleGroups,
        missingAudioReferences,
        untranscribedWavs,
        warnings,
        commands,
    };
}
function toSbv2LanguageId(language) {
    if (language === "ja")
        return "JP";
    if (language === "en")
        return "EN";
    return "ZH";
}
function isSbv2DatasetManifest(value) {
    if (!isRecord(value)) {
        return false;
    }
    return (value.schemaVersion === 1 &&
        typeof value.workspaceId === "string" &&
        typeof value.modelName === "string" &&
        (value.language === "ja" || value.language === "en" || value.language === "zh") &&
        typeof value.useJpExtra === "boolean" &&
        typeof value.originalsDir === "string" &&
        typeof value.manifestPath === "string" &&
        typeof value.sbv2Root === "string" &&
        typeof value.datasetPath === "string" &&
        typeof value.assetsPath === "string" &&
        Array.isArray(value.files) &&
        Array.isArray(value.styleGroups) &&
        Array.isArray(value.warnings));
}
function isNodeError(value) {
    return value instanceof Error && "code" in value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
