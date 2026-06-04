import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createJobManifest, type Sbv2JobManifest } from "./jobs.js";
import { Sbv2Client, type Sbv2ModelInfo } from "./sbv2-client.js";

export interface Sbv2StyleMergeRecipeStyle {
  styleA: string;
  styleB: string;
  outputStyle: string;
}

export interface Sbv2StyleMergeRecipe {
  schemaVersion: 1;
  outputModelName: string;
  modelA: string;
  modelB: string;
  styleWeight?: number;
  styles: Sbv2StyleMergeRecipeStyle[];
}

export interface Sbv2StyleMergeInput {
  modelName: string;
  modelDir: string;
  configJsonPath: string;
  styleVectorsPath: string;
  style2id: Record<string, number>;
  numStyles: number;
  styleVectorShape: number[];
}

export interface Sbv2StyleMergeRow {
  index: number;
  styleA: string;
  styleAIndex: number;
  styleB: string;
  styleBIndex: number;
  outputStyle: string;
}

export interface Sbv2StyleMergeCompatibilityReport {
  compatible: boolean;
  errors: string[];
  warnings: string[];
}

export interface Sbv2StyleMergePlan {
  schemaVersion: 1;
  sbv2Root: string;
  assetsRoot: string;
  recipePath: string;
  outputModelName: string;
  outputDir: string;
  outputConfigJsonPath: string;
  outputStyleVectorsPath: string;
  modelA: Sbv2StyleMergeInput;
  modelB: Sbv2StyleMergeInput;
  styleWeight: number;
  styleRows: Sbv2StyleMergeRow[];
  outputStyle2id: Record<string, number>;
  compatibility: Sbv2StyleMergeCompatibilityReport;
  expectedArtifacts: string[];
}

export interface StyleMergePlanOptions {
  sbv2Root?: string;
  recipePath: string;
}

export interface StyleMergeRunOptions extends StyleMergePlanOptions {
  jobsRoot?: string;
  confirmOutputModelName: string;
  baseUrl?: string;
  now?: () => Date;
  randomId?: () => string;
}

export interface Sbv2StyleMergeSummary {
  schemaVersion: 1;
  outputModelName: string;
  outputDir: string;
  recipePath: string;
  plan: Sbv2StyleMergePlan;
  styleWeight: number;
  outputStyle2id: Record<string, number>;
  refresh?: {
    baseUrl: string;
    refreshed: boolean;
    foundInModelsInfo: boolean;
    modelsInfoCount: number;
  };
  nextSteps: string[];
}

export interface StyleMergeRunResult {
  plan: Sbv2StyleMergePlan;
  summary: Sbv2StyleMergeSummary;
  job: Sbv2JobManifest;
}

interface Sbv2PathConfigRoots {
  assetsRoot: string;
}

interface ParsedNpy {
  shape: number[];
  dataOffset: number;
  descr: string;
  bytesPerElement: number;
  littleEndian: boolean;
}

const DEFAULT_SBV2_ROOT = "~/src/Style-Bert-VITS2";
const DEFAULT_STYLE_WEIGHT = 0.5;
const TONE_LABELS = new Set(["clear", "soft", "bright", "alert"]);

