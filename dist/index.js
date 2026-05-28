import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Sbv2Client } from "./sbv2-client.js";
function trimToUndefined(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function firstString(...values) {
    for (const value of values) {
        const trimmed = trimToUndefined(value);
        if (trimmed)
            return trimmed;
    }
    return undefined;
}
function firstNumber(...values) {
    for (const value of values) {
        const number = asNumber(value);
        if (number !== undefined)
            return number;
    }
    return undefined;
}
function normalizeLanguage(value) {
    return value === "JP" || value === "EN" || value === "ZH" ? value : undefined;
}
function getModelName(model) {
    return (trimToUndefined(model.modelName) ??
        trimToUndefined(model.model_name) ??
        modelNameFromPath(trimToUndefined(model.configPath) ?? trimToUndefined(model.config_path)) ??
        modelNameFromPath(trimToUndefined(model.modelPath) ?? trimToUndefined(model.model_path)) ??
        trimToUndefined(model.name));
}
function modelNameFromPath(path) {
    if (!path)
        return undefined;
    const segments = path.split(/[\\/]+/).filter(Boolean);
    if (segments.length < 2)
        return undefined;
    return segments[segments.length - 2];
}
function getSpeakerNames(model) {
    const fromSpk2id = model.spk2id && typeof model.spk2id === "object" ? Object.keys(model.spk2id) : [];
    const fromId2spk = model.id2spk && typeof model.id2spk === "object" ? Object.values(model.id2spk) : [];
    return Array.from(new Set([...fromSpk2id, ...fromId2spk].map((name) => name.trim()).filter(Boolean)));
}
function getDefaultStyle(model) {
    const styles = model.style2id && typeof model.style2id === "object" ? Object.keys(model.style2id) : [];
    return styles.includes("Neutral") ? "Neutral" : styles[0];
}
function buildVoiceId(modelName, speakerName, style) {
    const parts = [
        "sbv2",
        encodeURIComponent(modelName),
        encodeURIComponent(speakerName),
    ];
    if (style)
        parts.push(encodeURIComponent(style));
    return parts.join(":");
}
function parseVoiceId(value) {
    const raw = trimToUndefined(value);
    if (!raw?.startsWith("sbv2:"))
        return undefined;
    const [, encodedModelName, encodedSpeakerName, encodedStyle] = raw.split(":");
    if (!encodedModelName || !encodedSpeakerName)
        return undefined;
    try {
        const modelName = decodeURIComponent(encodedModelName);
        const speakerName = decodeURIComponent(encodedSpeakerName);
        const style = encodedStyle ? decodeURIComponent(encodedStyle) : undefined;
        return modelName && speakerName ? { modelName, speakerName, style } : undefined;
    }
    catch {
        return undefined;
    }
}
export function buildSbv2SpeechProvider() {
    return {
        id: "style-bert-vits2",
        label: "Style-Bert-VITS2",
        isConfigured: ({ providerConfig }) => Boolean(trimToUndefined(providerConfig.baseUrl)),
        listVoices: async (req) => {
            const config = req.providerConfig ?? {};
            const baseUrl = trimToUndefined(config.baseUrl) ?? trimToUndefined(req.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            const models = await client.getModelsInfo();
            return models
                .flatMap((model) => {
                const modelName = getModelName(model);
                if (!modelName)
                    return [];
                const style = getDefaultStyle(model);
                const speakerNames = getSpeakerNames(model);
                if (speakerNames.length === 0) {
                    return [{ id: buildVoiceId(modelName, modelName, style), name: modelName }];
                }
                return speakerNames.map((speakerName) => ({
                    id: buildVoiceId(modelName, speakerName, style),
                    name: `${speakerName} (${modelName})`,
                }));
            })
                .sort((left, right) => left.name.localeCompare(right.name));
        },
        synthesize: async (req) => {
            const config = req.providerConfig;
            const selectedVoice = parseVoiceId(req.providerOverrides?.voiceId) ?? parseVoiceId(req.providerOverrides?.voice);
            const baseUrl = trimToUndefined(config.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? req.timeoutMs ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            const audioBuffer = await client.synthesize({
                text: req.text,
                modelName: selectedVoice?.modelName ?? firstString(config.defaultModelName, config.modelName),
                speakerId: selectedVoice ? undefined : firstNumber(config.defaultSpeakerId, config.speakerId),
                speakerName: selectedVoice?.speakerName ?? firstString(config.defaultSpeakerName, config.speakerName),
                style: selectedVoice?.style ?? firstString(config.defaultStyle, config.style) ?? "Neutral",
                language: normalizeLanguage(firstString(config.defaultLanguage, config.language)) ?? "JP",
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
