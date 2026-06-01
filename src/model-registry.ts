import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createJobManifest, type Sbv2JobManifest } from "./jobs.js";
import { readDatasetManifest } from "./datasets.js";
import { Sbv2Client, type Sbv2ModelInfo } from "./sbv2-client.js";

export interface Sbv2ModelCandidateFile {
  path: string;
  sizeBytes: number;
}

export interface Sbv2ModelCandidate {
  schemaVersion: 1;
  candidateId: string;
  modelName: string;
  sbv2Root: string;
  sourceDir: string;
  targetDir: string;
  configJsonPath: string;
  styleVectorsPath: string;
  safetensors: Sbv2ModelCandidateFile[];
  configModelName?: string;
  warnings: string[];
  errors: string[];
  promotable: boolean;
}

export interface ListModelCandidatesOptions {
  manifestPath?: string;
  sbv2Root?: string;
  modelName?: string;
  sourcePath?: string;
}

export interface PromoteModelOptions extends ListModelCandidatesOptions {
  jobsRoot?: string;
  confirmModelName: string;
  backupExisting?: boolean;
  baseUrl?: string;
  now?: () => Date;
  randomId?: () => string;
}

export interface Sbv2ModelPromotionSummary {
  schemaVersion: 1;
  modelName: string;
  sourceDir: string;
  targetDir: string;
  copied: boolean;
  backupDir: string | null;
  candidate: Sbv2ModelCandidate;
  refresh?: {
    baseUrl: string;
    refreshed: boolean;
    foundInModelsInfo: boolean;
    modelsInfoCount: number;
  };
}

export interface PromoteModelResult {
  candidate: Sbv2ModelCandidate;
  summary: Sbv2ModelPromotionSummary;
  job: Sbv2JobManifest;
}

interface ModelContext {
  sbv2Root: string;
  modelName: string;
  assetsRoot: string;
  sourceDir: string;
  targetDir: string;
}

interface Sbv2PathConfigRoots {
  assetsRoot: string;
}

const MAX_SAFETENSORS_HEADER_BYTES = 100 * 1024 * 1024;

export async function listModelCandidates(options: ListModelCandidatesOptions): Promise<Sbv2ModelCandidate[]> {
  const context = await resolveModelContext(options);
  return [await inspectModelCandidate(context)];
}

export async function promoteModel(options: PromoteModelOptions): Promise<PromoteModelResult> {
  const context = await resolveModelContext(options);
  if (options.confirmModelName !== context.modelName) {
    throw new Error(`--confirm-model-name must exactly match ${context.modelName}`);
  }

  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const logLines: string[] = [`model promotion started for ${context.modelName}`];
  let backupDir: string | null = null;
  let copied = false;
  let cleanupTargetOnFailure = false;
  let candidate = await inspectModelCandidate(context);

  const fail = async (error: unknown): Promise<never> => {
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
      } else {
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
    } else {
      logLines.push(`model assets already exist at target: ${context.targetDir}`);
    }

    const summary: Sbv2ModelPromotionSummary = {
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
    const updatedJob: Sbv2JobManifest = {
      ...job,
      artifactPaths: [...job.artifactPaths, summaryPath],
    };
    await writeFile(path.join(job.outputDir, "manifest.json"), `${JSON.stringify(updatedJob, null, 2)}\n`, "utf8");
    return { candidate, summary, job: updatedJob };
  } catch (error) {
    const refreshAfterRecovery = Boolean(options.baseUrl && copied);
    if (backupDir) {
      await rollbackBackup(context.targetDir, backupDir, logLines);
      if (refreshAfterRecovery && options.baseUrl) {
        await refreshAfterFailedMutation(options.baseUrl, logLines);
      }
    } else if (cleanupTargetOnFailure) {
      await cleanupCopiedTarget(context.targetDir, logLines);
      if (refreshAfterRecovery && options.baseUrl) {
        await refreshAfterFailedMutation(options.baseUrl, logLines);
      }
    }
    return fail(error);
  }
}

