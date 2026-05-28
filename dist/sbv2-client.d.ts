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
export interface Sbv2ModelInfo {
    id?: number;
    sourceId?: string;
    name?: string;
    modelName?: string;
    model_name?: string;
    configPath?: string;
    config_path?: string;
    modelPath?: string;
    model_path?: string;
    spk2id?: Record<string, number>;
    id2spk?: Record<string, string>;
    style2id?: Record<string, number>;
    [key: string]: unknown;
}
export declare class Sbv2Client {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(options: Sbv2ClientOptions);
    synthesize(params: Sbv2SynthesizeParams): Promise<Buffer>;
    getModelsInfo(): Promise<Sbv2ModelInfo[]>;
}
