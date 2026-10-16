interface Sbv2ProviderLogger {
    debug?: (message: string, data?: unknown) => void;
}
interface Sbv2SpeechProviderOptions {
    logger?: Sbv2ProviderLogger;
}
interface Sbv2TelemetryMetadata extends Record<string, unknown> {
    provider: "style-bert-vits2";
    baseUrl: string;
    voiceId?: string;
    modelName?: string;
    modelId?: number;
    speakerName?: string;
    speakerId?: number;
    style?: string;
    styleWeight?: number;
    sdpRatio?: number;
    noise?: number;
    noisew?: number;
    length?: number;
    language?: string;
    outputFormat: "wav";
    audioBytes?: number;
    textPreparation?: "explicit" | "tool_status_rewrite" | "metadata_status_rewrite" | "url_sanitize";
    emotionMood?: string;
    emotionProfile?: string;
}
export declare function buildSbv2SpeechProvider(options?: Sbv2SpeechProviderOptions): {
    parseDirectiveToken: (ctx: {
        key: string;
        value: string;
        policy: {
            enabled: boolean;
            allowText: boolean;
            allowProvider: boolean;
            allowVoice: boolean;
            allowModelId: boolean;
            allowVoiceSettings: boolean;
            allowNormalization: boolean;
            allowSeed: boolean;
        };
        selectedProvider?: string;
        providerConfig?: {
            [x: string]: unknown;
        };
        currentOverrides?: {
            [x: string]: unknown;
        };
    }) => {
        handled: true;
        overrides: {
            [x: string]: unknown;
        };
    } | {
        handled: false;
        overrides?: undefined;
    };
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }: {
        cfg: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        baseTtsConfig: Record<string, unknown>;
        talkProviderConfig: {
            [x: string]: unknown;
            apiKey?: string | {
                source: "env";
                provider: string;
                id: string;
            } | {
                source: "file";
                provider: string;
                id: string;
            } | {
                source: "exec";
                provider: string;
                id: string;
            } | {
                source: "store";
                provider: string;
                id: string;
            } | undefined;
        };
        timeoutMs: number;
    }) => {
        [x: string]: unknown;
        apiKey?: string | {
            source: "env";
            provider: string;
            id: string;
        } | {
            source: "file";
            provider: string;
            id: string;
        } | {
            source: "exec";
            provider: string;
            id: string;
        } | {
            source: "store";
            provider: string;
            id: string;
        } | undefined;
    };
    resolveTalkOverrides: ({ params }: {
        talkProviderConfig: {
            [x: string]: unknown;
            apiKey?: string | {
                source: "env";
                provider: string;
                id: string;
            } | {
                source: "file";
                provider: string;
                id: string;
            } | {
                source: "exec";
                provider: string;
                id: string;
            } | {
                source: "store";
                provider: string;
                id: string;
            } | undefined;
        };
        params: Record<string, unknown>;
    }) => Record<string, unknown>;
    listVoices: (req: {
        cfg?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        providerConfig?: {
            [x: string]: unknown;
        };
        apiKey?: string;
        baseUrl?: string;
        timeoutMs?: number;
    }) => Promise<{
        id: string;
        name?: string;
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
        audioBuffer: Buffer<ArrayBufferLike>;
        outputFormat: string;
        fileExtension: string;
        voiceCompatible: false;
        metadata: Sbv2TelemetryMetadata;
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
    id: string;
    label: string;
};
declare const _default: Omit<{
    id: string;
    name: string;
    description: string;
    kind?: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition["kind"];
    configSchema?: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginConfigSchema | (() => import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginConfigSchema);
    reload?: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition["reload"];
    nodeHostCommands?: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition["nodeHostCommands"];
    securityAuditCollectors?: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition["securityAuditCollectors"];
    register: NonNullable<import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition["register"]>;
}, "configSchema"> & {
    configSchema: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginConfigSchema;
};
export default _default;