async function inspectModelCandidate(context: ModelContext): Promise<Sbv2ModelCandidate> {
  const sourceDir = resolveUserPath(context.sourceDir);
  const warnings: string[] = [];
  const errors: string[] = [];
  const configJsonPath = path.join(sourceDir, "config.json");
  const styleVectorsPath = path.join(sourceDir, "style_vectors.npy");
  let configModelName: string | undefined;
  let expectedStyleRows: number | undefined;

  const sourceStat = await directoryStat(sourceDir);
  if (!sourceStat.exists) {
    errors.push(`candidate directory was not found: ${sourceDir}`);
  } else if (!sourceStat.isDirectory) {
    errors.push(`candidate path is not a directory: ${sourceDir}`);
  }

  const configStat = await nonEmptyFileStat(configJsonPath);
  if (!configStat) {
    errors.push(`config.json is missing or empty: ${configJsonPath}`);
  } else {
    try {
      const config = JSON.parse(await readFile(configJsonPath, "utf8")) as unknown;
      configModelName = readConfigModelName(config);
      if (configModelName && configModelName !== context.modelName) {
        errors.push(`config.json model_name "${configModelName}" does not match "${context.modelName}"`);
      }
      expectedStyleRows = readConfigNumStyles(config);
      errors.push(...validateConfigShape(config));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`config.json is not valid JSON: ${message}`);
    }
  }

  if (!(await nonEmptyFileStat(styleVectorsPath))) {
    errors.push(`style_vectors.npy is missing or empty: ${styleVectorsPath}`);
  } else {
    errors.push(...(await validateStyleVectorsFile(styleVectorsPath, expectedStyleRows)));
  }

  const safetensorsResult = await listSafetensors(sourceDir);
  const safetensors = safetensorsResult.files;
  errors.push(...safetensorsResult.errors);
  if (!safetensors.length) {
    errors.push(`no non-empty .safetensors files were found in ${sourceDir}`);
  }
  if (!(await samePath(sourceDir, context.targetDir))) {
    errors.push(...(await validateSourceSymlinks(sourceDir)));
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

async function resolveModelContext(options: ListModelCandidatesOptions): Promise<ModelContext> {
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

async function readSbv2PathConfig(sbv2Root: string): Promise<Sbv2PathConfigRoots> {
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

async function listSafetensors(sourceDir: string): Promise<{ files: Sbv2ModelCandidateFile[]; errors: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return { files: [], errors: [] };
    throw error;
  }
  const files: Sbv2ModelCandidateFile[] = [];
  const errors: string[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (!entry.endsWith(".safetensors") || entry.startsWith(".")) continue;
    const filePath = path.join(sourceDir, entry);
    const fileStat = await fileStatOrError(filePath);
    if (!fileStat) {
      errors.push(`safetensors file could not be inspected: ${filePath}`);
      continue;
    }
    if (!fileStat.isFile() || fileStat.size === 0) {
      errors.push(`safetensors file is missing or empty: ${filePath}`);
      continue;
    }
    const validationErrors = await validateSafetensorsFile(filePath, fileStat.size);
    if (validationErrors.length) {
      errors.push(...validationErrors);
    } else {
      files.push({ path: filePath, sizeBytes: fileStat.size });
    }
  }
  return { files, errors };
}

async function nonEmptyFileStat(filePath: string): Promise<{ size: number } | undefined> {
  try {
    const result = await stat(filePath);
    return result.isFile() && result.size > 0 ? { size: result.size } : undefined;
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
    throw error;
  }
}

function readConfigModelName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.model_name ?? value.modelName;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function readConfigNumStyles(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.data)) return undefined;
  const candidate = value.data.num_styles;
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
}

function collectCandidateArtifacts(candidate: Sbv2ModelCandidate): string[] {
  return [
    candidate.configJsonPath,
    candidate.styleVectorsPath,
    ...candidate.safetensors.map((file) => file.path),
  ];
}

function modelInfoContains(modelsInfo: Sbv2ModelInfo[], modelName: string): boolean {
  return modelsInfo.some((model) => model.name === modelName || model.modelName === modelName || model.model_name === modelName);
}

async function samePath(left: string, right: string): Promise<boolean> {
  return path.resolve(left) === path.resolve(right);
}

