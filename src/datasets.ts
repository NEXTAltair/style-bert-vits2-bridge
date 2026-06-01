import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJobManifest, type Sbv2JobManifest } from "./jobs.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_DATASETS_ROOT = "~/.openclaw/state/style-bert-vits2-bridge/datasets";
export const DEFAULT_SBV2_ROOT = "~/src/Style-Bert-VITS2";
export const DEFAULT_TRANSCRIPTION_BACKEND = "hf-whisper";
export const DEFAULT_TRANSCRIPTION_MODEL = "litagin/anime-whisper";
export const DEFAULT_TRANSCRIPTION_BATCH_SIZE = 16;
export const DEFAULT_YOMI_ERROR = "skip";
export const DEFAULT_NOT_USE_CUSTOM_BATCH_SAMPLER = false;

const SUPPORTED_AUDIO_EXTENSIONS = new Set([".wav", ".flac", ".mp3", ".ogg", ".opus", ".m4a"]);

export type Sbv2DatasetLanguage = "ja" | "en" | "zh";
export type Sbv2DatasetStyleMode = "neutral" | "directory";

export interface Sbv2AudioProbe {
  durationSec?: number;
  codec?: string;
  sampleRate?: number;
  warning?: string;
}

export interface Sbv2DatasetFile {
  originalPath: string;
  storedPath: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  extension: string;
  durationSec?: number;
  codec?: string;
  sampleRate?: number;
  probeWarning?: string;
}

export interface Sbv2DatasetStyleGroup {
  styleName: string;
  relativeDir: string;
  fileCount: number;
  files: string[];
}

export interface Sbv2DatasetManifest {
  schemaVersion: 1;
  workspaceId: string;
  modelName: string;
  language: Sbv2DatasetLanguage;
  useJpExtra: boolean;
  createdAt: string;
  sourceAudioPath: string;
  workspaceDir: string;
  originalsDir: string;
  manifestPath: string;
  sbv2Root: string;
  datasetPath: string;
  assetsPath: string;
  productionDefaults: {
    transcriptionBackend: typeof DEFAULT_TRANSCRIPTION_BACKEND;
    transcriptionModel: typeof DEFAULT_TRANSCRIPTION_MODEL;
    transcriptionBatchSize: typeof DEFAULT_TRANSCRIPTION_BATCH_SIZE;
    yomiError: typeof DEFAULT_YOMI_ERROR;
    notUseCustomBatchSampler: typeof DEFAULT_NOT_USE_CUSTOM_BATCH_SAMPLER;
    initialPrompt: null;
    sliceOptions: "SBV2 default";
    preprocessOptions: "SBV2 GUI/default";
  };
  styleMode: Sbv2DatasetStyleMode;
  styleGroups: Sbv2DatasetStyleGroup[];
  files: Sbv2DatasetFile[];
  warnings: string[];
}

export interface IngestDatasetOptions {
  datasetsRoot?: string;
  jobsRoot?: string;
  sbv2Root?: string;
  modelName: string;
  sourceAudioPath: string;
  language: Sbv2DatasetLanguage;
  useJpExtra: boolean;
  now?: () => Date;
  randomId?: () => string;
  probeAudio?: (filePath: string) => Promise<Sbv2AudioProbe>;
}

export interface IngestDatasetResult {
  dataset: Sbv2DatasetManifest;
  job: Sbv2JobManifest;
}

interface SourceFile {
  originalPath: string;
  relativePath: string;
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function resolveDatasetsRoot(value: string | undefined): string {
  return resolveUserPath(value?.trim() || DEFAULT_DATASETS_ROOT);
}

export function resolveSbv2Root(value: string | undefined): string {
  return resolveUserPath(value?.trim() || process.env.SBV2_ROOT || DEFAULT_SBV2_ROOT);
}

function makeWorkspaceId(now: Date, randomId: () => string): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `sbv2-dataset-${stamp}-${randomId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}

function validateModelName(value: string): string {
  const modelName = value.trim();
  if (!modelName) {
    throw new Error("modelName is required");
  }
  if (modelName === "." || modelName === ".." || /[\\/]/.test(modelName) || /[\u0000-\u001f]/.test(modelName)) {
    throw new Error(`Invalid SBV2 model name: ${value}`);
  }
  return modelName;
}

function assertLanguage(value: Sbv2DatasetLanguage): void {
  if (!["ja", "en", "zh"].includes(value)) {
    throw new Error(`Unsupported language: ${value}`);
  }
}

function isSupportedAudioPath(filePath: string): boolean {
  return SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function collectDirectoryFiles(root: string, current: string = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return collectDirectoryFiles(root, fullPath);
      }
      if (entry.isFile()) {
        return [fullPath];
      }
      return [];
    }),
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
}

async function collectSourceFiles(sourceAudioPath: string): Promise<SourceFile[]> {
  const sourcePath = resolveUserPath(sourceAudioPath);
  const sourceStat = await stat(sourcePath).catch((error: unknown) => {
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

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function probeAudioWithFfprobe(filePath: string): Promise<Sbv2AudioProbe> {
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
    const parsed = JSON.parse(stdout) as unknown;
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
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.replace(/\s+/g, " ").trim();
    return { warning: `ffprobe failed: ${message}` };
  }
}

function buildStyleGroups(files: Sbv2DatasetFile[]): {
  styleMode: Sbv2DatasetStyleMode;
  styleGroups: Sbv2DatasetStyleGroup[];
} {
  const groups = new Map<string, string[]>();
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

export async function ingestDataset(options: IngestDatasetOptions): Promise<IngestDatasetResult> {
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
  const warnings: string[] = [];

  await mkdir(originalsDir, { recursive: true });

  const files: Sbv2DatasetFile[] = [];
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
  const dataset: Sbv2DatasetManifest = {
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
