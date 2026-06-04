import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStyleMergePlan, runStyleMerge } from "./style-merge.js";

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
        style2id: styles,
      },
    })}\n`,
  );
  writeFileSync(path.join(modelDir, "style_vectors.npy"), makeNpy(values));
  writeFileSync(path.join(modelDir, `${modelName}.safetensors`), makeSafetensors());
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
  const rowCount = rows.length;
  const width = rows[0]?.length ?? 0;
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rowCount}, ${width}), }`;
  const magicLength = 10;
  const padding = 16 - ((magicLength + header.length + 1) % 16);
  const paddedHeader = `${header}${" ".repeat(padding)}\n`;
  const result = Buffer.alloc(magicLength + paddedHeader.length + rowCount * width * 4);
  result.write("\x93NUMPY", 0, "latin1");
  result[6] = 1;
  result[7] = 0;
  result.writeUInt16LE(paddedHeader.length, 8);
  result.write(paddedHeader, magicLength, "latin1");
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      result.writeFloatLE(value, magicLength + paddedHeader.length + (rowIndex * width + columnIndex) * 4);
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
      data: { num_styles: number; style2id: Record<string, number>; spk2id: Record<string, number> };
    };
    expect(config.model_name).toBe("merged");
    expect(config.data.num_styles).toBe(2);
    expect(config.data.style2id).toEqual({ Neutral: 0, Happy: 1 });
    expect(config.data.spk2id).toEqual({ merged: 0 });
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
});
