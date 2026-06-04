import { type Sbv2JobManifest } from "./jobs.js";
export interface Sbv2StyleMergeRecipeStyle {
    styleA: string;
    styleB: string;
    outputStyle: string;
}
export interface Sbv2StyleMergeRecipe {
    schemaVersion: 1;
    outputModelName: string;
    modelA: string;
    modelB: string;
    styleWeight?: number;
    styles: Sbv2StyleMergeRecipeStyle[];
}
export interface Sbv2StyleMergeInput {
    modelName: string;
    modelDir: string;
    configJsonPath: string;
    styleVectorsPath: string;
    style2id: Record<string, number>;
    numStyles: number;
    styleVectorShape: number[];
}
export interface Sbv2StyleMergeRow {
    index: number;
    styleA: string;
    styleAIndex: number;
    styleB: string;
    styleBIndex: number;
    outputStyle: string;
}
export interface Sbv2StyleMergeCompatibilityReport {
    compatible: boolean;
    errors: string[];
    warnings: string[];
}
export interface Sbv2StyleMergePlan {
    schemaVersion: 1;
    sbv2Root: string;
    assetsRoot: string;
    recipePath: string;
    outputModelName: string;
    outputDir: string;
    outputConfigJsonPath: string;
    outputStyleVectorsPath: string;
    modelA: Sbv2StyleMergeInput;
    modelB: Sbv2StyleMergeInput;
    styleWeight: number;
    styleRows: Sbv2StyleMergeRow[];
    outputStyle2id: Record<string, number>;
    compatibility: Sbv2StyleMergeCompatibilityReport;
    expectedArtifacts: string[];
}
export interface StyleMergePlanOptions {
    sbv2Root?: string;
    recipePath: string;
}
export interface StyleMergeRunOptions extends StyleMergePlanOptions {
    jobsRoot?: string;
    confirmOutputModelName: string;
    baseUrl?: string;
    now?: () => Date;
    randomId?: () => string;
}
export interface Sbv2StyleMergeSummary {
    schemaVersion: 1;
    outputModelName: string;
    outputDir: string;
    recipePath: string;
    plan: Sbv2StyleMergePlan;
    styleWeight: number;
    outputStyle2id: Record<string, number>;
    refresh?: {
        baseUrl: string;
        refreshed: boolean;
        foundInModelsInfo: boolean;
        modelsInfoCount: number;
    };
    nextSteps: string[];
}
export interface StyleMergeRunResult {
    plan: Sbv2StyleMergePlan;
    summary: Sbv2StyleMergeSummary;
    job: Sbv2JobManifest;
}
export declare function createStyleMergePlan(options: StyleMergePlanOptions): Promise<Sbv2StyleMergePlan>;
export declare function runStyleMerge(options: StyleMergeRunOptions): Promise<StyleMergeRunResult>;
