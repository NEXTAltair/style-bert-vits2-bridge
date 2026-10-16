export type CompatibleSpeechEngine = "irodori" | "speech-cpp";
export declare function buildCompatibleSpeechProvider(engine: CompatibleSpeechEngine): {
    resolveConfig: ({ rawConfig, timeoutMs }: {
        cfg: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        rawConfig: Record<string, unknown>;
        timeoutMs: number;
    }) => {
        timeoutMs: {};
    };
    listVoices: ({ providerConfig, baseUrl, apiKey, timeoutMs }: {
        cfg?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        providerConfig?: {
            [x: string]: unknown;
        };
        apiKey?: string;
        baseUrl?: string;
        timeoutMs?: number;
    }) => Promise<{
        id: string;
        name: string;
    }[]>;
    synthesize: (req: {
        text: string;
        cfg: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        providerConfig: {
            [x: string]: unknown;
        };
        target: "audio-file" | "voice-note" | "telephony";
        providerOverrides?: {
            [x: string]: unknown;
        };
        timeoutMs: number;
    }) => Promise<{
        audioBuffer: Buffer<ArrayBuffer>;
        outputFormat: string;
        fileExtension: string;
        voiceCompatible: false;
        metadata: {
            provider: CompatibleSpeechEngine;
            model: string | undefined;
            voice: string;
            speed: number;
            streaming: boolean;
        };
    }>;
    isConfigured: (ctx: {
        cfg?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        providerConfig: {
            [x: string]: unknown;
        };
        timeoutMs: number;
    }) => boolean;
    isConfiguredAsync: (context: Parameters<(ctx: {
        cfg?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        providerConfig: {
            [x: string]: unknown;
        };
        timeoutMs: number;
    }) => boolean>[0]) => Promise<boolean>;
    id: CompatibleSpeechEngine;
    label: string;
    defaultTimeoutMs: number;
};
