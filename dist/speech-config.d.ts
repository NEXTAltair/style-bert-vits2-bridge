import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
type SpeechConfiguredContext = Parameters<NonNullable<SpeechProviderPlugin["isConfiguredAsync"]>>[0];
export declare function speechConfiguredHooks(check: (context: SpeechConfiguredContext) => boolean): {
    isConfigured: (context: SpeechConfiguredContext) => boolean;
    isConfiguredAsync: (context: SpeechConfiguredContext) => Promise<boolean>;
};
export {};
