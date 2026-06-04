import { type Sbv2JobManifest } from "./jobs.js";
import { type Sbv2ModelCandidate } from "./model-registry.js";
export type Sbv2ModelMergeMethod = "usual" | "add-diff" | "weighted-sum" | "add-null";
export interface Sbv2ModelMergeWeights {
    voiceWeight: number;
    voicePitchWeight: number;
    speechStyleWeight: number;
    tempoWeight: number;
}
export interface Sbv2WeightedSumCoefficients {
    modelACoeff: number;
    modelBCoeff: number;
    modelCCoeff: number;
}
export interface Sbv2ModelMergeInput {
    modelName: string;
    modelDir: string;
    safetensorsPath: string;
    configJsonPath: string;
    styleVectorsPath: string;
    speakerCount: number;
    styleVectorShape: number[];
    safetensorsTensors: Record<string, {
        dtype?: string;
        shape: number[];
    }>;
}
export interface Sbv2ModelMergeCommand {
    executable: string;
    args: string[];
    cwd: string;
}
export interface Sbv2ModelMergeCompatibilityReport {
    compatible: boolean;
    errors: string[];
    warnings: string[];
}
export interface Sbv2ModelMergePlan {
    schemaVersion: 1;
    method: Sbv2ModelMergeMethod;
    sbv2Root: string;
    assetsRoot: string;
    outputModelName: string;
    outputDir: string;
    outputSafetensorsPath: string;
    inputModels: {
        a: Sbv2ModelMergeInput;
        b: Sbv2ModelMergeInput;
        c?: Sbv2ModelMergeInput;
    };
    weights?: Sbv2ModelMergeWeights;
    coefficients?: Sbv2WeightedSumCoefficients;
    slerp: boolean;
    compatibility: Sbv2ModelMergeCompatibilityReport;
    command: Sbv2ModelMergeCommand;
    expectedArtifacts: string[];
}
export interface ModelMergePlanOptions {
    sbv2Root?: string;
    method: Sbv2ModelMergeMethod;
    outputModelName: string;
    modelA: string;
    modelAFile?: string;
    modelB: string;
    modelBFile?: string;
    modelC?: string;
    modelCFile?: string;
    weights?: Partial<Sbv2ModelMergeWeights>;
    coefficients?: Partial<Sbv2WeightedSumCoefficients>;
    slerp?: boolean;
}
export interface ModelMergeRunOptions extends ModelMergePlanOptions {
    jobsRoot?: string;
    confirmOutputModelName: string;
    baseUrl?: string;
    commandRunner?: ModelMergeCommandRunner;
    now?: () => Date;
    randomId?: () => string;
}
export interface ModelMergeCommandResult {
    stdout?: string;
    stderr?: string;
}
export interface ModelMergeCommandOptions {
    cwd: string;
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
export type ModelMergeCommandRunner = (executable: string, args: string[], options: ModelMergeCommandOptions) => Promise<ModelMergeCommandResult>;
export interface Sbv2ModelMergeSummary {
    schemaVersion: 1;
    method: Sbv2ModelMergeMethod;
    outputModelName: string;
    outputDir: string;
    recipePath: string;
    plan: Sbv2ModelMergePlan;
    candidate: Sbv2ModelCandidate;
    refresh?: {
        baseUrl: string;
        refreshed: boolean;
        foundInModelsInfo: boolean;
        modelsInfoCount: number;
        outputAssetsRetained: boolean;
    };
    nextSteps: string[];
}
export interface Sbv2ModelMergeInputSummary {
    modelName: string;
    modelDir: string;
    safetensorsPath: string;
    configJsonPath: string;
    styleVectorsPath: string;
    speakerCount: number;
    styleVectorShape: number[];
}
export interface Sbv2ModelMergePlanSummary {
    schemaVersion: 1;
    method: Sbv2ModelMergeMethod;
    outputModelName: string;
    outputDir: string;
    outputSafetensorsPath: string;
    recipePath: string;
    inputModels: {
        a: Sbv2ModelMergeInputSummary;
        b: Sbv2ModelMergeInputSummary;
        c?: Sbv2ModelMergeInputSummary;
    };
    weights?: Sbv2ModelMergeWeights;
    coefficients?: Sbv2WeightedSumCoefficients;
    slerp: boolean;
    compatibility: Sbv2ModelMergeCompatibilityReport;
    expectedArtifacts: string[];
}
export interface Sbv2ModelMergeCandidateSummary {
    candidateId: string;
    modelName: string;
    sourceDir: string;
    targetDir: string;
    configJsonPath: string;
    styleVectorsPath: string;
    safetensorsPaths: string[];
    promotable: boolean;
    errors: string[];
    warnings: string[];
}
export interface Sbv2ModelMergeRunSummary extends Sbv2ModelMergePlanSummary {
    candidate: Sbv2ModelMergeCandidateSummary;
    refresh?: Sbv2ModelMergeSummary["refresh"];
    nextSteps: string[];
}
export interface ModelMergeRunResult {
    plan: Sbv2ModelMergePlan;
    candidate: Sbv2ModelCandidate;
    summary: Sbv2ModelMergeSummary;
    job: Sbv2JobManifest;
}
export declare function parseModelMergeMethod(value: string): Sbv2ModelMergeMethod;
export declare function createModelMergePlan(options: ModelMergePlanOptions): Promise<Sbv2ModelMergePlan>;
export declare function runModelMerge(options: ModelMergeRunOptions): Promise<ModelMergeRunResult>;
export declare function summarizeModelMergePlan(plan: Sbv2ModelMergePlan): Sbv2ModelMergePlanSummary;
export declare function summarizeModelMergeRun(result: ModelMergeRunResult): Sbv2ModelMergeRunSummary;
