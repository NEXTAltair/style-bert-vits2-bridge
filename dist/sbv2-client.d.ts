export interface Sbv2SynthesizeParams {
    text: string;
    encoding?: string;
    modelName?: string;
    modelId?: number;
    speakerName?: string;
    speakerId?: number;
    sdpRatio?: number;
    noise?: number;
    noisew?: number;
    length?: number;
    language?: "JP" | "EN" | "ZH";
    autoSplit?: boolean;
    splitInterval?: number;
    assistText?: string;
    assistTextWeight?: number;
    style?: string;
    styleWeight?: number;
}
export interface Sbv2ClientOptions {
    baseUrl: string;
    timeoutMs?: number;
}
export interface Sbv2NamedItem {
    id?: number;
    name: string;
}
export interface Sbv2ModelInfo {
    id?: number;
    sourceId?: string;
    name: string;
    modelName?: string;
    model_name?: string;
    configPath?: string;
    config_path?: string;
    modelPath?: string;
    model_path?: string;
    spk2id?: Record<string, number>;
    id2spk?: Record<string, string>;
    speaker2id?: Record<string, number>;
    speaker2Id?: Record<string, number>;
    speaker_map?: Record<string, number>;
    speakerMap?: Record<string, number>;
    style2id?: Record<string, number>;
    style2Id?: Record<string, number>;
    id2style?: Record<string, string>;
    style_map?: Record<string, number>;
    styleMap?: Record<string, number>;
    speakers: Sbv2NamedItem[];
    styles: Sbv2NamedItem[];
    raw: unknown;
    [key: string]: unknown;
}
export declare class Sbv2UnavailableError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare function normalizeModelsInfo(value: unknown): Sbv2ModelInfo[];
export declare class Sbv2Client {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(options: Sbv2ClientOptions);
    getModelsInfo(): Promise<Sbv2ModelInfo[]>;
    refreshModels(): Promise<Sbv2ModelInfo[]>;
    synthesize(params: Sbv2SynthesizeParams): Promise<Buffer>;
}
