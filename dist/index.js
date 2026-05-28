import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Sbv2Client } from "./sbv2-client.js";
function trimToUndefined(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function buildSbv2SpeechProvider() {
    return {
        id: "style-bert-vits2",
        label: "Style-Bert-VITS2",
        isConfigured: ({ providerConfig }) => Boolean(trimToUndefined(providerConfig.baseUrl)),
        synthesize: async (req) => {
            const config = req.providerConfig;
            const baseUrl = trimToUndefined(config.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? req.timeoutMs ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            const audioBuffer = await client.synthesize({
                text: req.text,
                modelName: trimToUndefined(config.modelName),
                speakerId: asNumber(config.speakerId),
                speakerName: trimToUndefined(config.speakerName),
                style: trimToUndefined(config.style) ?? "Neutral",
                language: trimToUndefined(config.language) ?? "JP",
            });
            return {
                audioBuffer,
                outputFormat: "wav",
                fileExtension: ".wav",
                voiceCompatible: false,
            };
        },
    };
}
export default definePluginEntry({
    id: "style-bert-vits2-bridge",
    name: "Style-Bert-VITS2 Bridge",
    description: "Bridge OpenClaw to a Style-Bert-VITS2 API server for speech generation.",
    register(api) {
        api?.logger?.info?.("register start");
        api.registerSpeechProvider(buildSbv2SpeechProvider());
        api?.logger?.info?.("speech provider registered: style-bert-vits2");
    },
});
