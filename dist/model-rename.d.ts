import { type Sbv2JobManifest } from "./jobs.js";
export interface ModelRenameOptions {
    sbv2Root?: string;
    fromModelName: string;
    toModelName: string;
    includeData?: boolean;
    renameEsdSpeaker?: boolean;
}
export interface ModelRenameRunOptions extends ModelRenameOptions {
    jobsRoot?: string;
    confirmToModelName: string;
    baseUrl?: string;
    now?: () => Date;
    randomId?: () => string;
}
export interface Sbv2ModelRenameChange {
    kind: "path-move" | "json-field" | "esd-speaker";
    path?: string;
    from: string;
    to: string;
    jsonPath?: string;
    lineCount?: number;
}
export interface Sbv2ModelRenameCompatibilityReport {
    compatible: boolean;
    errors: string[];
    warnings: string[];
}
export interface Sbv2ModelRenamePlan {
    schemaVersion: 1;
    sbv2Root: string;
    assetsRoot: string;
    datasetRoot: string;
    fromModelName: string;
    toModelName: string;
    sourceAssetsDir: string;
    targetAssetsDir: string;
    sourceDataDir: string;
    targetDataDir: string;
    includeData: boolean;
    renameEsdSpeaker: boolean;
    configJsonPath: string;
    targetConfigJsonPath: string;
    styleVectorsPath: string;
    safetensorsKept: string[];
    changes: Sbv2ModelRenameChange[];
    compatibility: Sbv2ModelRenameCompatibilityReport;
}
export interface Sbv2ModelRenameSummary {
    schemaVersion: 1;
    fromModelName: string;
    toModelName: string;
    sourceAssetsDir: string;
    targetAssetsDir: string;
    sourceDataDir: string;
    targetDataDir: string;
    plan: Sbv2ModelRenamePlan;
    changesApplied: Sbv2ModelRenameChange[];
    outputAssetsRetained: boolean;
    rollbackWarnings: string[];
    refresh?: {
        baseUrl: string;
        refreshed: boolean;
        foundNewInModelsInfo: boolean;
        foundOldInModelsInfo: boolean;
        modelsInfoCount: number;
        outputAssetsRetained: boolean;
    };
    nextSteps: string[];
}
export interface ModelRenameRunResult {
    plan: Sbv2ModelRenamePlan;
    summary: Sbv2ModelRenameSummary;
    job: Sbv2JobManifest;
}
export declare function createModelRenamePlan(options: ModelRenameOptions): Promise<Sbv2ModelRenamePlan>;
export declare function runModelRename(options: ModelRenameRunOptions): Promise<ModelRenameRunResult>;
