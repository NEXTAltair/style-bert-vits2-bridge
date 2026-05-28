export const DEFAULT_VOICE_PROFILE = {
    voiceId: "valentina01_bright",
    modelName: "valentina01_bright",
    speakerName: "valentina01_bright",
    style: "00_Neutral",
    language: "JP",
};
const FIXED_PROFILES = {
    [DEFAULT_VOICE_PROFILE.voiceId]: DEFAULT_VOICE_PROFILE,
};
function trimToUndefined(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }
    return undefined;
}
function asLanguage(value) {
    const language = trimToUndefined(value);
    return language === "JP" || language === "EN" || language === "ZH" ? language : undefined;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function speedToLength(value) {
    const speed = asNumber(value);
    if (speed === undefined || speed <= 0) {
        return undefined;
    }
    return clamp(1 / speed, 0.5, 2);
}
function withoutUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
function readProviderDefaults(config) {
    return withoutUndefined({
        modelName: trimToUndefined(config.defaultModelName) ?? trimToUndefined(config.modelName),
        modelId: asNumber(config.defaultModelId) ?? asNumber(config.modelId),
        speakerName: trimToUndefined(config.defaultSpeakerName) ?? trimToUndefined(config.speakerName),
        speakerId: asNumber(config.defaultSpeakerId) ?? asNumber(config.speakerId),
        style: trimToUndefined(config.defaultStyle) ?? trimToUndefined(config.style),
        styleWeight: asNumber(config.defaultStyleWeight) ?? asNumber(config.styleWeight),
        length: asNumber(config.defaultLength) ?? asNumber(config.length),
        language: asLanguage(config.defaultLanguage) ?? asLanguage(config.language),
        assistText: trimToUndefined(config.defaultAssistText) ?? trimToUndefined(config.assistText),
        assistTextWeight: asNumber(config.defaultAssistTextWeight) ?? asNumber(config.assistTextWeight),
    });
}
function readOverrides(overrides) {
    if (!overrides) {
        return {};
    }
    return withoutUndefined({
        voiceId: trimToUndefined(overrides.voiceId) ?? trimToUndefined(overrides.voice),
        modelName: trimToUndefined(overrides.modelName) ?? trimToUndefined(overrides.model),
        modelId: asNumber(overrides.modelId),
        speakerName: trimToUndefined(overrides.speakerName) ??
            trimToUndefined(overrides.speaker) ??
            trimToUndefined(overrides.voice),
        speakerId: asNumber(overrides.speakerId),
        style: trimToUndefined(overrides.style),
        styleWeight: asNumber(overrides.styleWeight),
        length: asNumber(overrides.length) ?? speedToLength(overrides.speed),
        language: asLanguage(overrides.language),
        assistText: trimToUndefined(overrides.assistText),
        assistTextWeight: asNumber(overrides.assistTextWeight),
    });
}
function findProfile(voiceId) {
    const profile = FIXED_PROFILES[voiceId];
    if (!profile) {
        throw new Error(`SBV2 voice profile "${voiceId}" is not available`);
    }
    return profile;
}
function findModel(models, params) {
    if (params.modelName) {
        const model = models.find((candidate) => candidate.name === params.modelName);
        if (!model) {
            throw new Error(`SBV2 model "${params.modelName}" was not found in /models/info`);
        }
        return model;
    }
    if (params.modelId !== undefined) {
        const model = models.find((candidate) => candidate.id === params.modelId || Number(candidate.sourceId) === params.modelId) ?? models[params.modelId];
        if (!model) {
            throw new Error(`SBV2 model id "${params.modelId}" was not found in /models/info`);
        }
        return model;
    }
    throw new Error("SBV2 model could not be resolved from the selected voice profile");
}
function hasVoiceIdentity(params) {
    return (params.modelName !== undefined ||
        params.modelId !== undefined ||
        params.speakerName !== undefined ||
        params.speakerId !== undefined);
}
function applyVoiceLayer(resolved, source) {
    if (!hasVoiceIdentity(source)) {
        Object.assign(resolved, source);
        return;
    }
    if (source.modelId !== undefined && source.modelName === undefined) {
        delete resolved.modelName;
    }
    if ((source.modelName !== undefined || source.modelId !== undefined) &&
        source.speakerName === undefined &&
        source.speakerId === undefined) {
        delete resolved.speakerName;
        delete resolved.speakerId;
    }
    if (source.style === undefined) {
        delete resolved.style;
    }
    Object.assign(resolved, source);
}
function assertSpeaker(model, params) {
    if (params.speakerName) {
        if (!model.speakers.length) {
            throw new Error(`SBV2 /models/info did not include speakers for model "${model.name}"`);
        }
        if (!model.speakers.some((speaker) => speaker.name === params.speakerName)) {
            throw new Error(`SBV2 speaker "${params.speakerName}" is not available for model "${model.name}"`);
        }
    }
    if (params.speakerId !== undefined) {
        if (!model.speakers.length) {
            throw new Error(`SBV2 /models/info did not include speakers for model "${model.name}"`);
        }
        if (!model.speakers.some((speaker) => speaker.id === params.speakerId)) {
            throw new Error(`SBV2 speaker id "${params.speakerId}" is not available for model "${model.name}"`);
        }
    }
}
function assertStyle(model, params) {
    if (!params.style) {
        return;
    }
    if (!model.styles.length) {
        throw new Error(`SBV2 /models/info did not include styles for model "${model.name}"`);
    }
    if (!model.styles.some((style) => style.name === params.style)) {
        throw new Error(`SBV2 style "${params.style}" is not available for model "${model.name}"`);
    }
}
export async function resolveVoiceProfile({ client, providerConfig, providerOverrides, }) {
    const configDefaults = readProviderDefaults(providerConfig);
    const overrides = readOverrides(providerOverrides);
    const explicitProfile = overrides.voiceId
        ? findProfile(overrides.voiceId)
        : {};
    const resolved = { ...DEFAULT_VOICE_PROFILE };
    applyVoiceLayer(resolved, configDefaults);
    applyVoiceLayer(resolved, explicitProfile);
    applyVoiceLayer(resolved, overrides);
    resolved.voiceId = overrides.voiceId ?? explicitProfile.voiceId ?? DEFAULT_VOICE_PROFILE.voiceId;
    const models = await client.getModelsInfo();
    const model = findModel(models, resolved);
    assertSpeaker(model, resolved);
    assertStyle(model, resolved);
    return resolved;
}
export function listVoiceProfiles(models) {
    return models.flatMap((model) => {
        const styleSuffix = model.styles[0]?.name ? `:${encodeURIComponent(model.styles[0].name)}` : "";
        if (!model.speakers.length) {
            return [{ id: `sbv2:${encodeURIComponent(model.name)}:${styleSuffix}`, name: model.name }];
        }
        return model.speakers.map((speaker) => ({
            id: `sbv2:${encodeURIComponent(model.name)}:${encodeURIComponent(speaker.name)}${styleSuffix}`,
            name: `${speaker.name} (${model.name})`,
        }));
    }).sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id));
}
export function parseVoiceDirectiveToken(ctx) {
    const key = ctx.key.trim().toLowerCase();
    const value = ctx.value.trim();
    if (!value) {
        return undefined;
    }
    const allowVoice = Boolean(ctx.policy.allowVoice);
    const allowModelId = Boolean(ctx.policy.allowModelId);
    const allowVoiceSettings = Boolean(ctx.policy.allowVoiceSettings);
    switch (key) {
        case "voice":
        case "voice_id":
            return allowVoice ? { voiceId: value } : undefined;
        case "speaker":
        case "speaker_name":
            return allowVoice ? { speakerName: value } : undefined;
        case "speaker_id":
            return allowVoice ? { speakerId: asNumber(value) } : undefined;
        case "model":
        case "model_name":
            return allowModelId ? { modelName: value } : undefined;
        case "model_id":
            return allowModelId ? { modelId: asNumber(value) } : undefined;
        case "style":
            return allowVoiceSettings ? { style: value } : undefined;
        case "style_weight":
            return allowVoiceSettings ? { styleWeight: asNumber(value) } : undefined;
        case "length":
            return allowVoiceSettings ? { length: asNumber(value) } : undefined;
        case "speed":
            return allowVoiceSettings ? { speed: asNumber(value) } : undefined;
        case "assist_text":
            return allowVoiceSettings ? { assistText: value } : undefined;
        case "assist_text_weight":
            return allowVoiceSettings ? { assistTextWeight: asNumber(value) } : undefined;
        default:
            return undefined;
    }
}
