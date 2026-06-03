import { type Sbv2JobManifest } from "./jobs.js";
export declare const DEFAULT_DATASETS_ROOT = "~/.openclaw/state/style-bert-vits2-bridge/datasets";
export declare const DEFAULT_SBV2_ROOT = "~/src/Style-Bert-VITS2";
export declare const DEFAULT_TRANSCRIPTION_BACKEND = "hf-whisper";
export declare const DEFAULT_TRANSCRIPTION_MODEL = "litagin/anime-whisper";
export declare const DEFAULT_TRANSCRIPTION_BATCH_SIZE = 16;
export declare const DEFAULT_YOMI_ERROR = "skip";
export declare const DEFAULT_NOT_USE_CUSTOM_BATCH_SAMPLER = false;
export declare const DEFAULT_SLICE_MIN_SEC = 2;
export declare const DEFAULT_SLICE_MAX_SEC = 12;
export declare const DEFAULT_SLICE_MIN_SILENCE_DUR_MS = 700;
export declare const DEFAULT_SLICE_NUM_PROCESSES = 3;
export declare const DEFAULT_TRANSCRIPTION_FASTER_WHISPER_MODEL = "large-v3";
export declare const DEFAULT_TRANSCRIPTION_COMPUTE_TYPE = "bfloat16";
export declare const DEFAULT_TRANSCRIPTION_NUM_BEAMS = 1;
export declare const DEFAULT_TRANSCRIPTION_INITIAL_PROMPT = "";
export type Sbv2DatasetLanguage = "ja" | "en" | "zh";
export type Sbv2DatasetStyleMode = "neutral" | "directory";
export interface Sbv2AudioProbe {
    durationSec?: number;
    codec?: string;
    sampleRate?: number;
    warning?: string;
}
export interface Sbv2DatasetFile {
    originalPath: string;
    storedPath: string;
    relativePath: string;
    sizeBytes: number;
    sha256: string;
    extension: string;
    durationSec?: number;
    codec?: string;
    sampleRate?: number;
    probeWarning?: string;
}
export interface Sbv2DatasetStyleGroup {
    styleName: string;
    relativeDir: string;
    fileCount: number;
    files: string[];
}
export interface Sbv2DatasetSliceOptions {
    minSec: number;
    maxSec: number;
    minSilenceDurMs: number;
    numProcesses: number;
}
export interface Sbv2DatasetManifest {
    schemaVersion: 1;
    workspaceId: string;
    modelName: string;
    language: Sbv2DatasetLanguage;
    useJpExtra: boolean;
    createdAt: string;
    sourceAudioPath: string;
    workspaceDir: string;
    originalsDir: string;
    manifestPath: string;
    sbv2Root: string;
    datasetPath: string;
    assetsPath: string;
    productionDefaults: {
        transcriptionBackend: typeof DEFAULT_TRANSCRIPTION_BACKEND;
        transcriptionModel: typeof DEFAULT_TRANSCRIPTION_MODEL;
        transcriptionBatchSize: typeof DEFAULT_TRANSCRIPTION_BATCH_SIZE;
        yomiError: typeof DEFAULT_YOMI_ERROR;
        notUseCustomBatchSampler: typeof DEFAULT_NOT_USE_CUSTOM_BATCH_SAMPLER;
        initialPrompt: null;
        sliceOptions: "SBV2 default";
        preprocessOptions: "SBV2 GUI/default";
    };
    styleMode: Sbv2DatasetStyleMode;
    styleGroups: Sbv2DatasetStyleGroup[];
    files: Sbv2DatasetFile[];
    warnings: string[];
}
export interface IngestDatasetOptions {
    datasetsRoot?: string;
    jobsRoot?: string;
    sbv2Root?: string;
    modelName: string;
    sourceAudioPath: string;
    language: Sbv2DatasetLanguage;
    useJpExtra: boolean;
    now?: () => Date;
    randomId?: () => string;
    probeAudio?: (filePath: string) => Promise<Sbv2AudioProbe>;
}
export interface IngestDatasetResult {
    dataset: Sbv2DatasetManifest;
    job: Sbv2JobManifest;
}
export interface Sbv2DatasetPrepareSummary {
    schemaVersion: 1;
    workspaceId: string;
    modelName: string;
    rawDir: string;
    esdListPath: string;
    rawWavCount: number;
    esdLineCount: number;
    sliceOptions: Sbv2DatasetSliceOptions;
    styleGroups: Sbv2DatasetStyleGroup[];
    missingAudioReferences: string[];
    untranscribedWavs: string[];
    warnings: string[];
    commands: {
        executable: string;
        args: string[];
        cwd: string;
    }[];
}
export interface PrepareDatasetCommandResult {
    stdout?: string;
    stderr?: string;
}
export interface PrepareDatasetCommandOptions {
    cwd: string;
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
export type PrepareDatasetCommandRunner = (executable: string, args: string[], options: PrepareDatasetCommandOptions) => Promise<PrepareDatasetCommandResult>;
export interface PrepareDatasetOptions {
    manifestPath: string;
    jobsRoot?: string;
    sliceOptions?: Partial<Sbv2DatasetSliceOptions>;
    commandRunner?: PrepareDatasetCommandRunner;
    now?: () => Date;
    randomId?: () => string;
}
export interface PrepareDatasetResult {
    dataset: Sbv2DatasetManifest;
    summary: Sbv2DatasetPrepareSummary;
    job: Sbv2JobManifest;
}
export declare function resolveDatasetsRoot(value: string | undefined): string;
export declare function resolveSbv2Root(value: string | undefined): string;
export declare function ingestDataset(options: IngestDatasetOptions): Promise<IngestDatasetResult>;
export declare function readDatasetManifest(filePath: string): Promise<Sbv2DatasetManifest>;
export declare function prepareDataset(options: PrepareDatasetOptions): Promise<PrepareDatasetResult>;
