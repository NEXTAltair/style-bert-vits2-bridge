import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeWavBuffer,
  evaluateModelCandidate,
  updateEvaluationNote,
} from "./evaluation.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createSbv2Root(modelName = "eval-voice", styleName = "Neutral"): string {
  const sbv2Root = tempRoot("sbv2-eval-root-");
  const modelDir = path.join(sbv2Root, "model_assets", modelName);
  mkdirSync(path.join(sbv2Root, "configs"), { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(path.join(sbv2Root, "configs", "paths.yml"), "assets_root: model_assets\n");
  writeModelAssets(modelDir, modelName, styleName);
  return sbv2Root;
}

function writeModelAssets(dir: string, modelName: string, styleName = "Neutral"): void {
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      model_name: modelName,
      model: {},
      train: {},
      data: {
        n_speakers: 1,
        num_styles: 1,
        spk2id: { [modelName]: 0 },
        style2id: { [styleName]: 0 },
      },
    }),
  );
  writeFileSync(path.join(dir, "style_vectors.npy"), makeNpy([1, 2]));
  writeFileSync(path.join(dir, `${modelName}_e1_s100.safetensors`), makeSafetensors());
}

function makeNpy(shape: number[]): Buffer {
  const shapeText = shape.length === 1 ? `${shape[0]},` : shape.join(", ");
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shapeText}), }`;
  const magicLength = 10;
  const padding = 16 - ((magicLength + header.length + 1) % 16);
  const paddedHeader = `${header}${" ".repeat(padding)}\n`;
  const result = Buffer.alloc(magicLength + paddedHeader.length + shape.reduce((total, value) => total * value, 1) * 4);
  result.write("\x93NUMPY", 0, "latin1");
  result[6] = 1;
  result[7] = 0;
  result.writeUInt16LE(paddedHeader.length, 8);
  result.write(paddedHeader, magicLength, "latin1");
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

function makeWav(samples = 3200, value = 1000): Buffer {
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let offset = 44; offset + 1 < buffer.length; offset += 2) {
    buffer.writeInt16LE(value, offset);
  }
  return buffer;
}

describe("SBV2 model evaluation", () => {
  it("generates sample WAVs, an evaluation manifest, and a model-evaluate job", async () => {
    const sbv2Root = createSbv2Root();
    const jobsRoot = tempRoot("sbv2-eval-jobs-");
    const calls: unknown[] = [];

    const result = await evaluateModelCandidate({
      jobsRoot,
      sbv2Root,
      modelName: "eval-voice",
      baseUrl: "http://user:secret@localhost:5000?token=hidden",
      client: {
        synthesize: async (params) => {
          calls.push(params);
          return makeWav();
        },
      },
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "abcdef123456",
    });

    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatchObject({
      modelName: "eval-voice",
      speakerName: "eval-voice",
      style: "Neutral",
    });
    expect(result.summary).toMatchObject({
      modelName: "eval-voice",
      successCount: 5,
      failureCount: 0,
      recommendation: "adopt_candidate",
    });
    expect(result.job).toMatchObject({
      jobId: "sbv2-job-20260602000000-abcdef12",
      operation: "model-evaluate",
    });
    expect(result.evaluation.baseUrl).toBe("http://localhost:5000");
    expect(result.job.artifactPaths.some((entry) => entry.endsWith("evaluation.json"))).toBe(true);
    expect(readFileSync(path.join(result.job.outputDir, "summary.json"), "utf8")).toContain("adopt_candidate");
  });

  it("records failed sample generation without dropping successful samples", async () => {
    const sbv2Root = createSbv2Root();
    let count = 0;
    const result = await evaluateModelCandidate({
      jobsRoot: tempRoot("sbv2-eval-jobs-"),
      sbv2Root,
      modelName: "eval-voice",
      baseUrl: "http://localhost:5000",
      client: {
        synthesize: async () => {
          count += 1;
          if (count === 2) throw new Error("sample failed");
          return makeWav();
        },
      },
    });

    expect(result.summary).toMatchObject({
      successCount: 4,
      failureCount: 1,
      recommendation: "hold",
    });
    expect(result.evaluation.samples[1]).toMatchObject({
      ok: false,
      error: "sample failed",
      wavPath: null,
    });
  });

  it("uses the detected neutral style for every built-in case", async () => {
    const sbv2Root = createSbv2Root("eval-voice", "00_Neutral");
    const calls: Array<{ style?: string }> = [];

    await evaluateModelCandidate({
      jobsRoot: tempRoot("sbv2-eval-jobs-"),
      sbv2Root,
      modelName: "eval-voice",
      baseUrl: "http://localhost:5000",
      client: {
        synthesize: async (params) => {
          calls.push(params);
          return makeWav();
        },
      },
    });

    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.style === "00_Neutral")).toBe(true);
  });

  it("uses stable unique sample filenames for colliding test case ids", async () => {
    const sbv2Root = createSbv2Root();
    const testSetPath = path.join(tempRoot("sbv2-eval-test-set-"), "test-set.json");
    writeFileSync(
      testSetPath,
      JSON.stringify([
        { id: "a/b", text: "ひとつめ" },
        { id: "a_b", text: "ふたつめ" },
      ]),
    );

    const result = await evaluateModelCandidate({
      jobsRoot: tempRoot("sbv2-eval-jobs-"),
      sbv2Root,
      modelName: "eval-voice",
      baseUrl: "http://localhost:5000",
      testSetPath,
      client: { synthesize: async () => makeWav() },
    });

    expect(result.evaluation.samples.map((sample) => path.basename(sample.wavPath ?? ""))).toEqual([
      "001-a_b.wav",
      "002-a_b.wav",
    ]);
  });

  it("rejects evaluation of external candidate sources that SBV2 cannot sample directly", async () => {
    const sbv2Root = createSbv2Root();
    const source = tempRoot("sbv2-eval-external-");
    writeModelAssets(source, "eval-voice");

    await expect(
      evaluateModelCandidate({
        jobsRoot: tempRoot("sbv2-eval-jobs-"),
        sbv2Root,
        modelName: "eval-voice",
        sourcePath: source,
        baseUrl: "http://localhost:5000",
        client: { synthesize: async () => makeWav() },
      }),
    ).rejects.toThrow("Evaluation can only sample the model currently loadable");
  });

  it("updates listening notes and turns explicit rejection into a reject recommendation", async () => {
    const sbv2Root = createSbv2Root();
    const result = await evaluateModelCandidate({
      jobsRoot: tempRoot("sbv2-eval-jobs-"),
      sbv2Root,
      modelName: "eval-voice",
      baseUrl: "http://localhost:5000",
      client: { synthesize: async () => makeWav() },
    });
    const evaluationPath = path.join(result.job.outputDir, "evaluation.json");

    const updated = await updateEvaluationNote({
      evaluationPath,
      caseId: "ja-short",
      decision: "reject",
      note: "noisy pronunciation",
      now: () => new Date("2026-06-02T01:00:00.000Z"),
    });

    expect(updated).toMatchObject({
      decision: "reject",
      recommendation: "reject",
    });
    expect(updated.notes).toEqual([
      {
        caseId: "ja-short",
        decision: "reject",
        note: "noisy pronunciation",
        createdAt: "2026-06-02T01:00:00.000Z",
      },
    ]);
  });

  it("keeps hold recommendation when adopt and hold notes are mixed", async () => {
    const sbv2Root = createSbv2Root();
    const result = await evaluateModelCandidate({
      jobsRoot: tempRoot("sbv2-eval-jobs-"),
      sbv2Root,
      modelName: "eval-voice",
      baseUrl: "http://localhost:5000",
      client: { synthesize: async () => makeWav() },
    });
    const evaluationPath = path.join(result.job.outputDir, "evaluation.json");

    await updateEvaluationNote({
      evaluationPath,
      caseId: "ja-short",
      decision: "hold",
      note: "needs another listen",
    });
    const updated = await updateEvaluationNote({
      evaluationPath,
      caseId: "ja-long",
      decision: "adopt",
      note: "sounds good",
    });

    expect(updated).toMatchObject({
      decision: "hold",
      recommendation: "hold",
    });
  });

  it("flags non-WAV and silent-looking WAV buffers", () => {
    expect(analyzeWavBuffer(Buffer.from("not wav")).errors[0]).toContain("not a valid RIFF/WAVE");

    const silent = analyzeWavBuffer(makeWav(1600, 0));
    expect(silent.validWav).toBe(true);
    expect(silent.warnings).toContain("WAV appears mostly silent");
  });
});
