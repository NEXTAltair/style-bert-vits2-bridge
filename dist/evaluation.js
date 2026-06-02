import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { createJobManifest } from "./jobs.js";
import { listModelCandidates } from "./model-registry.js";
import { Sbv2Client } from "./sbv2-client.js";
export const DEFAULT_EVALUATION_TEST_CASES = [
    { id: "ja-short", text: "こんにちは。今日は音声モデルの確認をします。", language: "JP" },
    { id: "ja-long", text: "この文章は少し長めです。息継ぎや語尾の安定感、途中で音が途切れないかを確認します。", language: "JP" },
    { id: "ja-punctuation", text: "ええと、準備はいいですか？ それでは、始めましょう。", language: "JP" },
    { id: "ja-alnum", text: "OpenClaw 2026 と Style-Bert-VITS2 の接続テストです。", language: "JP" },
    { id: "ja-neutral", text: "落ち着いた声で、自然な速さの読み上げをお願いします。", language: "JP" },
];
export async function evaluateModelCandidate(options) {
    const now = options.now ?? (() => new Date());
    const randomId = options.randomId ?? randomUUID;
    const client = options.client ?? new Sbv2Client({ baseUrl: options.baseUrl });
    const [candidate] = await listModelCandidates({
        manifestPath: options.manifestPath,
        sbv2Root: options.sbv2Root,
        modelName: options.modelName,
        sourcePath: options.sourcePath,
    });
    if (!candidate) {
        throw new Error("No SBV2 model candidate was found for evaluation");
    }
    if (!candidate.promotable) {
        throw new Error(`Model candidate is not evaluable: ${candidate.errors.join("; ")}`);
    }
    if (!sameResolvedPath(candidate.sourceDir, candidate.targetDir)) {
        throw new Error("Evaluation can only sample the model currently loadable from SBV2 model_assets. Promote or copy the candidate into model_assets before evaluating it.");
    }
    const testCases = options.testSetPath
        ? await readEvaluationTestSet(resolveUserPath(options.testSetPath))
        : DEFAULT_EVALUATION_TEST_CASES;
    const modelDefaults = await readCandidateVoiceDefaults(candidate);
    const createdAt = now().toISOString();
    const initialJob = await createJobManifest({
        jobsRoot: options.jobsRoot,
        operation: "model-evaluate",
        inputSummary: {
            modelName: candidate.modelName,
            sourceDir: candidate.sourceDir,
            baseUrl: sanitizeBaseUrl(options.baseUrl),
            testCaseCount: testCases.length,
        },
        progressSummary: `Model evaluation started for ${candidate.modelName}.`,
        logLines: [`model evaluation started for ${candidate.modelName}`],
        now,
        randomId,
    });
    const samplesDir = path.join(initialJob.outputDir, "samples");
    await mkdir(samplesDir, { recursive: true });
    const samples = [];
    const logLines = [`model evaluation started for ${candidate.modelName}`];
    for (const [index, testCase] of testCases.entries()) {
        const wavPath = path.join(samplesDir, `${String(index + 1).padStart(3, "0")}-${safeFileName(testCase.id)}.wav`);
        try {
            const audio = await client.synthesize(buildSynthesizeParams(candidate.modelName, modelDefaults, testCase));
            await writeFile(wavPath, audio);
            const check = analyzeWavBuffer(audio);
            samples.push({
                caseId: testCase.id,
                text: testCase.text,
                wavPath,
                ok: check.errors.length === 0,
                check,
                error: null,
            });
            logLines.push(`sample ${testCase.id}: ${check.errors.length ? "failed checks" : "ok"}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            samples.push({
                caseId: testCase.id,
                text: testCase.text,
                wavPath: null,
                ok: false,
                check: null,
                error: message,
            });
            logLines.push(`sample ${testCase.id}: ${message}`);
        }
    }
    const summary = buildEvaluationSummary(candidate, samples, []);
    const evaluation = {
        ...summary,
        createdAt,
        baseUrl: sanitizeBaseUrl(options.baseUrl),
        candidate,
        testCases,
        samples,
        notes: [],
    };
    const evaluationPath = path.join(initialJob.outputDir, "evaluation.json");
    const summaryPath = path.join(initialJob.outputDir, "summary.json");
    await writeEvaluationFiles(evaluationPath, summaryPath, evaluation, summary);
    const artifactPaths = [
        evaluationPath,
        summaryPath,
        ...samples.flatMap((sample) => (sample.wavPath ? [sample.wavPath] : [])),
    ];
    const job = {
        ...initialJob,
        artifactPaths,
        progressSummary: `Model evaluation completed for ${candidate.modelName}: ${summary.recommendation}.`,
    };
    await writeFile(path.join(initialJob.outputDir, "manifest.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await writeFile(initialJob.logPath, [
        `[${initialJob.startedAt ?? createdAt}] model-evaluate job started`,
        ...logLines.map((line) => `[${initialJob.finishedAt ?? createdAt}] ${line}`),
        `[${initialJob.finishedAt ?? createdAt}] model-evaluate job succeeded`,
        "",
    ].join("\n"), "utf8");
    return { evaluation, summary, job };
}
export async function readEvaluationManifest(evaluationPath) {
    const parsed = JSON.parse(await readFile(resolveUserPath(evaluationPath), "utf8"));
    if (!isEvaluationManifest(parsed)) {
        throw new Error(`Invalid SBV2 evaluation manifest: ${evaluationPath}`);
    }
    return parsed;
}
export async function updateEvaluationNote(options) {
    const evaluationPath = resolveUserPath(options.evaluationPath);
    const evaluation = await readEvaluationManifest(evaluationPath);
    if (!evaluation.samples.some((sample) => sample.caseId === options.caseId)) {
        throw new Error(`Evaluation case was not found: ${options.caseId}`);
    }
    const note = options.note.trim();
    if (!note) {
        throw new Error("--note must be a non-empty string");
    }
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const notes = [
        ...evaluation.notes.filter((entry) => entry.caseId !== options.caseId),
        {
            caseId: options.caseId,
            decision: options.decision,
            note,
            createdAt,
        },
    ];
    const summary = buildEvaluationSummary(evaluation.candidate, evaluation.samples, notes);
    const updated = {
        ...evaluation,
        ...summary,
        notes,
    };
    await writeFile(evaluationPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    const summaryPath = path.join(path.dirname(evaluationPath), "summary.json");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return updated;
}
export function buildEvaluationSummary(candidate, samples, notes) {
    const failureCount = samples.filter((sample) => !sample.ok).length;
    const warningCount = samples.reduce((total, sample) => total + (sample.check?.warnings.length ?? 0), 0);
    const explicitReject = notes.some((note) => note.decision === "reject");
    const explicitAdopt = notes.some((note) => note.decision === "adopt");
    const explicitHold = notes.some((note) => note.decision === "hold");
    const rationale = [];
    let recommendation;
    if (failureCount === samples.length || explicitReject) {
        recommendation = "reject";
        rationale.push(explicitReject ? "A human listening note rejected at least one sample." : "All generated samples failed.");
    }
    else if (failureCount > 0 || warningCount > 0 || explicitHold) {
        recommendation = "hold";
        if (failureCount > 0)
            rationale.push(`${failureCount} sample(s) failed generation or WAV checks.`);
        if (warningCount > 0)
            rationale.push(`${warningCount} mechanical warning(s) need review.`);
        if (explicitHold)
            rationale.push("A human listening note marked at least one sample as hold.");
    }
    else {
        recommendation = "adopt_candidate";
        rationale.push("All generated samples passed mechanical WAV checks.");
    }
    if (explicitAdopt && !explicitHold && recommendation !== "reject" && failureCount === 0 && warningCount === 0) {
        recommendation = "adopt_candidate";
        rationale.push("A human listening note marked at least one sample as adopt.");
    }
    const decision = explicitReject
        ? "reject"
        : explicitHold
            ? "hold"
            : explicitAdopt
                ? "adopt"
                : null;
    return {
        schemaVersion: 1,
        modelName: candidate.modelName,
        sourceDir: candidate.sourceDir,
        sampleCount: samples.length,
        successCount: samples.length - failureCount,
        failureCount,
        warningCount,
        recommendation,
        rationale,
        decision,
    };
}
export function analyzeWavBuffer(buffer) {
    const warnings = [];
    const errors = [];
    if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
        return {
            validWav: false,
            sizeBytes: buffer.length,
            warnings,
            errors: [`audio is not a valid RIFF/WAVE file (${buffer.length} bytes)`],
        };
    }
    const fmt = findWavChunk(buffer, "fmt ");
    const data = findWavChunk(buffer, "data");
    if (!fmt || fmt.size < 16)
        errors.push("WAV fmt chunk is missing or too small");
    if (!data || data.size <= 0)
        errors.push("WAV data chunk is missing or empty");
    const channels = fmt ? buffer.readUInt16LE(fmt.offset + 2) : undefined;
    const sampleRate = fmt ? buffer.readUInt32LE(fmt.offset + 4) : undefined;
    const bitsPerSample = fmt ? buffer.readUInt16LE(fmt.offset + 14) : undefined;
    const bytesPerSecond = sampleRate && channels && bitsPerSample ? sampleRate * channels * (bitsPerSample / 8) : undefined;
    const durationSec = data && bytesPerSecond ? data.size / bytesPerSecond : undefined;
    if (durationSec !== undefined && durationSec < 0.15)
        warnings.push("WAV duration is very short");
    let nearZeroRatio;
    if (data && data.size > 0) {
        const payload = buffer.subarray(data.offset, data.offset + data.size);
        nearZeroRatio = calculateNearZeroRatio(payload, bitsPerSample);
        if (nearZeroRatio > 0.98)
            warnings.push("WAV appears mostly silent");
    }
    return {
        validWav: errors.length === 0,
        sizeBytes: buffer.length,
        durationSec,
        sampleRate,
        channels,
        bitsPerSample,
        dataBytes: data?.size,
        nearZeroRatio,
        warnings,
        errors,
    };
}
async function readEvaluationTestSet(filePath) {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.length) {
        throw new Error("Evaluation test set must be a non-empty JSON array");
    }
    return parsed.map((item, index) => {
        if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
            throw new Error(`Evaluation test case at index ${index} must include text`);
        }
        const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `case-${index + 1}`;
        const language = item.language === "JP" || item.language === "EN" || item.language === "ZH" ? item.language : undefined;
        return {
            id,
            text: item.text.trim(),
            ...(language ? { language } : {}),
            ...(typeof item.speakerName === "string" && item.speakerName.trim() ? { speakerName: item.speakerName.trim() } : {}),
            ...(typeof item.style === "string" && item.style.trim() ? { style: item.style.trim() } : {}),
            ...(typeof item.styleWeight === "number" && Number.isFinite(item.styleWeight) ? { styleWeight: item.styleWeight } : {}),
            ...(typeof item.length === "number" && Number.isFinite(item.length) ? { length: item.length } : {}),
        };
    });
}
async function readCandidateVoiceDefaults(candidate) {
    try {
        const config = JSON.parse(await readFile(candidate.configJsonPath, "utf8"));
        if (!isRecord(config) || !isRecord(config.data))
            return {};
        return {
            speakerName: firstObjectKey(config.data.spk2id) ?? candidate.modelName,
            style: firstPreferredStyle(config.data.style2id),
        };
    }
    catch {
        return { speakerName: candidate.modelName };
    }
}
function buildSynthesizeParams(modelName, defaults, testCase) {
    return {
        text: testCase.text,
        modelName,
        speakerName: testCase.speakerName ?? defaults.speakerName,
        style: testCase.style ?? defaults.style,
        styleWeight: testCase.styleWeight,
        length: testCase.length,
        language: testCase.language,
    };
}
async function writeEvaluationFiles(evaluationPath, summaryPath, evaluation, summary) {
    await writeFile(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`, "utf8");
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
function findWavChunk(buffer, id) {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString("ascii", offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const dataOffset = offset + 8;
        if (dataOffset + size > buffer.length)
            return undefined;
        if (chunkId === id)
            return { offset: dataOffset, size };
        offset = dataOffset + size + (size % 2);
    }
    return undefined;
}
function calculateNearZeroRatio(payload, bitsPerSample) {
    if (bitsPerSample === 16 && payload.length >= 2) {
        let nearZero = 0;
        let total = 0;
        for (let offset = 0; offset + 1 < payload.length; offset += 2) {
            total += 1;
            if (Math.abs(payload.readInt16LE(offset)) <= 128)
                nearZero += 1;
        }
        return total ? nearZero / total : 1;
    }
    let nearZero = 0;
    for (const value of payload) {
        if (value >= 126 && value <= 130)
            nearZero += 1;
    }
    return payload.length ? nearZero / payload.length : 1;
}
function firstObjectKey(value) {
    if (!isRecord(value))
        return undefined;
    return Object.keys(value).find((key) => key.trim());
}
function firstPreferredStyle(value) {
    if (!isRecord(value))
        return undefined;
    const keys = Object.keys(value);
    return keys.find((key) => key === "Neutral" || key === "00_Neutral") ?? keys[0];
}
function safeFileName(value) {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+$/, "case");
}
function sanitizeBaseUrl(value) {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return "<invalid baseUrl>";
    }
}
function sameResolvedPath(left, right) {
    return path.resolve(left) === path.resolve(right);
}
function resolveUserPath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return path.join(homedir(), value.slice(2));
    return path.resolve(value);
}
function isEvaluationManifest(value) {
    return (isRecord(value) &&
        value.schemaVersion === 1 &&
        typeof value.modelName === "string" &&
        typeof value.sourceDir === "string" &&
        Array.isArray(value.samples) &&
        Array.isArray(value.notes) &&
        typeof value.recommendation === "string");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
