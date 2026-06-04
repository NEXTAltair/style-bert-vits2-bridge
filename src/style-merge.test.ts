import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStyleMergePlan, runStyleMerge } from "./style-merge.js";

const originalFetch = globalThis.fetch;

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createSbv2Root(): string {
  const sbv2Root = tempRoot("sbv2-style-merge-root-");
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
  return sbv2Root;
}

function writeModelAssets(
  sbv2Root: string,
  modelName: string,
  styles: Record<string, number>,
  values: number[][],
): void {
  const modelDir = path.join(sbv2Root, "model_assets", modelName);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(
    path.join(modelDir, "config.json"),
    `${JSON.stringify({
      model_name: modelName,
      model: {},
      train: {},
      data: {
        n_speakers: 1,
        num_styles: Object.keys(styles).length,
        spk2id: { [modelName]: 0 },
        id2spk: { "0": modelName },
        style2id: styles,
      },
    })}\n`,
  );
  writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy(values));
  writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors());
}

function omitSpeakerCount(sbv2Root: string, modelName: string): void {
  const configPath = path.join(sbv2Root, "model_assets", modelName, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { data: Record<string, unknown> };
  delete config.data.n_speakers;
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
}

function updateModelConfig(sbv2Root: string, modelName: string, update: (config: Record<string, unknown>) => void): void {
  const configPath = path.join(sbv2Root, "model_assets", modelName, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  update(config);
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
}

function writeRecipe(
  root: string,
  recipe: {
    outputModelName: string;
    modelA: string;
    modelB: string;
    styleWeight?: number;
    styles: Array<{ styleA: string; styleB: string; outputStyle: string }>;
  },
): string {
  const recipePath = path.join(root, "style-merge.json");
  writeFileSync(recipePath, `${JSON.stringify({ schemaVersion: 1, ...recipe }, null, 2)}\n`);
  return recipePath;
}

function makeNpy(rows: number[][]): Buffer {
  return makeNpyWithDescriptor(rows, "<f4");
}

function makeNpyWithDescriptor(rows: number[][], descriptor: string): Buffer {
  const rowCount = rows.length;
  const width = rows[0]?.length ?? 0;
  const header = `{'descr': '${descriptor}', 'fortran_order': False, 'shape': (${rowCount}, ${width}), }`;
  const bytesPerElement = Number(descriptor.match(/(\d+)$/)?.[1] ?? 4);
  const magicLength = 10;
  const padding = 16 - ((magicLength + header.length + 1) % 16);
  const paddedHeader = `${header}${" ".repeat(padding)}\n`;
  const result = Buffer.alloc(magicLength + paddedHeader.length + rowCount * width * bytesPerElement);
  result.write("\x93NUMPY", 0, "latin1");
  result[6] = 1;
  result[7] = 0;
  result.writeUInt16LE(paddedHeader.length, 8);
  result.write(paddedHeader, magicLength, "latin1");
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      const offset = magicLength + paddedHeader.length + (rowIndex * width + columnIndex) * bytesPerElement;
      if (descriptor.endsWith("8")) {
        result.writeDoubleLE(value, offset);
      } else if (descriptor.includes("i")) {
        result.writeInt32LE(value, offset);
      } else {
        result.writeFloatLE(value, offset);
      }
    }
  }
  return result;
}

function readNpyValues(filePath: string): number[][] {
  const buffer = readFileSync(filePath);
  const headerLength = buffer.readUInt16LE(8);
  const headerEnd = 10 + headerLength;
  const shapeMatch = buffer.toString("latin1", 10, headerEnd).match(/'shape'\s*:\s*\(([^)]*)\)/);
  if (!shapeMatch) throw new Error("missing shape");
  const [rows, width] = shapeMatch[1].split(",").map((part) => Number(part.trim())).filter((value) => !Number.isNaN(value));
  const result: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const values: number[] = [];
    for (let column = 0; column < width; column += 1) {
      values.push(buffer.readFloatLE(headerEnd + (row * width + column) * 4));
    }
    result.push(values);
  }
  return result;
}

function makeSafetensors(): Buffer {
  const payload = Buffer.alloc(4);
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, payload.length] } }), "utf8");
  const result = Buffer.alloc(8 + header.length + payload.length);
  result.writeBigUInt64LE(BigInt(header.length), 0);
  header.copy(result, 8);
  payload.copy(result, 8 + header.length);
  return result;
}

