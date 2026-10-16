import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
export declare function speechConfiguredHooks(check: SpeechProviderPlugin["isConfigured"]): {
    isConfigured: (ctx: {
        cfg?: import("openclaw/plugin-sdk/plugin-entry").OpenClawConfig;
        providerConfig: {
            [x: string]: unknown;
        };
        timeoutMs: number;
    }) => boolean;
    isConfiguredAsync: (context: Parameters<typeof check>[0]) => Promise<boolean>;
};
