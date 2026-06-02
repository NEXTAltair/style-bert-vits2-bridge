import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { applyPronunciationReplacements, resolvePronunciationReplacements, } from "./pronunciation.js";
import { SBV2_FALLBACK_VOICE_TEXT_MAX_CHARS, Sbv2Client } from "./sbv2-client.js";
import { listVoiceProfiles, parseVoiceDirectiveToken, resolveVoiceProfile, } from "./voice-resolver.js";
const TOOL_STATUS_REWRITE_TEXT = {
    JP: "コマンドが失敗しました。別の方法で進めます。",
    EN: "The command failed. I will try another way.",
    ZH: "命令执行失败。我会尝试其他方法。",
};
function trimToUndefined(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }
    return undefined;
}
function asSbv2Language(value) {
    const language = trimToUndefined(value);
    return language === "JP" || language === "EN" || language === "ZH" ? language : undefined;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function rateWpmToLength(value) {
    const rateWpm = asNumber(value);
    if (rateWpm === undefined || rateWpm <= 0)
        return undefined;
    return clamp(180 / rateWpm, 0.5, 2);
}
function extractExplicitTtsText(value) {
    const match = value.match(/\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/);
    return match?.[1]?.trim() || undefined;
}
function looksLikeToolStatusText(value) {
    const text = value.trim();
    if (!text)
        return false;
    const hasFailureStatus = /(?:^|\s)(?:failed|error|exit code \d+|command failed)(?:[:.]|$|\s)/i.test(text);
    if (!hasFailureStatus)
        return false;
    const commandInvocation = /(?:^|\n)\s*(?:[⚠🛠️\s]+)?(?:gh|git|pnpm|npm|yarn|uv|python|node|bash|sh)\s+(?:(?:-{1,2}[a-z][a-z0-9-]*)|(?:[a-z0-9:_./-]+\s+-{1,2}[a-z][a-z0-9-]*)|(?:(?:issue|pr|repo|api|status|checkout|switch|merge|pull|push|fetch|commit|add|run|test|install|build|exec)\b))/i;
    const hasCwdSuffix = /\(\s*in\s+(?:~\/|\/|[A-Za-z]:\\)[^)]+\)/i.test(text);
    const hasMultilineError = /\n\s*(?:error|failed|exit code \d+|command failed)(?:[:.]|$|\s)/i.test(text);
    return commandInvocation.test(text) && (hasCwdSuffix || hasMultilineError || /\s-{1,2}[a-z][a-z0-9-]*(?:[=\s]|$)/i.test(text));
}
function prepareSpeechText(value, language) {
    const explicitText = extractExplicitTtsText(value);
    if (explicitText) {
        return { text: explicitText, textPreparation: "explicit" };
    }
    if (looksLikeToolStatusText(value)) {
        return { text: TOOL_STATUS_REWRITE_TEXT[language ?? "JP"], textPreparation: "tool_status_rewrite" };
    }
    return { text: value };
}
function parseSbv2VoiceId(value) {
    const raw = trimToUndefined(value);
    if (!raw?.startsWith("sbv2:"))
        return undefined;
    const [, encodedModelName, encodedSpeakerName, encodedStyle] = raw.split(":");
    if (!encodedModelName)
        return undefined;
    try {
        return {
            modelName: decodeURIComponent(encodedModelName),
            speakerName: encodedSpeakerName ? decodeURIComponent(encodedSpeakerName) : undefined,
            style: encodedStyle ? decodeURIComponent(encodedStyle) : undefined,
        };
    }
    catch {
        return undefined;
    }
}
function normalizeOverrides(overrides) {
    const selectedVoiceId = trimToUndefined(overrides?.voiceId) ?? trimToUndefined(overrides?.voice);
    const selectedVoice = parseSbv2VoiceId(selectedVoiceId);
    if (selectedVoiceId?.startsWith("sbv2:") && !selectedVoice) {
        throw new Error(`Malformed SBV2 voice ID "${selectedVoiceId}"`);
    }
    if (!selectedVoice)
        return overrides;
    const { voiceId: _voiceId, voice: _voice, ...rest } = overrides ?? {};
    return { voiceId: selectedVoiceId, ...selectedVoice, ...rest };
}
function sanitizeBaseUrl(value) {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return "<invalid baseUrl>";
    }
}
function readVoiceContext(config, overrides) {
    return {
        voiceId: trimToUndefined(overrides?.voiceId) ?? trimToUndefined(overrides?.voice),
        modelName: trimToUndefined(overrides?.modelName) ??
            trimToUndefined(overrides?.model) ??
            trimToUndefined(config.defaultModelName) ??
            trimToUndefined(config.modelName),
        modelId: asNumber(overrides?.modelId) ?? asNumber(config.defaultModelId) ?? asNumber(config.modelId),
        speakerName: trimToUndefined(overrides?.speakerName) ??
            trimToUndefined(overrides?.speaker) ??
            trimToUndefined(config.defaultSpeakerName) ??
            trimToUndefined(config.speakerName),
        speakerId: asNumber(overrides?.speakerId) ??
            asNumber(config.defaultSpeakerId) ??
            asNumber(config.speakerId),
        style: trimToUndefined(overrides?.style) ??
            trimToUndefined(config.defaultStyle) ??
            trimToUndefined(config.style),
        styleWeight: asNumber(overrides?.styleWeight) ??
            asNumber(config.defaultStyleWeight) ??
            asNumber(config.styleWeight),
        sdpRatio: asNumber(overrides?.sdpRatio) ??
            asNumber(config.defaultSdpRatio) ??
            asNumber(config.sdpRatio),
        noise: asNumber(overrides?.noise) ??
            asNumber(config.defaultNoise) ??
            asNumber(config.noise),
        noisew: asNumber(overrides?.noisew) ??
            asNumber(config.defaultNoisew) ??
            asNumber(config.noisew),
        length: asNumber(overrides?.length) ??
            asNumber(config.defaultLength) ??
            asNumber(config.length),
        language: asSbv2Language(overrides?.language) ??
            asSbv2Language(config.defaultLanguage) ??
            asSbv2Language(config.language),
    };
}
function buildTelemetryMetadata(args) {
    const { resolvedVoice } = args;
    const metadata = {
        provider: "style-bert-vits2",
        baseUrl: sanitizeBaseUrl(args.baseUrl),
        voiceId: resolvedVoice.voiceId,
        modelName: resolvedVoice.modelName,
        modelId: resolvedVoice.modelId,
        speakerName: resolvedVoice.speakerName,
        speakerId: resolvedVoice.speakerId,
        style: resolvedVoice.style,
        styleWeight: resolvedVoice.styleWeight,
        sdpRatio: resolvedVoice.sdpRatio,
        noise: resolvedVoice.noise,
        noisew: resolvedVoice.noisew,
        length: resolvedVoice.length,
        language: resolvedVoice.language,
        outputFormat: "wav",
        audioBytes: args.audioBytes,
    };
    if (args.textPreparation)
        metadata.textPreparation = args.textPreparation;
    return metadata;
}
function formatTelemetryContext(metadata) {
    const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}
