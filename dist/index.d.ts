import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
interface Sbv2ProviderLogger {
    debug?: (message: string, data?: unknown) => void;
}
interface Sbv2SpeechProviderOptions {
    logger?: Sbv2ProviderLogger;
}
export declare function buildSbv2SpeechProvider(options?: Sbv2SpeechProviderOptions): SpeechProviderPlugin;
declare const _default: import("openclaw/plugin-sdk/plugin-entry").PluginEntryOptions;
export default _default;