export async function createStyleMergePlan(options: StyleMergePlanOptions): Promise<Sbv2StyleMergePlan> {
  const recipePath = resolveUserPath(options.recipePath);
  const recipe = parseStyleMergeRecipe(JSON.parse(await readFile(recipePath, "utf8")) as unknown);
  validateModelName(recipe.outputModelName, "recipe.outputModelName");
  validateModelName(recipe.modelA, "recipe.modelA");
  validateModelName(recipe.modelB, "recipe.modelB");

  const sbv2Root = resolveUserPath(options.sbv2Root ?? process.env.SBV2_ROOT ?? DEFAULT_SBV2_ROOT);
  const roots = await readSbv2PathConfig(sbv2Root);
  const outputDir = path.join(roots.assetsRoot, recipe.outputModelName);
  const outputConfigJsonPath = path.join(outputDir, "config.json");
  const outputStyleVectorsPath = path.join(outputDir, "style_vectors.npy");
  const [modelA, modelB] = await Promise.all([
    inspectStyleMergeInput(roots.assetsRoot, recipe.modelA, "model A"),
    inspectStyleMergeInput(roots.assetsRoot, recipe.modelB, "model B"),
  ]);
  const styleWeight = normalizeStyleWeight(recipe.styleWeight);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!(await isDirectory(outputDir))) {
    errors.push(`output model assets directory was not found: ${outputDir}`);
  }
  if (!(await isNonEmptyFile(path.join(outputDir, `${recipe.outputModelName}.safetensors`)))) {
    warnings.push(`output model safetensors was not found at the conventional path: ${path.join(outputDir, `${recipe.outputModelName}.safetensors`)}`);
  }
  if (modelA.styleVectorShape.slice(1).join("x") !== modelB.styleVectorShape.slice(1).join("x")) {
    errors.push("model A and model B style vector dimensions must match");
  }

  const outputStyle2id: Record<string, number> = {};
  const styleRows: Sbv2StyleMergeRow[] = [];
  for (const [index, style] of recipe.styles.entries()) {
    const outputStyle = style.outputStyle.trim();
    if (!outputStyle) {
      errors.push(`styles[${index}].outputStyle must be a non-empty string`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(outputStyle2id, outputStyle)) {
      errors.push(`duplicate output style name: ${outputStyle}`);
      continue;
    }
    const styleAIndex = modelA.style2id[style.styleA];
    const styleBIndex = modelB.style2id[style.styleB];
    if (styleAIndex === undefined) {
      errors.push(`style "${style.styleA}" was not found in model A (${modelA.modelName})`);
    }
    if (styleBIndex === undefined) {
      errors.push(`style "${style.styleB}" was not found in model B (${modelB.modelName})`);
    }
    for (const [label, value] of [
      ["styleA", style.styleA],
      ["styleB", style.styleB],
      ["outputStyle", outputStyle],
    ] as const) {
      if (TONE_LABELS.has(value.toLowerCase())) {
        warnings.push(`${label} "${value}" looks like an agent tone label; verify it is an actual SBV2 style name`);
      }
    }
    outputStyle2id[outputStyle] = index;
    if (styleAIndex !== undefined && styleBIndex !== undefined) {
      styleRows.push({
        index,
        styleA: style.styleA,
        styleAIndex,
        styleB: style.styleB,
        styleBIndex,
        outputStyle,
      });
    }
  }

  return {
    schemaVersion: 1,
    sbv2Root,
    assetsRoot: roots.assetsRoot,
    recipePath,
    outputModelName: recipe.outputModelName,
    outputDir,
    outputConfigJsonPath,
    outputStyleVectorsPath,
    modelA,
    modelB,
    styleWeight,
    styleRows,
    outputStyle2id,
    compatibility: {
      compatible: errors.length === 0,
      errors,
      warnings,
    },
    expectedArtifacts: [outputConfigJsonPath, outputStyleVectorsPath, path.join(outputDir, "recipe.json")],
  };
}