function withTelemetryContext(error, metadata) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message}. SBV2 telemetry context: ${formatTelemetryContext(metadata)}`);
}
function assertSbv2TextWithinHardLimit(text, maxInputChars) {
    if (maxInputChars === undefined)
        return;
    const textChars = Array.from(text).length;
    if (textChars <= maxInputChars)
        return;
    throw new Error(`SBV2 /voice text is too long: ${textChars} chars exceeds provider hard limit ${maxInputChars}. ` +
        "Prepare shorter spoken text before synthesis.");
}
export function buildSbv2SpeechProvider(options = {}) {
    return {
        id: "style-bert-vits2",
        label: "Style-Bert-VITS2",
        capabilities: {
            text: {
                maxInputChars: SBV2_FALLBACK_VOICE_TEXT_MAX_CHARS,
            },
        },
        isConfigured: ({ providerConfig }) => Boolean(trimToUndefined(providerConfig.baseUrl)),
        resolveCapabilities: async (req) => {
            const config = req.providerConfig ?? {};
            const baseUrl = trimToUndefined(config.baseUrl) ?? trimToUndefined(req.baseUrl);
            if (!baseUrl) {
                return {
                    text: {
                        maxInputChars: SBV2_FALLBACK_VOICE_TEXT_MAX_CHARS,
                    },
                };
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            return {
                text: await client.getTextCapabilities(),
            };
        },
        parseDirectiveToken: (ctx) => {
            const parsed = parseVoiceDirectiveToken(ctx);
            return parsed ? { handled: true, overrides: { ...ctx.currentOverrides, ...parsed } } : undefined;
        },
        resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => ({
            ...baseTtsConfig,
            ...talkProviderConfig,
        }),
        resolveTalkOverrides: ({ params }) => {
            const overrides = {};
            const voiceId = trimToUndefined(params.voiceId) ??
                trimToUndefined(params.voice_id) ??
                trimToUndefined(params.voice);
            const modelId = asNumber(params.modelId) ?? asNumber(params.model_id);
            const modelName = trimToUndefined(params.modelName) ??
                trimToUndefined(params.model_name) ??
                trimToUndefined(params.model);
            const speakerId = asNumber(params.speakerId) ?? asNumber(params.speaker_id);
            const speakerName = trimToUndefined(params.speakerName) ??
                trimToUndefined(params.speaker_name) ??
                trimToUndefined(params.speaker);
            const speed = asNumber(params.speed);
            const length = asNumber(params.length) ?? rateWpmToLength(params.rateWpm) ?? rateWpmToLength(params.rate_wpm) ?? rateWpmToLength(params.rate);
            const style = trimToUndefined(params.style);
            const styleWeight = asNumber(params.styleWeight) ?? asNumber(params.style_weight);
            const sdpRatio = asNumber(params.sdpRatio) ?? asNumber(params.sdp_ratio);
            const noise = asNumber(params.noise);
            const noisew = asNumber(params.noisew) ?? asNumber(params.noise_w);
            const assistText = trimToUndefined(params.assistText) ?? trimToUndefined(params.assist_text);
            const assistTextWeight = asNumber(params.assistTextWeight) ?? asNumber(params.assist_text_weight);
            const language = trimToUndefined(params.language);
            if (voiceId)
                overrides.voiceId = voiceId;
            if (modelId !== undefined)
                overrides.modelId = modelId;
            if (modelName)
                overrides.modelName = modelName;
            if (speakerId !== undefined)
                overrides.speakerId = speakerId;
            if (speakerName)
                overrides.speakerName = speakerName;
            if (speed !== undefined)
                overrides.speed = speed;
            if (length !== undefined)
                overrides.length = length;
            if (style)
                overrides.style = style;
            if (styleWeight !== undefined)
                overrides.styleWeight = styleWeight;
            if (sdpRatio !== undefined)
                overrides.sdpRatio = sdpRatio;
            if (noise !== undefined)
                overrides.noise = noise;
            if (noisew !== undefined)
                overrides.noisew = noisew;
            if (assistText)
                overrides.assistText = assistText;
            if (assistTextWeight !== undefined)
                overrides.assistTextWeight = assistTextWeight;
            if (language)
                overrides.language = language;
            return overrides;
        },
        listVoices: async (req) => {
            const config = req.providerConfig ?? {};
            const baseUrl = trimToUndefined(config.baseUrl) ?? trimToUndefined(req.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            return listVoiceProfiles(await client.getModelsInfo());
        },
        synthesize: async (req) => {
            const config = req.providerConfig;
            const baseUrl = trimToUndefined(config.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? req.timeoutMs ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            const providerOverrides = normalizeOverrides(req.providerOverrides);
            let resolvedVoice;
            const pronunciationReplacements = resolvePronunciationReplacements(config);
            const textCapabilities = await client.getTextCapabilities();
            const explicitText = extractExplicitTtsText(req.text);
            const shouldDeferTextLimitCheck = !explicitText && looksLikeToolStatusText(req.text);
            if (!shouldDeferTextLimitCheck) {
                const preflightText = explicitText ?? applyPronunciationReplacements(req.text, pronunciationReplacements);
                assertSbv2TextWithinHardLimit(preflightText, textCapabilities.maxInputChars);
            }
            try {
                resolvedVoice = await resolveVoiceProfile({
                    client,
                    providerConfig: config,
                    providerOverrides,
                });
            }
            catch (error) {
                throw withTelemetryContext(error, buildTelemetryMetadata({
                    baseUrl,
                    resolvedVoice: readVoiceContext(config, providerOverrides),
                }));
            }
            let audioBuffer;
            const preparedText = prepareSpeechText(req.text, resolvedVoice.language);
            try {
                const synthesisText = preparedText.textPreparation === "explicit"
                    ? preparedText.text
                    : applyPronunciationReplacements(preparedText.text, pronunciationReplacements);
                assertSbv2TextWithinHardLimit(synthesisText, textCapabilities.maxInputChars);
                audioBuffer = await client.synthesize({
                    text: synthesisText,
                    modelName: resolvedVoice.modelName,
                    modelId: resolvedVoice.modelId,
                    speakerId: resolvedVoice.speakerId,
                    speakerName: resolvedVoice.speakerName,
                    style: resolvedVoice.style,
                    styleWeight: resolvedVoice.styleWeight,
                    sdpRatio: resolvedVoice.sdpRatio,
                    noise: resolvedVoice.noise,
                    noisew: resolvedVoice.noisew,
                    length: resolvedVoice.length,
                    assistText: resolvedVoice.assistText,
                    assistTextWeight: resolvedVoice.assistTextWeight,
                    language: resolvedVoice.language,
                });
            }
            catch (error) {
                throw withTelemetryContext(error, buildTelemetryMetadata({
                    baseUrl,
                    resolvedVoice,
                    textPreparation: preparedText.textPreparation,
                }));
            }
            const metadata = buildTelemetryMetadata({
                baseUrl,
                resolvedVoice,
                audioBytes: audioBuffer.length,
                textPreparation: preparedText.textPreparation,
            });
            options.logger?.debug?.("style-bert-vits2 synthesis resolved", metadata);
            return {
                audioBuffer,
                outputFormat: "wav",
                fileExtension: ".wav",
                voiceCompatible: false,
                metadata,
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
        api.registerSpeechProvider(buildSbv2SpeechProvider({ logger: api?.logger }));
        api?.logger?.info?.("speech provider registered: style-bert-vits2");
    },
});