async function makeBackupDir(assetsRoot: string, modelName: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const base = path.join(assetsRoot, ".bridge-backups", `${modelName}-${stamp}`);
  if (!(await pathExists(base))) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Unable to find an unused backup path for ${modelName}`);
}

async function rollbackBackup(targetDir: string, backupDir: string, logLines: string[]): Promise<void> {
  try {
    await rm(targetDir, { recursive: true, force: true });
    await rename(backupDir, targetDir);
    logLines.push(`rolled back model assets from backup: ${backupDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLines.push(`warning: failed to roll back model assets from ${backupDir}: ${message}`);
  }
}

async function cleanupCopiedTarget(targetDir: string, logLines: string[]): Promise<void> {
  try {
    await rm(targetDir, { recursive: true, force: true });
    logLines.push(`removed incomplete promoted model assets: ${targetDir}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLines.push(`warning: failed to remove incomplete model assets ${targetDir}: ${message}`);
  }
}

async function refreshAfterFailedMutation(baseUrl: string, logLines: string[]): Promise<void> {
  try {
    const modelsInfo = await new Sbv2Client({ baseUrl }).refreshModels();
    logLines.push(`refreshed SBV2 models after failed promotion recovery from ${baseUrl}; models=${modelsInfo.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLines.push(`warning: failed to refresh SBV2 models after promotion recovery from ${baseUrl}: ${message}`);
  }
}

function validateConfigShape(value: unknown): string[] {
  if (!isRecord(value)) {
    return ["config.json root must be an object"];
  }
  const errors: string[] = [];
  if (!readConfigModelName(value)) {
    errors.push("config.json model_name must be a non-empty string");
  }
  if (!isRecord(value.model)) {
    errors.push("config.json is missing model object");
  }
  if (!isRecord(value.train)) {
    errors.push("config.json is missing train object");
  }
  const data = value.data;
  if (!isRecord(data)) {
    errors.push("config.json is missing data object");
    return errors;
  }
  const spk2id = data.spk2id;
  const style2id = data.style2id;
  const numStyles = data.num_styles;
  errors.push(...validateIdMap(spk2id, "data.spk2id"));
  errors.push(...validateIdMap(style2id, "data.style2id"));
  if (typeof numStyles !== "number" || !Number.isInteger(numStyles) || numStyles < 1) {
    errors.push("config.json data.num_styles must be a positive integer");
  } else if (isRecord(style2id) && Object.keys(style2id).length !== numStyles) {
    errors.push("config.json data.num_styles must match data.style2id size");
  } else if (isRecord(style2id) && !isZeroBasedPermutation(Object.values(style2id), numStyles)) {
    errors.push("config.json data.style2id values must be a zero-based permutation of data.num_styles");
  }
  return errors;
}

function validateModelName(value: string): void {
  if (!value.trim() || value === "." || value === ".." || value.startsWith(".") || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid SBV2 model name: ${value}`);
  }
}

async function validateStyleVectorsFile(filePath: string, expectedRows?: number): Promise<string[]> {
  const buffer = await readFile(filePath);
  const header = parseNpyHeader(buffer);
  if (!header) {
    return [`style_vectors.npy is not a valid NumPy .npy file: ${filePath}`];
  }
  const { shape } = header;
  if (shape.length < 2 || shape[0] < 1) {
    return [`style_vectors.npy must have at least one 2D style vector row: ${filePath}`];
  }
  if (expectedRows !== undefined && shape[0] !== expectedRows) {
    return [`style_vectors.npy row count ${shape[0]} does not match config.json data.num_styles ${expectedRows}: ${filePath}`];
  }
  const expectedDataBytes = calculateNpyDataBytes(shape, header.bytesPerElement);
  if (expectedDataBytes === undefined || buffer.length < header.dataOffset + expectedDataBytes) {
    return [`style_vectors.npy data is truncated: ${filePath}`];
  }
  return [];
}

function parseNpyHeader(buffer: Buffer): { shape: number[]; dataOffset: number; bytesPerElement: number } | undefined {
  if (buffer.length < 10 || buffer.toString("latin1", 0, 6) !== "\x93NUMPY") {
    return undefined;
  }
  const major = buffer[6];
  const minor = buffer[7];
  const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
  if (!headerLengthBytes || minor === undefined || buffer.length < 8 + headerLengthBytes) {
    return undefined;
  }
  const headerLength =
    headerLengthBytes === 2 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = 8 + headerLengthBytes;
  const headerEnd = headerStart + headerLength;
  if (buffer.length < headerEnd) {
    return undefined;
  }
  const header = buffer.toString("latin1", headerStart, headerEnd);
  const shapeMatch = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
  const descrMatch = header.match(/'descr'\s*:\s*'([^']+)'/);
  if (!shapeMatch || !descrMatch) {
    return undefined;
  }
  const bytesPerElement = parseNpyDescriptorBytes(descrMatch[1]);
  if (!bytesPerElement) {
    return undefined;
  }
  const shape = shapeMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));
  return shape.length && shape.every((part) => Number.isInteger(part) && part >= 0)
    ? { shape, dataOffset: headerEnd, bytesPerElement }
    : undefined;
}

function parseNpyDescriptorBytes(descriptor: string): number | undefined {
  const match = descriptor.match(/^[<>=|]?([A-Za-z])(\d+)$/);
  if (!match) return undefined;
  const kind = match[1];
  if (!["f", "i", "u", "c", "b"].includes(kind)) return undefined;
  const bytes = Number(match[2]);
  return Number.isInteger(bytes) && bytes > 0 ? bytes : undefined;
}

function calculateNpyDataBytes(shape: number[], bytesPerElement: number): number | undefined {
  let count = 1;
  for (const dimension of shape) {
    count *= dimension;
    if (!Number.isSafeInteger(count)) return undefined;
  }
  const total = count * bytesPerElement;
  return Number.isSafeInteger(total) ? total : undefined;
}

function parseSimpleYamlString(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const withoutComment = line.replace(/\s+#.*$/, "");
    const match = withoutComment.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!match || match[1] !== key) continue;
    const value = match[2].trim();
    return value ? value.replace(/^['"]|['"]$/g, "") : undefined;
  }
  return undefined;
}

function resolveSbv2ConfigPath(sbv2Root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(sbv2Root, value);
}

function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryStat(filePath: string): Promise<{ exists: boolean; isDirectory: boolean }> {
  try {
    const result = await stat(filePath);
    return { exists: true, isDirectory: result.isDirectory() };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { exists: false, isDirectory: false };
    throw error;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateIdMap(value: unknown, name: string): string[] {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return [`config.json ${name} must be a non-empty object`];
  }
  if (!Object.values(value).every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) {
    return [`config.json ${name} values must be non-negative safe integers`];
  }
  return [];
}

async function fileStatOrError(filePath: string): Promise<{ isFile: () => boolean; size: number } | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (isNodeError(error)) return undefined;
    throw error;
  }
}

async function validateSourceSymlinks(sourceDir: string): Promise<string[]> {
  const errors: string[] = [];
  await collectUnexpectedSymlinkErrors(sourceDir, sourceDir, errors);
  return errors;
}

async function collectUnexpectedSymlinkErrors(rootDir: string, currentDir: string, errors: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
    throw error;
  }
  for (const entry of entries) {
    if (entry === "." || entry === "..") continue;
    const filePath = path.join(currentDir, entry);
    const relativePath = path.relative(rootDir, filePath);
    let fileStat: Awaited<ReturnType<typeof lstat>>;
    try {
      fileStat = await lstat(filePath);
    } catch (error) {
      if (isNodeError(error)) continue;
      throw error;
    }
    if (fileStat.isSymbolicLink()) {
      if (!isAllowedArtifactSymlink(relativePath)) {
        errors.push(`unexpected symlink in model source: ${filePath}`);
      }
      continue;
    }
    if (fileStat.isDirectory()) {
      await collectUnexpectedSymlinkErrors(rootDir, filePath, errors);
    }
  }
}

function isAllowedArtifactSymlink(relativePath: string): boolean {
  if (relativePath.includes(path.sep)) return false;
  return relativePath === "config.json" || relativePath === "style_vectors.npy" || relativePath.endsWith(".safetensors");
}

function isZeroBasedPermutation(values: unknown[], size: number): boolean {
  const ids = values.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  if (ids.length !== values.length) return false;
  const unique = new Set(ids);
  return unique.size === size && ids.every((id) => id < size);
}

async function validateSafetensorsFile(filePath: string, fileSize: number): Promise<string[]> {
  const header = await readSafetensorsHeader(filePath, fileSize);
  if (!header) {
    return [`safetensors file is not valid: ${filePath}`];
  }
  return validateSafetensorsHeader(header.value, header.dataBytes, filePath);
}

async function readSafetensorsHeader(filePath: string, fileSize: number): Promise<{ value: unknown; dataBytes: number } | undefined> {
  if (fileSize < 8) return undefined;
  const file = await open(filePath, "r");
  try {
    const lengthBuffer = Buffer.alloc(8);
    const lengthRead = await file.read(lengthBuffer, 0, lengthBuffer.length, 0);
    if (lengthRead.bytesRead !== lengthBuffer.length) return undefined;
    const headerLengthBig = lengthBuffer.readBigUInt64LE(0);
    if (headerLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    const headerLength = Number(headerLengthBig);
    const headerStart = 8;
    const headerEnd = headerStart + headerLength;
    if (headerLength < 2 || headerLength > MAX_SAFETENSORS_HEADER_BYTES || headerEnd > fileSize) return undefined;
    const headerBuffer = Buffer.alloc(headerLength);
    const headerRead = await file.read(headerBuffer, 0, headerLength, headerStart);
    if (headerRead.bytesRead !== headerLength) return undefined;
    try {
      const value = JSON.parse(headerBuffer.toString("utf8")) as unknown;
      return { value, dataBytes: fileSize - headerEnd };
    } catch {
      return undefined;
    }
  } finally {
    await file.close();
  }
}

function validateSafetensorsHeader(value: unknown, dataBytes: number, filePath: string): string[] {
  if (!isRecord(value)) {
    return [`safetensors header must be an object: ${filePath}`];
  }
  const tensorEntries = Object.entries(value).filter(([name]) => name !== "__metadata__");
  if (!tensorEntries.length) {
    return [`safetensors file must include at least one tensor: ${filePath}`];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const [name, tensor] of tensorEntries) {
    if (!isRecord(tensor)) {
      return [`safetensors tensor metadata is invalid for ${name}: ${filePath}`];
    }
    const dtype = tensor.dtype;
    const shape = tensor.shape;
    const offsets = tensor.data_offsets;
    const bytesPerElement = typeof dtype === "string" ? safetensorsDtypeBytes(dtype) : undefined;
    if (!bytesPerElement || !Array.isArray(shape) || !Array.isArray(offsets) || offsets.length !== 2) {
      return [`safetensors tensor metadata is invalid for ${name}: ${filePath}`];
    }
    if (!shape.every((dimension) => typeof dimension === "number" && Number.isSafeInteger(dimension) && dimension >= 0)) {
      return [`safetensors tensor shape is invalid for ${name}: ${filePath}`];
    }
    const [start, end] = offsets;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > dataBytes
    ) {
      return [`safetensors tensor data_offsets are invalid for ${name}: ${filePath}`];
    }
    const expectedBytes = calculateNpyDataBytes(shape, bytesPerElement);
    if (expectedBytes === undefined || end - start !== expectedBytes) {
      return [`safetensors tensor byte size does not match shape for ${name}: ${filePath}`];
    }
    ranges.push({ start, end });
  }
  ranges.sort((left, right) => left.start - right.start);
  let nextOffset = 0;
  for (const range of ranges) {
    if (range.start !== nextOffset) {
      return [`safetensors tensor data_offsets must cover payload contiguously: ${filePath}`];
    }
    nextOffset = range.end;
  }
  if (nextOffset !== dataBytes) {
    return [`safetensors tensor data_offsets must cover payload contiguously: ${filePath}`];
  }
  return [];
}

function safetensorsDtypeBytes(dtype: string): number | undefined {
  switch (dtype) {
    case "F64":
    case "I64":
    case "U64":
      return 8;
    case "F32":
    case "I32":
    case "U32":
      return 4;
    case "F16":
    case "BF16":
    case "I16":
    case "U16":
      return 2;
    case "F8_E5M2":
    case "F8_E4M3":
    case "I8":
    case "U8":
    case "BOOL":
      return 1;
    default:
      return undefined;
  }
}