export async function runStyleMerge(options: StyleMergeRunOptions): Promise<StyleMergeRunResult> {
  const plan = await createStyleMergePlan(options);
  if (options.confirmOutputModelName !== plan.outputModelName) {
    throw new Error(`--confirm-output-model-name must exactly match ${plan.outputModelName}`);
  }
  if (!plan.compatibility.compatible) {
    throw new Error(`Style merge plan is not compatible: ${plan.compatibility.errors.join("; ")}`);
  }

  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const logLines = [`style merge started for ${plan.outputModelName}`];
  const outputVectors = await buildMergedStyleVectors(plan);
  const config = await readConfig(plan.modelA.configJsonPath);
  updateConfigForOutput(config, plan.outputModelName, plan.outputStyle2id);

  await mkdir(plan.outputDir, { recursive: true });
  await writeNpyFloat32(plan.outputStyleVectorsPath, outputVectors, [plan.styleRows.length, plan.modelA.styleVectorShape[1]]);
  await writeFile(plan.outputConfigJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(path.join(plan.outputDir, "recipe.json"), `${JSON.stringify(buildOutputRecipe(plan), null, 2)}\n`, "utf8");
  logLines.push(`wrote style_vectors.npy and config.json for ${plan.outputModelName}`);

  const summary: Sbv2StyleMergeSummary = {
    schemaVersion: 1,
    outputModelName: plan.outputModelName,
    outputDir: plan.outputDir,
    recipePath: path.join(plan.outputDir, "recipe.json"),
    plan,
    styleWeight: plan.styleWeight,
    outputStyle2id: plan.outputStyle2id,
    nextSteps: [
      "Run /models/refresh or rerun with --base-url to verify registration.",
      "Generate evaluation samples for each real output style before using the model.",
    ],
  };

  if (options.baseUrl) {
    const client = new Sbv2Client({ baseUrl: options.baseUrl });
    const modelsInfo = await client.refreshModels();
    const found = modelInfoContains(modelsInfo, plan.outputModelName);
    summary.refresh = {
      baseUrl: options.baseUrl,
      refreshed: true,
      foundInModelsInfo: found,
      modelsInfoCount: modelsInfo.length,
    };
    logLines.push(`refreshed SBV2 models from ${options.baseUrl}`);
    if (!found) {
      throw new Error(`Style merged model "${plan.outputModelName}" was not found in /models/info after refresh`);
    }
  }

  const job = await createJobManifest({
    jobsRoot: options.jobsRoot,
    operation: "model-style-merge",
    inputSummary: {
      outputModelName: plan.outputModelName,
      modelA: plan.modelA.modelName,
      modelB: plan.modelB.modelName,
      styleWeight: plan.styleWeight,
      styleCount: plan.styleRows.length,
    },
    artifactPaths: [plan.outputConfigJsonPath, plan.outputStyleVectorsPath, path.join(plan.outputDir, "recipe.json")],
    progressSummary: `Style merge completed for ${plan.outputModelName}.`,
    logLines: [...logLines, `style merge succeeded for ${plan.outputModelName}`],
    now,
    randomId,
  });
  const summaryPath = path.join(job.outputDir, "summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  job.artifactPaths = [...job.artifactPaths, summaryPath];
  await writeFile(path.join(job.outputDir, "manifest.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  return { plan, summary, job };
}

function parseStyleMergeRecipe(value: unknown): Sbv2StyleMergeRecipe {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("style merge recipe schemaVersion must be 1");
  }
  if (typeof value.outputModelName !== "string" || typeof value.modelA !== "string" || typeof value.modelB !== "string") {
    throw new Error("style merge recipe requires outputModelName, modelA, and modelB");
  }
  if (!Array.isArray(value.styles) || value.styles.length === 0) {
    throw new Error("style merge recipe styles must be a non-empty array");
  }
  return {
    schemaVersion: 1,
    outputModelName: value.outputModelName,
    modelA: value.modelA,
    modelB: value.modelB,
    ...(typeof value.styleWeight === "number" ? { styleWeight: value.styleWeight } : {}),
    styles: value.styles.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.styleA !== "string" || typeof entry.styleB !== "string" || typeof entry.outputStyle !== "string") {
        throw new Error(`styles[${index}] requires styleA, styleB, and outputStyle`);
      }
      return { styleA: entry.styleA, styleB: entry.styleB, outputStyle: entry.outputStyle };
    }),
  };
}

async function inspectStyleMergeInput(assetsRoot: string, modelName: string, label: string): Promise<Sbv2StyleMergeInput> {
  const modelDir = path.join(assetsRoot, modelName);
  const configJsonPath = path.join(modelDir, "config.json");
  const styleVectorsPath = path.join(modelDir, "style_vectors.npy");
  if (!(await isDirectory(modelDir))) throw new Error(`${label} assets directory was not found: ${modelDir}`);
  const config = await readConfig(configJsonPath);
  const style2id = readStyle2id(config, configJsonPath);
  const numStyles = readNumStyles(config, configJsonPath);
  if (Object.keys(style2id).length !== numStyles) {
    throw new Error(`${label} config.json data.num_styles must match data.style2id size: ${configJsonPath}`);
  }
  if (!isZeroBasedPermutation(Object.values(style2id), numStyles)) {
    throw new Error(`${label} config.json data.style2id values must be a zero-based permutation: ${configJsonPath}`);
  }
  const npy = parseNpy(await readFile(styleVectorsPath));
  if (!npy || npy.shape.length !== 2 || npy.shape[0] < 1) {
    throw new Error(`${label} style_vectors.npy must be a 2D NumPy file: ${styleVectorsPath}`);
  }
  if (npy.shape[0] !== numStyles) {
    throw new Error(`${label} style_vectors.npy row count ${npy.shape[0]} does not match config.json data.num_styles ${numStyles}: ${styleVectorsPath}`);
  }
  return {
    modelName,
    modelDir,
    configJsonPath,
    styleVectorsPath,
    style2id,
    numStyles,
    styleVectorShape: npy.shape,
  };
}

