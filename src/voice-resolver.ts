import type { Sbv2Client, Sbv2ModelInfo, Sbv2SynthesizeParams } from "./sbv2-client.js";

export type Sbv2Language = "JP" | "EN" | "ZH";

export interface Sbv2ResolvedVoiceProfile
  extends Omit<Sbv2SynthesizeParams, "text" | "encoding"> {
  voiceId: string;
}

export interface ResolveVoiceProfileOptions {
  client: Pick<Sbv2Client, "getModelsInfo">;
  providerConfig: Record<string, unknown>;
  providerOverrides?: Record<string, unknown>;
}

export const DEFAULT_VOICE_PROFILE: Sbv2ResolvedVoiceProfile = {
  voiceId: "valentina01_bright",
  modelName: "valentina01_bright",
  speakerName: "valentina01_bright",
  style: "00_Neutral",
  language: "JP",
};

const FIXED_PROFILES: Record<string, Sbv2ResolvedVoiceProfile> = {
  [DEFAULT_VOICE_PROFILE.voiceId]: DEFAULT_VOICE_PROFILE,
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  return undefined;
}

function asLanguage(value: unknown): Sbv2Language | undefined {
  const language = trimToUndefined(value);
  return language === "JP" || language === "EN" || language === "ZH" ? language : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function speedToLength(value: unknown): number | undefined {
  const speed = asNumber(value);
  if (speed === undefined || speed <= 0) {
    return undefined;
  }

  return clamp(1 / speed, 0.5, 2);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function readProviderDefaults(config: Record<string, unknown>): Partial<Sbv2ResolvedVoiceProfile> {
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
    assistTextWeight:
      asNumber(config.defaultAssistTextWeight) ?? asNumber(config.assistTextWeight),
  });
}

function readOverrides(overrides: Record<string, unknown> | undefined): Partial<Sbv2ResolvedVoiceProfile> {
  if (!overrides) {
    return {};
  }

  return withoutUndefined({
    voiceId: trimToUndefined(overrides.voiceId) ?? trimToUndefined(overrides.voice),
    modelName: trimToUndefined(overrides.modelName) ?? trimToUndefined(overrides.model),
    modelId: asNumber(overrides.modelId),
    speakerName:
      trimToUndefined(overrides.speakerName) ??
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

function findProfile(voiceId: string): Sbv2ResolvedVoiceProfile {
  const profile = FIXED_PROFILES[voiceId];
  if (!profile) {
    throw new Error(`SBV2 voice profile "${voiceId}" is not available`);
  }

  return profile;
}

function findModel(
  models: Sbv2ModelInfo[],
  params: Partial<Sbv2ResolvedVoiceProfile>,
): Sbv2ModelInfo {
  if (params.modelName) {
    const model = models.find((candidate) => candidate.name === params.modelName);
    if (!model) {
      throw new Error(`SBV2 model "${params.modelName}" was not found in /models/info`);
    }
    return model;
  }

  if (params.modelId !== undefined) {
    const model =
      models.find(
        (candidate) =>
          candidate.id === params.modelId || Number(candidate.sourceId) === params.modelId,
      ) ?? models[params.modelId];
    if (!model) {
      throw new Error(`SBV2 model id "${params.modelId}" was not found in /models/info`);
    }
    return model;
  }

  throw new Error("SBV2 model could not be resolved from the selected voice profile");
}

function hasVoiceIdentity(params: Partial<Sbv2ResolvedVoiceProfile>): boolean {
  return (
    params.modelName !== undefined ||
    params.modelId !== undefined ||
    params.speakerName !== undefined ||
    params.speakerId !== undefined
  );
}

function removeInheritedVoiceDefaults(
  resolved: Sbv2ResolvedVoiceProfile,
  source: Partial<Sbv2ResolvedVoiceProfile>,
): void {
  if (!hasVoiceIdentity(source)) {
    return;
  }

  if (source.modelId !== undefined && source.modelName === undefined) {
    delete resolved.modelName;
  }

  if (
    (source.modelName !== undefined || source.modelId !== undefined) &&
    source.speakerName === undefined &&
    source.speakerId === undefined
  ) {
    delete resolved.speakerName;
    delete resolved.speakerId;
  }

  if (source.style === undefined) {
    delete resolved.style;
  }
}

function assertSpeaker(model: Sbv2ModelInfo, params: Partial<Sbv2ResolvedVoiceProfile>): void {
  if (params.speakerName) {
    if (!model.speakers.length) {
      throw new Error(`SBV2 /models/info did not include speakers for model "${model.name}"`);
    }

    if (!model.speakers.some((speaker) => speaker.name === params.speakerName)) {
      throw new Error(
        `SBV2 speaker "${params.speakerName}" is not available for model "${model.name}"`,
      );
    }
  }

  if (params.speakerId !== undefined) {
    if (!model.speakers.length) {
      throw new Error(`SBV2 /models/info did not include speakers for model "${model.name}"`);
    }

    if (!model.speakers.some((speaker) => speaker.id === params.speakerId)) {
      throw new Error(
        `SBV2 speaker id "${params.speakerId}" is not available for model "${model.name}"`,
      );
    }
  }
}

function assertStyle(model: Sbv2ModelInfo, params: Partial<Sbv2ResolvedVoiceProfile>): void {
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

export async function resolveVoiceProfile({
  client,
  providerConfig,
  providerOverrides,
}: ResolveVoiceProfileOptions): Promise<Sbv2ResolvedVoiceProfile> {
  const configDefaults = readProviderDefaults(providerConfig);
  const overrides = readOverrides(providerOverrides);
  const explicitProfile = overrides.voiceId ? findProfile(overrides.voiceId) : {};

  const resolved: Sbv2ResolvedVoiceProfile = {
    ...DEFAULT_VOICE_PROFILE,
    ...configDefaults,
    ...explicitProfile,
    ...overrides,
    voiceId: overrides.voiceId ?? DEFAULT_VOICE_PROFILE.voiceId,
  };
  removeInheritedVoiceDefaults(resolved, configDefaults);
  removeInheritedVoiceDefaults(resolved, overrides);

  const models = await client.getModelsInfo();
  const model = findModel(models, resolved);
  assertSpeaker(model, resolved);
  assertStyle(model, resolved);

  return resolved;
}

export function listVoiceProfiles(models: Sbv2ModelInfo[]): Array<{ id: string; name?: string }> {
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

export function parseVoiceDirectiveToken(ctx: {
  key: string;
  value: string;
  policy: Record<string, boolean>;
}): Record<string, unknown> | undefined {
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