describe("SBV2 style merge", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("plans GUI-compatible A/B style vector rows", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0, Calm: 1 }, [[0, 0], [2, 2]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0, Happy: 1 }, [[10, 10], [20, 30]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [
        { styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" },
        { styleA: "Calm", styleB: "Happy", outputStyle: "Happy" },
      ],
    });

    const plan = await createStyleMergePlan({ sbv2Root, recipePath });

    expect(plan.compatibility.compatible).toBe(true);
    expect(plan.styleWeight).toBe(0.5);
    expect(plan.outputStyle2id).toEqual({ Neutral: 0, Happy: 1 });
    expect(plan.styleRows).toEqual([
      expect.objectContaining({ index: 0, styleAIndex: 0, styleBIndex: 0, outputStyle: "Neutral" }),
      expect.objectContaining({ index: 1, styleAIndex: 1, styleBIndex: 1, outputStyle: "Happy" }),
    ]);
  });

  it("writes style_vectors.npy and config.json for an existing merged model", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-style-merge-jobs-");
    writeModelAssets(sbv2Root, "base", { Neutral: 0, Calm: 1 }, [[0, 0], [2, 2]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0, Happy: 1 }, [[10, 10], [20, 30]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    updateModelConfig(sbv2Root, "merged", (config) => {
      config.output_only = true;
      const data = config.data as Record<string, unknown>;
      data.spk2id = { mergedSpeaker: 0 };
      data.id2spk = { "0": "mergedSpeaker" };
    });
    writeFileSync(path.join(sbv2Root, "model_assets", "merged", "recipe.json"), "model merge recipe\n");
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styleWeight: 0.25,
      styles: [
        { styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" },
        { styleA: "Calm", styleB: "Happy", outputStyle: "Happy" },
      ],
    });

    const result = await runStyleMerge({
      sbv2Root,
      jobsRoot,
      recipePath,
      confirmOutputModelName: "merged",
      now: () => new Date("2026-06-04T00:00:00.000Z"),
      randomId: () => "style123",
    });

    expect(result.job.operation).toBe("model-style-merge");
    expect(readNpyValues(path.join(sbv2Root, "model_assets", "merged", "style_vectors.npy"))).toEqual([
      [2.5, 2.5],
      [6.5, 9],
    ]);
    const config = JSON.parse(readFileSync(path.join(sbv2Root, "model_assets", "merged", "config.json"), "utf8")) as {
      model_name: string;
      output_only?: boolean;
      data: { num_styles: number; style2id: Record<string, number>; spk2id: Record<string, number>; id2spk: Record<string, string> };
    };
    expect(config.model_name).toBe("merged");
    expect(config.output_only).toBe(true);
    expect(config.data.num_styles).toBe(2);
    expect(config.data.style2id).toEqual({ Neutral: 0, Happy: 1 });
    expect(config.data.spk2id).toEqual({ mergedSpeaker: 0 });
    expect(config.data.id2spk).toEqual({ "0": "mergedSpeaker" });
    expect(readFileSync(path.join(sbv2Root, "model_assets", "merged", "recipe.json"), "utf8")).toBe("model merge recipe\n");
    expect(readFileSync(path.join(sbv2Root, "model_assets", "merged", "style-merge-recipe.json"), "utf8")).toContain('"operation": "style-merge"');
    expect(readFileSync(path.join(result.job.outputDir, "summary.json"), "utf8")).toContain('"outputModelName": "merged"');
  });

  it("rejects missing styles and duplicate output names before writing", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [
        { styleA: "Neutral", styleB: "Happy", outputStyle: "Neutral" },
        { styleA: "Missing", styleB: "Neutral", outputStyle: "Neutral" },
      ],
    });

    const plan = await createStyleMergePlan({ sbv2Root, recipePath });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors.join("\n")).toContain('style "Happy" was not found in model B');
    expect(plan.compatibility.errors.join("\n")).toContain("duplicate output style name: Neutral");
  });

  it("treats prototype property names as missing styles", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "toString", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    const plan = await createStyleMergePlan({ sbv2Root, recipePath });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors.join("\n")).toContain('style "toString" was not found in model A');
  });

  it("preserves __proto__ as an own output style name", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-style-merge-jobs-");
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "__proto__" }],
    });

    await runStyleMerge({
      sbv2Root,
      jobsRoot,
      recipePath,
      confirmOutputModelName: "merged",
    });

    const config = JSON.parse(readFileSync(path.join(sbv2Root, "model_assets", "merged", "config.json"), "utf8")) as {
      data: { num_styles: number; style2id: Record<string, number> };
    };
    expect(config.data.num_styles).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(config.data.style2id, "__proto__")).toBe(true);
    expect(config.data.style2id.__proto__).toBe(0);
  });

  it("rejects non-numeric styleWeight recipe values", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const recipePath = path.join(sbv2Root, "style-merge.json");
    writeFileSync(
      recipePath,
      `${JSON.stringify({
        schemaVersion: 1,
        outputModelName: "merged",
        modelA: "base",
        modelB: "donor",
        styleWeight: "0.8",
        styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
      })}\n`,
    );

    await expect(createStyleMergePlan({ sbv2Root, recipePath })).rejects.toThrow("styleWeight must be a number");
  });

  it("rejects output models that alias inputs", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "base",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    const plan = await createStyleMergePlan({ sbv2Root, recipePath });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors).toContain("outputModelName must not be the same as modelA or modelB");
  });

  it("rejects non-float style vector dtypes", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    writeFileSync(path.join(sbv2Root, "model_assets", "base", "style_vectors.npy"), makeNpyWithDescriptor([[1, 2]], "<i4"));
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    await expect(createStyleMergePlan({ sbv2Root, recipePath })).rejects.toThrow("dtype must be float32 or float64");
  });

  it("rejects truncated style vector payloads while planning", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const complete = makeNpy([[1, 2]]);
    writeFileSync(path.join(sbv2Root, "model_assets", "base", "style_vectors.npy"), complete.subarray(0, complete.length - 4));
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    await expect(createStyleMergePlan({ sbv2Root, recipePath })).rejects.toThrow("style_vectors.npy data is truncated");
  });

  it("rejects native-endian style vector descriptors instead of guessing host endian", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    writeFileSync(path.join(sbv2Root, "model_assets", "base", "style_vectors.npy"), makeNpyWithDescriptor([[1, 2]], "=f4"));
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    await expect(createStyleMergePlan({ sbv2Root, recipePath })).rejects.toThrow("dtype must be float32 or float64");
  });

  it("preserves output speaker maps when n_speakers is omitted", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-style-merge-jobs-");
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    omitSpeakerCount(sbv2Root, "merged");
    updateModelConfig(sbv2Root, "merged", (config) => {
      const data = config.data as Record<string, unknown>;
      data.spk2id = { mergedSpeaker: 0 };
      data.id2spk = { "0": "mergedSpeaker" };
    });
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    await runStyleMerge({
      sbv2Root,
      jobsRoot,
      recipePath,
      confirmOutputModelName: "merged",
    });

    const config = JSON.parse(readFileSync(path.join(sbv2Root, "model_assets", "merged", "config.json"), "utf8")) as {
      data: { spk2id: Record<string, number>; id2spk: Record<string, string> };
    };
    expect(config.data.spk2id).toEqual({ mergedSpeaker: 0 });
    expect(config.data.id2spk).toEqual({ "0": "mergedSpeaker" });
  });

  it("rejects output directories without a non-empty safetensors model", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    unlinkSync(path.join(sbv2Root, "model_assets", "merged", "merged.safetensors"));
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });

    const plan = await createStyleMergePlan({ sbv2Root, recipePath });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors.join("\n")).toContain("must contain a non-empty .safetensors file");
  });

  it("records failed jobs when refresh misses the style-merged model", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-style-merge-jobs-");
    writeModelAssets(sbv2Root, "base", { Neutral: 0 }, [[0, 0]]);
    writeModelAssets(sbv2Root, "donor", { Neutral: 0 }, [[10, 10]]);
    writeModelAssets(sbv2Root, "merged", { Neutral: 0 }, [[0, 0]]);
    const recipePath = writeRecipe(sbv2Root, {
      outputModelName: "merged",
      modelA: "base",
      modelB: "donor",
      styles: [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }],
    });
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: [{ model_name: "other" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      runStyleMerge({
        sbv2Root,
        jobsRoot,
        recipePath,
        confirmOutputModelName: "merged",
        baseUrl: "http://localhost:5000",
        now: () => new Date("2026-06-04T00:00:00.000Z"),
        randomId: () => "refreshfail",
      }),
    ).rejects.toThrow('Style merged model "merged" was not found');

    const manifest = JSON.parse(readFileSync(path.join(jobsRoot, "sbv2-job-20260604000000-refreshf", "manifest.json"), "utf8")) as {
      state: string;
      inputSummary: { outputAssetsRetained?: boolean; refresh?: { foundInModelsInfo?: boolean } };
    };
    expect(manifest.state).toBe("failed");
    expect(manifest.inputSummary.outputAssetsRetained).toBe(true);
    expect(manifest.inputSummary.refresh).toMatchObject({ foundInModelsInfo: false });
  });
});
