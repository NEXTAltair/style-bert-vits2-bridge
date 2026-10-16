import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
export type CompatibleSpeechEngine = "irodori" | "speech-cpp";
export declare function buildCompatibleSpeechProvider(engine: CompatibleSpeechEngine): SpeechProviderPlugin;
