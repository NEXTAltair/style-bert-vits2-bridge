import { type Sbv2JobManifest } from "./jobs.js";
import { type Sbv2DatasetManifest } from "./datasets.js";
export type Sbv2TrainingStage = "initialize" | "resample" | "preprocess-text" | "bert-gen" | "style-gen" | "train";
export declare const DEFAULT_TRAINING_STAGES: Sbv2TrainingStage[];
export interface Sbv2TrainingSettings {
    batchSize: number;
    epochs: number;
    saveEverySteps: number;
    logInterval: number;
    normalize: boolean;
    trim: boolean;
    numProcesses: number;
    valPerLang: number;
    yomiError: "raise" | "skip" | "use";
    skipDefaultStyle: boolean;
    speedup: boolean;
    notUseCustomBatchSampler: boolean;
    freezeEnBert: boolean;
    freezeJpBert: boolean;
    freezeZhBert: boolean;
    freezeStyle: boolean;
    freezeDecoder: boolean;
}
export interface Sbv2TrainingCommand {
    stage: Sbv2TrainingStage;
    executable: string;
    args: string[];
    cwd: string;
}
export interface Sbv2TrainingPlan {
    schemaVersion: 1;
    workspaceId: string;
    modelName: string;
    useJpExtra: boolean;
    sbv2Root: string;
    datasetPath: string;
    assetsPath: string;
    stages: Sbv2TrainingStage[];
    settings: Sbv2TrainingSettings;
    expectedOutputs: {
        rawDir: string;
        esdListPath: string;
        wavsDir: string;
        trainListPath: string;
        valListPath: string;
        configJsonPath: string;
        modelsDir: string;
        assetsPath: string;
    };
    commands: Sbv2TrainingCommand[];
    warnings: string[];
}
export interface TrainingCommandResult {
    stdout?: string;
    stderr?: string;
}
export interface TrainingCommandOptions {
    cwd: string;
    stage: Sbv2TrainingStage;
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
export type TrainingCommandRunner = (executable: string, args: string[], options: TrainingCommandOptions) => Promise<TrainingCommandResult>;
export interface TrainingPlanOptions {
    manifestPath: string;
    stages?: Sbv2TrainingStage[];
    settings?: Partial<Sbv2TrainingSettings>;
}
export interface TrainingRunOptions extends TrainingPlanOptions {
    jobsRoot?: string;
    commandRunner?: TrainingCommandRunner;
    now?: () => Date;
    randomId?: () => string;
}
export interface TrainingRunResult {
    dataset: Sbv2DatasetManifest;
    plan: Sbv2TrainingPlan;
    job: Sbv2JobManifest;
}
export declare function createTrainingPlan(options: TrainingPlanOptions): Promise<{
    dataset: Sbv2DatasetManifest;
    plan: Sbv2TrainingPlan;
}>;
export declare function runTraining(options: TrainingRunOptions): Promise<TrainingRunResult>;
export declare function parseTrainingStage(value: string): Sbv2TrainingStage;