async function buildMergedStyleVectors(plan: Sbv2StyleMergePlan): Promise<Float32Array> {
  const a = readNpyNumeric2d(await readFile(plan.modelA.styleVectorsPath));
  const b = readNpyNumeric2d(await readFile(plan.modelB.styleVectorsPath));
  const width = plan.modelA.styleVectorShape[1];
  const output = new Float32Array(plan.styleRows.length * width);
  for (const row of plan.styleRows) {
    const aOffset = row.styleAIndex * width;
    const bOffset = row.styleBIndex * width;
    const outOffset = row.index * width;
    for (let index = 0; index < width; index += 1) {
      output[outOffset + index] = a.values[aOffset + index] * (1 - plan.styleWeight) + b.values[bOffset + index] * plan.styleWeight;
    }
  }
  return output;
}

function readNpyNumeric2d(buffer: Buffer): { shape: number[]; values: Float32Array } {
  const header = parseNpy(buffer);
  if (!header || header.shape.length !== 2) throw new Error("style_vectors.npy must be a valid 2D NumPy file");
  const count = header.shape.reduce((total, value) => total * value, 1);
  const expectedBytes = count * header.bytesPerElement;
  if (buffer.length < header.dataOffset + expectedBytes) throw new Error("style_vectors.npy data is truncated");
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = header.dataOffset + index * header.bytesPerElement;
    if (header.bytesPerElement === 4) {
      values[index] = header.littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset);
    } else if (header.bytesPerElement === 8) {
      values[index] = header.littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset);
    } else {
      throw new Error(`Unsupported NumPy dtype: ${header.descr}`);
    }
  }
  return { shape: header.shape, values };
}

function parseNpy(buffer: Buffer): ParsedNpy | undefined {
  if (buffer.length < 10 || buffer.toString("latin1", 0, 6) !== "\x93NUMPY") return undefined;
  const major = buffer[6];
  const headerLengthBytes = major === 1 ? 2 : major === 2 || major === 3 ? 4 : 0;
  if (!headerLengthBytes || buffer.length < 8 + headerLengthBytes) return undefined;
  const headerLength = headerLengthBytes === 2 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = 8 + headerLengthBytes;
  const headerEnd = headerStart + headerLength;
  if (buffer.length < headerEnd) return undefined;
  const text = buffer.toString("latin1", headerStart, headerEnd);
  const descr = text.match(/'descr'\s*:\s*'([^']+)'/)?.[1];
  const fortranOrder = text.match(/'fortran_order'\s*:\s*(True|False)/)?.[1];
  const shapeText = text.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1];
  if (!descr || fortranOrder !== "False" || !shapeText) return undefined;
  const bytesPerElement = Number(descr.match(/(\d+)$/)?.[1]);
  if (!Number.isInteger(bytesPerElement) || bytesPerElement <= 0) return undefined;
  const littleEndian = descr.startsWith("<") || descr.startsWith("|");
  const shape = shapeText
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  if (!shape.length || !shape.every((part) => Number.isInteger(part) && part >= 0)) return undefined;
  return { shape, dataOffset: headerEnd, descr, bytesPerElement, littleEndian };
}

