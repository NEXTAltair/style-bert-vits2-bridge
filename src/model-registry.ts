import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
        backupDir = await makeBackupDir(context.assetsRoot, context.modelName, now());
        await mkdir(path.dirname(backupDir), { recursive: true });
        await rename(context.targetDir, backupDir);
        logLines.push(`backed up existing model assets: ${backupDir}`);
      }
      await cp(context.sourceDir, context.targetDir, { recursive: true, errorOnExist: true, force: false });
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
    if (backupDir) {
      await rollbackBackup(context.targetDir, backupDir, logLines);
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

  if (!(await pathExists(sourceDir))) {
    errors.push(`candidate directory was not found: ${sourceDir}`);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`config.json is not valid JSON: ${message}`);
    }
  }

  if (!(await nonEmptyFileStat(styleVectorsPath))) {
    errors.push(`style_vectors.npy is missing or empty: ${styleVectorsPath}`);
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

async function listSafetensors(sourceDir: string): Promise<Sbv2ModelCandidateFile[]> {
  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files: Sbv2ModelCandidateFile[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (!entry.endsWith(".safetensors") || entry.startsWith(".")) continue;
    const filePath = path.join(sourceDir, entry);
    const fileStat = await nonEmptyFileStat(filePath);
    if (fileStat) {
      files.push({ path: filePath, sizeBytes: fileStat.size });
    }
  }
  return files;
}

async function nonEmptyFileStat(filePath: string): Promise<{ size: number } | undefined> {
  try {
    const result = await stat(filePath);
    return result.isFile() && result.size > 0 ? { size: result.size } : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readConfigModelName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.model_name ?? value.modelName;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
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
  return path.join(assetsRoot, ".bridge-backups", `${modelName}-${stamp}`);
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

function validateModelName(value: string): void {
  if (!value.trim() || value === "." || value === ".." || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid SBV2 model name: ${value}`);
  }
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
