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
export declare class Sbv2Client {
    private readonly baseUrl;
    private readonly timeoutMs;
    constructor(options: Sbv2ClientOptions);
    synthesize(params: Sbv2SynthesizeParams): Promise<Buffer>;
}
