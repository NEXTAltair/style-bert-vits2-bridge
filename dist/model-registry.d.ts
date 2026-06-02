import { type Sbv2JobManifest } from "./jobs.js";
export interface Sbv2ModelCandidateFile {
    path: string;
    sizeBytes: number;
}
export interface Sbv2ModelCandidate {
    schemaVersion: 1;
    candidateId: string;
    modelName: string;
    sbv2Root: string;
    sourceDir: string;
    targetDir: string;
    configJsonPath: string;
    styleVectorsPath: string;
    safetensors: Sbv2ModelCandidateFile[];
    configModelName?: string;
    warnings: string[];
    errors: string[];
    promotable: boolean;
}
export interface ListModelCandidatesOptions {
    manifestPath?: string;
    sbv2Root?: string;
    modelName?: string;
    sourcePath?: string;
}
export interface PromoteModelOptions extends ListModelCandidatesOptions {
    jobsRoot?: string;
    confirmModelName: string;
    backupExisting?: boolean;
    baseUrl?: string;
    evaluationPath?: string;
    now?: () => Date;
    randomId?: () => string;
}
export interface Sbv2ModelPromotionSummary {
    schemaVersion: 1;
    modelName: string;
    sourceDir: string;
    targetDir: string;
    copied: boolean;
    backupDir: string | null;
    candidate: Sbv2ModelCandidate;
    refresh?: {
        baseUrl: string;
        refreshed: boolean;
        foundInModelsInfo: boolean;
        modelsInfoCount: number;
    };
    evaluation?: Sbv2PromotionEvaluationGate;
}
export interface PromoteModelResult {
    candidate: Sbv2ModelCandidate;
    summary: Sbv2ModelPromotionSummary;
    job: Sbv2JobManifest;
}
interface Sbv2PromotionEvaluationGate {
    evaluationPath: string;
    decision: string | null;
    recommendation: string;
    accepted: boolean;
}
export declare function listModelCandidates(options: ListModelCandidatesOptions): Promise<Sbv2ModelCandidate[]>;
export declare function promoteModel(options: PromoteModelOptions): Promise<PromoteModelResult>;
export {};
