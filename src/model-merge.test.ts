import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createModelMergePlan, runModelMerge } from "./model-merge.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createSbv2Root(): string {
  const sbv2Root = tempRoot("sbv2-model-merge-root-");
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
  return sbv2Root;
}

function writeModelAssets(
  sbv2Root: string,
  modelName: string,
  shape = [1],
  styleVectors: number[][] = [[0, 0]],
  style2id: Record<string, number> = { Neutral: 0 },
): void {
  const modelDir = path.join(sbv2Root, "model_assets", modelName);
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(makeConfig(modelName, style2id)));
  writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy(styleVectors));
  writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors(shape));
}

function makeConfig(modelName: string, style2id: Record<string, number> = { Neutral: 0 }): Record<string, unknown> {
  return {
    model_name: modelName,
    model: {},
    train: {},
    data: {
      n_speakers: 1,
      num_styles: Object.keys(style2id).length,
      spk2id: { [modelName]: 0 },
      style2id,
    },
  };
}

function makeNpy(rows: number[][], descriptor = "<f4"): Buffer {
  const rowCount = rows.length;
  const width = rows[0]?.length ?? 0;
  const shapeText = `${rowCount}, ${width}`;
  const header = `{'descr': '${descriptor}', 'fortran_order': False, 'shape': (${shapeText}), }`;
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

function writeStyleRecipe(sbv2Root: string, styles: Array<Record<string, string>>): string {
  const recipePath = path.join(sbv2Root, "styles.json");
  writeFileSync(recipePath, `${JSON.stringify({ schemaVersion: 1, styles }, null, 2)}\n`);
  return recipePath;
}

function roundRows(rows: number[][]): number[][] {
  return rows.map((row) => row.map((value) => Math.round(value * 1000) / 1000));
}

function makeSafetensors(shape = [1]): Buffer {
  const payload = Buffer.alloc(Math.max(1, shape.reduce((total, value) => total * value, 1)) * 4);
  const header = Buffer.from(
    JSON.stringify({ weight: { dtype: "F32", shape, data_offsets: [0, payload.length] } }),
    "utf8",
  );
  const result = Buffer.alloc(8 + header.length + payload.length);
  result.writeBigUInt64LE(BigInt(header.length), 0);
  header.copy(result, 8);
  payload.copy(result, 8 + header.length);
  return result;
}

function commonWeightOptions(sbv2Root: string) {
  return {
    sbv2Root,
    outputModelName: "merged",
    modelA: "model-a",
    modelB: "model-b",
    weights: {
      voiceWeight: 0.1,
      voicePitchWeight: 0.2,
      speechStyleWeight: 0.3,
      tempoWeight: 0.4,
    },
  };
}

describe("SBV2 model merge", () => {
  it("creates a usual merge plan with explicit GUI-equivalent weights", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");

    const plan = await createModelMergePlan({
      ...commonWeightOptions(sbv2Root),
      method: "usual",
      slerp: true,
    });

    expect(plan).toMatchObject({
      method: "usual",
      outputModelName: "merged",
      slerp: true,
      compatibility: { compatible: true, errors: [] },
      weights: {
        voiceWeight: 0.1,
        voicePitchWeight: 0.2,
        speechStyleWeight: 0.3,
        tempoWeight: 0.4,
      },
    });
    expect(plan.command.args[3]).toContain("merge_models_usual");
  });

  it("defaults usual merge weights to an even 0.5 blend", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");

    const plan = await createModelMergePlan({
      sbv2Root,
      method: "usual",
      outputModelName: "merged",
      modelA: "model-a",
      modelB: "model-b",
    });

    expect(plan.weights).toEqual({
      voiceWeight: 0.5,
      voicePitchWeight: 0.5,
      speechStyleWeight: 0.5,
      tempoWeight: 0.5,
    });
  });

  it("requires model C for add-diff and exposes the part weights", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    writeModelAssets(sbv2Root, "model-c");

    const plan = await createModelMergePlan({
      ...commonWeightOptions(sbv2Root),
      method: "add-diff",
      modelC: "model-c",
    });

    expect(plan.inputModels.c?.modelName).toBe("model-c");
    expect(plan.weights?.tempoWeight).toBe(0.4);
  });

  it("uses coefficients instead of part weights for weighted-sum", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    writeModelAssets(sbv2Root, "model-c");

    const plan = await createModelMergePlan({
      sbv2Root,
      method: "weighted-sum",
      outputModelName: "merged",
      modelA: "model-a",
      modelB: "model-b",
      modelC: "model-c",
      coefficients: { modelACoeff: 1, modelBCoeff: -1, modelCCoeff: 0 },
    });

    expect(plan.coefficients).toEqual({ modelACoeff: 1, modelBCoeff: -1, modelCCoeff: 0 });
    expect(plan.weights).toBeUndefined();
  });

  it("defaults weighted-sum coefficients to 0.5", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    writeModelAssets(sbv2Root, "model-c");

    const plan = await createModelMergePlan({
      sbv2Root,
      method: "weighted-sum",
      outputModelName: "merged",
      modelA: "model-a",
      modelB: "model-b",
      modelC: "model-c",
    });

    expect(plan.coefficients).toEqual({ modelACoeff: 0.5, modelBCoeff: 0.5, modelCCoeff: 0.5 });
    expect(plan.weights).toBeUndefined();
  });

  it("plans a style recipe as part of model merge", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a", [1], [[0, 0], [2, 2]], { Neutral: 0, Calm: 1 });
    writeModelAssets(sbv2Root, "model-b", [1], [[10, 10], [20, 30]], { Neutral: 0, Happy: 1 });
    const styleRecipePath = writeStyleRecipe(sbv2Root, [
      { styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" },
      { styleA: "Calm", styleB: "Happy", outputStyle: "Happy" },
    ]);

    const plan = await createModelMergePlan({
      ...commonWeightOptions(sbv2Root),
      method: "usual",
      styleRecipePath,
    });

    expect(plan.styleMergeApplied).toBe(true);
    expect(plan.styleRecipePath).toBe(styleRecipePath);
    expect(plan.outputStyle2id).toEqual({ Neutral: 0, Happy: 1 });
    expect(plan.styleRows).toEqual([
      expect.objectContaining({ index: 0, styleAIndex: 0, styleBIndex: 0, outputStyle: "Neutral" }),
      expect.objectContaining({ index: 1, styleAIndex: 1, styleBIndex: 1, outputStyle: "Happy" }),
    ]);
  });

  it("reports method-specific style recipe incompatibility", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    writeModelAssets(sbv2Root, "model-c");
    const styleRecipePath = writeStyleRecipe(sbv2Root, [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }]);

    const plan = await createModelMergePlan({
      sbv2Root,
      method: "weighted-sum",
      outputModelName: "merged",
      modelA: "model-a",
      modelB: "model-b",
      modelC: "model-c",
      styleRecipePath,
    });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors.join("\n")).toContain("requires styleC for weighted-sum");
  });

  it("rejects out-of-range style ids before planning a style recipe", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a", [1], [[0, 0], [1, 1]], { Neutral: 0, Calm: 3 });
    writeModelAssets(sbv2Root, "model-b", [1], [[10, 10], [20, 20]], { Neutral: 0, Happy: 1 });
    const styleRecipePath = writeStyleRecipe(sbv2Root, [{ styleA: "Calm", styleB: "Happy", outputStyle: "Happy" }]);

    await expect(
      createModelMergePlan({
        ...commonWeightOptions(sbv2Root),
        method: "usual",
        styleRecipePath,
      }),
    ).rejects.toThrow("zero-based permutation");
  });

  it("rejects unsupported or truncated style vectors before running merge", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    const styleRecipePath = writeStyleRecipe(sbv2Root, [{ styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" }]);
    writeFileSync(path.join(sbv2Root, "model_assets", "model-a", "style_vectors.npy"), makeNpy([[0, 0]], "<i4"));

    await expect(
      createModelMergePlan({
        ...commonWeightOptions(sbv2Root),
        method: "usual",
        styleRecipePath,
      }),
    ).rejects.toThrow("dtype must be float32 or float64");

    writeFileSync(path.join(sbv2Root, "model_assets", "model-a", "style_vectors.npy"), makeNpy([[0, 0]]).subarray(0, -2));
    await expect(
      createModelMergePlan({
        ...commonWeightOptions(sbv2Root),
        method: "usual",
        styleRecipePath,
      }),
    ).rejects.toThrow("data is truncated");
  });

  it("rejects weighted-sum part weights and non-usual slerp", async () => {
    const sbv2Root = createSbv2Root();
    await expect(
      createModelMergePlan({
        ...commonWeightOptions(sbv2Root),
        method: "weighted-sum",
        modelC: "model-c",
        coefficients: { modelACoeff: 1, modelBCoeff: -1, modelCCoeff: 0 },
      }),
    ).rejects.toThrow("part weights are not valid for weighted-sum");

    await expect(
      createModelMergePlan({
        ...commonWeightOptions(sbv2Root),
        method: "add-null",
        slerp: true,
      }),
    ).rejects.toThrow("--slerp is only valid for usual");
  });

  it("requires an explicit safetensors file when a model has multiple candidates", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    writeFileSync(path.join(sbv2Root, "model_assets", "model-a", "alternate.safetensors"), makeSafetensors());
    writeModelAssets(sbv2Root, "model-b");

    await expect(createModelMergePlan({ ...commonWeightOptions(sbv2Root), method: "usual" })).rejects.toThrow(
      "multiple .safetensors files",
    );

    const plan = await createModelMergePlan({
      ...commonWeightOptions(sbv2Root),
      method: "usual",
      modelAFile: "model-a.safetensors",
    });
    expect(path.basename(plan.inputModels.a.safetensorsPath)).toBe("model-a.safetensors");
  });

  it("rejects nested explicit safetensors paths", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a");
    mkdirSync(path.join(sbv2Root, "model_assets", "model-a", "checkpoints"));
    writeFileSync(path.join(sbv2Root, "model_assets", "model-a", "checkpoints", "G_100.safetensors"), makeSafetensors());
    writeModelAssets(sbv2Root, "model-b");

    await expect(
      createModelMergePlan({
        ...commonWeightOptions(sbv2Root),
        method: "usual",
        modelAFile: "checkpoints/G_100.safetensors",
      }),
    ).rejects.toThrow("top-level .safetensors filename");
  });

  it("reports incompatible tensor and style vector shapes before running", async () => {
    const sbv2Root = createSbv2Root();
    writeModelAssets(sbv2Root, "model-a", [1], [[0, 0]]);
    writeModelAssets(sbv2Root, "model-b", [2], [[0, 0, 0]]);

    const plan = await createModelMergePlan({ ...commonWeightOptions(sbv2Root), method: "usual" });

    expect(plan.compatibility.compatible).toBe(false);
    expect(plan.compatibility.errors.join("\n")).toContain("style vector dimensions");
    expect(plan.compatibility.errors.join("\n")).toContain("shape differs");
  });

  it("runs a merge through an injected command runner and records a model-merge job", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-merge-jobs-");
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");

    const result = await runModelMerge({
      ...commonWeightOptions(sbv2Root),
      method: "usual",
      confirmOutputModelName: "merged",
      jobsRoot,
      commandRunner: async (_executable, _args, options) => {
        const outputDir = path.join(options.cwd, "model_assets", "merged");
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(makeConfig("merged")));
        writeFileSync(path.join(outputDir, "style_vectors.npy"), makeNpy([[0, 0]]));
        writeFileSync(path.join(outputDir, "merged.safetensors"), makeSafetensors());
        writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: "usual" }));
        return { stdout: "merged" };
      },
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "abcdef12",
    });

    expect(result.job).toMatchObject({
      operation: "model-merge",
      state: "succeeded",
    });
    expect(result.candidate.promotable).toBe(true);
    expect(result.summary.recipePath).toBe(path.join(sbv2Root, "model_assets", "merged", "recipe.json"));
    expect(result.summary.refresh).toBeUndefined();
    expect(result.job.inputSummary).toMatchObject({
      method: "usual",
      outputModelName: "merged",
      outputDir: path.join(sbv2Root, "model_assets", "merged"),
      outputSafetensorsPath: path.join(sbv2Root, "model_assets", "merged", "merged.safetensors"),
      recipePath: path.join(sbv2Root, "model_assets", "merged", "recipe.json"),
      weights: {
        voiceWeight: 0.1,
        voicePitchWeight: 0.2,
        speechStyleWeight: 0.3,
        tempoWeight: 0.4,
      },
      inputModels: {
        a: {
          modelName: "model-a",
          safetensorsPath: path.join(sbv2Root, "model_assets", "model-a", "model-a.safetensors"),
        },
        b: {
          modelName: "model-b",
          safetensorsPath: path.join(sbv2Root, "model_assets", "model-b", "model-b.safetensors"),
        },
      },
      outputAssetsRetained: true,
    });
    expect(readFileSync(path.join(result.job.outputDir, "summary.json"), "utf8")).toContain('"outputModelName": "merged"');
  });

  it("applies a usual style recipe inside the model merge job", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-merge-jobs-");
    writeModelAssets(sbv2Root, "model-a", [1], [[0, 0], [2, 2]], { Neutral: 0, Calm: 1 });
    writeModelAssets(sbv2Root, "model-b", [1], [[10, 10], [20, 30]], { Neutral: 0, Happy: 1 });
    const styleRecipePath = writeStyleRecipe(sbv2Root, [
      { styleA: "Neutral", styleB: "Neutral", outputStyle: "Neutral" },
      { styleA: "Calm", styleB: "Happy", outputStyle: "Happy" },
    ]);

    const result = await runModelMerge({
      ...commonWeightOptions(sbv2Root),
      method: "usual",
      confirmOutputModelName: "merged",
      jobsRoot,
      styleRecipePath,
      commandRunner: async (_executable, _args, options) => {
        const outputDir = path.join(options.cwd, "model_assets", "merged");
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(makeConfig("merged")));
        writeFileSync(path.join(outputDir, "style_vectors.npy"), makeNpy([[0, 0]]));
        writeFileSync(path.join(outputDir, "merged.safetensors"), makeSafetensors());
        writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: "usual" }));
        return { stdout: "merged" };
      },
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "stylerec",
    });

    expect(result.plan.styleMergeApplied).toBe(true);
    expect(roundRows(readNpyValues(path.join(sbv2Root, "model_assets", "merged", "style_vectors.npy")))).toEqual([
      [3, 3],
      [7.4, 10.4],
    ]);
    const config = JSON.parse(readFileSync(path.join(sbv2Root, "model_assets", "merged", "config.json"), "utf8")) as {
      data: { num_styles: number; style2id: Record<string, number> };
    };
    expect(config.data.num_styles).toBe(2);
    expect(config.data.style2id).toEqual({ Neutral: 0, Happy: 1 });
    expect(result.job.artifactPaths).toContain(path.join(sbv2Root, "model_assets", "merged", "style-merge-recipe.json"));
  });

  it("applies weighted-sum coefficients to style vectors", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-merge-jobs-");
    writeModelAssets(sbv2Root, "model-a", [1], [[1, 2]], { Neutral: 0 });
    writeModelAssets(sbv2Root, "model-b", [1], [[10, 20]], { Neutral: 0 });
    writeModelAssets(sbv2Root, "model-c", [1], [[3, 4]], { Neutral: 0 });
    const styleRecipePath = writeStyleRecipe(sbv2Root, [
      { styleA: "Neutral", styleB: "Neutral", styleC: "Neutral", outputStyle: "Neutral" },
    ]);

    await runModelMerge({
      sbv2Root,
      method: "weighted-sum",
      outputModelName: "merged",
      confirmOutputModelName: "merged",
      modelA: "model-a",
      modelB: "model-b",
      modelC: "model-c",
      coefficients: { modelACoeff: 1, modelBCoeff: -1, modelCCoeff: 0.5 },
      styleRecipePath,
      jobsRoot,
      commandRunner: async (_executable, _args, options) => {
        const outputDir = path.join(options.cwd, "model_assets", "merged");
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(makeConfig("merged")));
        writeFileSync(path.join(outputDir, "style_vectors.npy"), makeNpy([[0, 0]]));
        writeFileSync(path.join(outputDir, "merged.safetensors"), makeSafetensors());
        writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: "weighted_sum" }));
        return { stdout: "merged" };
      },
    });

    expect(roundRows(readNpyValues(path.join(sbv2Root, "model_assets", "merged", "style_vectors.npy")))).toEqual([[-7.5, -16]]);
  });

  it("keeps generated merge assets when refresh verification fails", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-merge-jobs-");
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    const outputDir = path.join(sbv2Root, "model_assets", "merged");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ models: [{ model_name: "different-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      await expect(
        runModelMerge({
          ...commonWeightOptions(sbv2Root),
          method: "usual",
          confirmOutputModelName: "merged",
          jobsRoot,
          baseUrl: "http://localhost:5000",
          commandRunner: async (_executable, _args, options) => {
            mkdirSync(outputDir, { recursive: true });
            writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(makeConfig("merged")));
            writeFileSync(path.join(outputDir, "style_vectors.npy"), makeNpy([[0, 0]]));
            writeFileSync(path.join(outputDir, "merged.safetensors"), makeSafetensors());
            writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: "usual" }));
            return { stdout: `merged in ${options.cwd}` };
          },
          now: () => new Date("2026-06-02T00:00:00.000Z"),
          randomId: () => "abcdef12",
        }),
      ).rejects.toThrow('was not found in /models/info after refresh');
      expect(existsSync(outputDir)).toBe(true);
      expect(existsSync(path.join(outputDir, "merged.safetensors"))).toBe(true);
      const manifest = JSON.parse(readFileSync(path.join(jobsRoot, "sbv2-job-20260602000000-abcdef12", "manifest.json"), "utf8")) as {
        state: string;
        inputSummary: {
          outputAssetsRetained?: boolean;
          refresh?: { foundInModelsInfo?: boolean; outputAssetsRetained?: boolean };
        };
        artifactPaths: string[];
      };
      expect(manifest.state).toBe("failed");
      expect(manifest.inputSummary.outputAssetsRetained).toBe(true);
      expect(manifest.inputSummary.refresh).toMatchObject({
        foundInModelsInfo: false,
        outputAssetsRetained: true,
      });
      expect(manifest.artifactPaths).toContain(path.join(outputDir, "recipe.json"));
      expect(manifest.artifactPaths).toContain(path.join(jobsRoot, "sbv2-job-20260602000000-abcdef12", "summary.json"));

      const summary = JSON.parse(readFileSync(path.join(jobsRoot, "sbv2-job-20260602000000-abcdef12", "summary.json"), "utf8")) as {
        state: string;
        outputAssetsRetained?: boolean;
        refresh?: { foundInModelsInfo?: boolean };
        nextSteps: string[];
      };
      expect(summary.state).toBe("failed");
      expect(summary.outputAssetsRetained).toBe(true);
      expect(summary.refresh?.foundInModelsInfo).toBe(false);
      expect(summary.nextSteps.join("\n")).toContain(outputDir);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records retained merge artifacts when refresh request fails", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-model-merge-jobs-");
    writeModelAssets(sbv2Root, "model-a");
    writeModelAssets(sbv2Root, "model-b");
    const outputDir = path.join(sbv2Root, "model_assets", "merged");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("server unavailable");
    };

    try {
      await expect(
        runModelMerge({
          ...commonWeightOptions(sbv2Root),
          method: "usual",
          confirmOutputModelName: "merged",
          jobsRoot,
          baseUrl: "http://localhost:5000",
          commandRunner: async (_executable, _args, options) => {
            mkdirSync(outputDir, { recursive: true });
            writeFileSync(path.join(outputDir, "config.json"), JSON.stringify(makeConfig("merged")));
            writeFileSync(path.join(outputDir, "style_vectors.npy"), makeNpy([[0, 0]]));
            writeFileSync(path.join(outputDir, "merged.safetensors"), makeSafetensors());
            writeFileSync(path.join(outputDir, "recipe.json"), JSON.stringify({ method: "usual" }));
            return { stdout: `merged in ${options.cwd}` };
          },
          now: () => new Date("2026-06-02T00:00:00.000Z"),
          randomId: () => "refreshfail",
        }),
      ).rejects.toThrow("server unavailable");

      const jobDir = path.join(jobsRoot, "sbv2-job-20260602000000-refreshf");
      const manifest = JSON.parse(readFileSync(path.join(jobDir, "manifest.json"), "utf8")) as {
        state: string;
        inputSummary: {
          outputAssetsRetained?: boolean;
          refresh?: { baseUrl?: string; refreshed?: boolean; foundInModelsInfo?: boolean; modelsInfoCount?: number };
        };
        artifactPaths: string[];
      };
      expect(manifest.state).toBe("failed");
      expect(manifest.inputSummary.outputAssetsRetained).toBe(true);
      expect(manifest.inputSummary.refresh).toMatchObject({
        baseUrl: "http://localhost:5000",
        refreshed: false,
        foundInModelsInfo: false,
        modelsInfoCount: 0,
      });
      expect(manifest.artifactPaths).toContain(path.join(outputDir, "recipe.json"));
      expect(manifest.artifactPaths).toContain(path.join(outputDir, "merged.safetensors"));

      const summary = JSON.parse(readFileSync(path.join(jobDir, "summary.json"), "utf8")) as {
        state: string;
        candidate?: { modelName?: string };
        outputAssetsRetained?: boolean;
        refresh?: { baseUrl?: string; refreshed?: boolean; foundInModelsInfo?: boolean; modelsInfoCount?: number };
        firstError?: string;
      };
      expect(summary.state).toBe("failed");
      expect(summary.candidate?.modelName).toBe("merged");
      expect(summary.outputAssetsRetained).toBe(true);
      expect(summary.refresh).toMatchObject({
        baseUrl: "http://localhost:5000",
        refreshed: false,
        foundInModelsInfo: false,
        modelsInfoCount: 0,
      });
      expect(summary.firstError).toContain("server unavailable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