async function writeNpyFloat32(filePath: string, values: Float32Array, shape: [number, number]): Promise<void> {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape[0]}, ${shape[1]}), }`;
  const magicLength = 10;
  const padding = 16 - ((magicLength + header.length + 1) % 16);
  const paddedHeader = `${header}${" ".repeat(padding)}\n`;
  const result = Buffer.alloc(magicLength + paddedHeader.length + values.length * 4);
  result.write("\x93NUMPY", 0, "latin1");
  result[6] = 1;
  result[7] = 0;
  result.writeUInt16LE(paddedHeader.length, 8);
  result.write(paddedHeader, magicLength, "latin1");
  for (let index = 0; index < values.length; index += 1) {
    result.writeFloatLE(values[index], magicLength + paddedHeader.length + index * 4);
  }
  await writeFile(filePath, result);
}

function updateConfigForOutput(config: Record<string, unknown>, outputModelName: string, style2id: Record<string, number>): void {
  const data = config.data;
  if (!isRecord(data)) throw new Error("config.json is missing data object");
  config.model_name = outputModelName;
  data.num_styles = Object.keys(style2id).length;
  data.style2id = style2id;
  if (data.n_speakers === 1) {
    data.spk2id = { [outputModelName]: 0 };
  }
}

function buildOutputRecipe(plan: Sbv2StyleMergePlan): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operation: "style-merge",
    method: "usual",
    modelA: plan.modelA.modelName,
    modelB: plan.modelB.modelName,
    outputModelName: plan.outputModelName,
    styleWeight: plan.styleWeight,
    styles: plan.styleRows.map((row) => ({
      styleA: row.styleA,
      styleB: row.styleB,
      outputStyle: row.outputStyle,
    })),
  };
}

async function readConfig(filePath: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`config.json root must be an object: ${filePath}`);
  return parsed;
}

function readStyle2id(config: Record<string, unknown>, filePath: string): Record<string, number> {
  const data = config.data;
  if (!isRecord(data) || !isRecord(data.style2id) || !Object.keys(data.style2id).length) {
    throw new Error(`config.json data.style2id must be a non-empty object: ${filePath}`);
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(data.style2id)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`config.json data.style2id values must be non-negative safe integers: ${filePath}`);
    }
    result[key] = value;
  }
  return result;
}

function readNumStyles(config: Record<string, unknown>, filePath: string): number {
  const data = config.data;
  if (!isRecord(data) || typeof data.num_styles !== "number" || !Number.isInteger(data.num_styles) || data.num_styles < 1) {
    throw new Error(`config.json data.num_styles must be a positive integer: ${filePath}`);
  }
  return data.num_styles;
}

function normalizeStyleWeight(value: number | undefined): number {
  const number = value ?? DEFAULT_STYLE_WEIGHT;
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error("styleWeight must be between 0 and 1");
  }
  return number;
}

async function readSbv2PathConfig(sbv2Root: string): Promise<Sbv2PathConfigRoots> {
  const pathsPath = path.join(sbv2Root, "configs", "paths.yml");
  const defaultPathsPath = path.join(sbv2Root, "configs", "default_paths.yml");
  const configPath = (await pathExists(pathsPath))
    ? pathsPath
    : (await pathExists(defaultPathsPath))
      ? defaultPathsPath
      : null;
  if (!configPath) return { assetsRoot: path.join(sbv2Root, "model_assets") };
  const text = await readFile(configPath, "utf8");
  return {
    assetsRoot: resolveSbv2ConfigPath(sbv2Root, parseSimpleYamlString(text, "assets_root") ?? "model_assets"),
  };
}

function parseSimpleYamlString(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:#]+)\s*:\s*(.*?)\s*(?:#.*)?$/);
    if (!match || match[1] !== key) continue;
    const value = match[2].trim();
    return value ? value.replace(/^['"]|['"]$/g, "") : undefined;
  }
  return undefined;
}

function resolveSbv2ConfigPath(sbv2Root: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(sbv2Root, value);
}

function modelInfoContains(models: Sbv2ModelInfo[], modelName: string): boolean {
  return models.some((model) => model.name === modelName || model.sourceId === modelName);
}

function validateModelName(value: string, label: string): void {
  if (!value.trim() || value === "." || value === ".." || value.startsWith(".") || /[\\/]/.test(value) || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid SBV2 model name for ${label}: ${value}`);
  }
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
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() && fileStat.size > 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZeroBasedPermutation(values: number[], size: number): boolean {
  if (values.length !== size) return false;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.every((value, index) => value === index);
}
