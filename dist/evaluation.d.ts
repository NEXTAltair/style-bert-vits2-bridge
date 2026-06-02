import { type Sbv2JobManifest } from "./jobs.js";
import { type Sbv2ModelCandidate } from "./model-registry.js";
import { Sbv2Client } from "./sbv2-client.js";
export type Sbv2EvaluationDecision = "adopt" | "hold" | "reject";
export type Sbv2EvaluationRecommendation = "adopt_candidate" | "hold" | "reject";
export interface Sbv2EvaluationTestCase {
    id: string;
    text: string;
    language?: "JP" | "EN" | "ZH";
    speakerName?: string;
    style?: string;
    styleWeight?: number;
    length?: number;
}
export interface Sbv2EvaluationAudioCheck {
    validWav: boolean;
    sizeBytes: number;
    durationSec?: number;
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    dataBytes?: number;
    nearZeroRatio?: number;
    warnings: string[];
    errors: string[];
}
export interface Sbv2EvaluationSampleResult {
    caseId: string;
    text: string;
    wavPath: string | null;
    ok: boolean;
    check: Sbv2EvaluationAudioCheck | null;
    error: string | null;
}
export interface Sbv2EvaluationHumanNote {
    caseId: string;
    decision: Sbv2EvaluationDecision;
    note: string;
    createdAt: string;
}
export interface Sbv2EvaluationSummary {
    schemaVersion: 1;
    modelName: string;
    sourceDir: string;
    sampleCount: number;
    successCount: number;
    failureCount: number;
    warningCount: number;
    recommendation: Sbv2EvaluationRecommendation;
    rationale: string[];
    decision: Sbv2EvaluationDecision | null;
}
export interface Sbv2EvaluationManifest extends Sbv2EvaluationSummary {
    createdAt: string;
    baseUrl: string;
    candidate: Sbv2ModelCandidate;
    testCases: Sbv2EvaluationTestCase[];
    samples: Sbv2EvaluationSampleResult[];
    notes: Sbv2EvaluationHumanNote[];
}
export interface EvaluateModelOptions {
    jobsRoot?: string;
    manifestPath?: string;
    sbv2Root?: string;
    modelName?: string;
    sourcePath?: string;
    baseUrl: string;
    testSetPath?: string;
    client?: Pick<Sbv2Client, "synthesize">;
    now?: () => Date;
    randomId?: () => string;
}
export interface EvaluationNoteOptions {
    evaluationPath: string;
    caseId: string;
    decision: Sbv2EvaluationDecision;
    note: string;
    now?: () => Date;
}
export interface EvaluationResult {
    evaluation: Sbv2EvaluationManifest;
    summary: Sbv2EvaluationSummary;
    job: Sbv2JobManifest;
}
export declare const DEFAULT_EVALUATION_TEST_CASES: Sbv2EvaluationTestCase[];
export declare function evaluateModelCandidate(options: EvaluateModelOptions): Promise<EvaluationResult>;
export declare function readEvaluationManifest(evaluationPath: string): Promise<Sbv2EvaluationManifest>;
export declare function updateEvaluationNote(options: EvaluationNoteOptions): Promise<Sbv2EvaluationManifest>;
export declare function buildEvaluationSummary(candidate: Sbv2ModelCandidate, samples: Sbv2EvaluationSampleResult[], notes: Sbv2EvaluationHumanNote[]): Sbv2EvaluationSummary;
export declare function analyzeWavBuffer(buffer: Buffer): Sbv2EvaluationAudioCheck;
