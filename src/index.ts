import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { Sbv2Client } from "./sbv2-client.js";
import {
  listVoiceProfiles,
  parseVoiceDirectiveToken,
  resolveVoiceProfile,
} from "./voice-resolver.js";

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rateWpmToLength(value: unknown): number | undefined {
  const rateWpm = asNumber(value);
  if (rateWpm === undefined || rateWpm <= 0) return undefined;
  return clamp(180 / rateWpm, 0.5, 2);
}

function parseSbv2VoiceId(value: unknown): Record<string, unknown> | undefined {
  const raw = trimToUndefined(value);
  if (!raw?.startsWith("sbv2:")) return undefined;

  const [, encodedModelName, encodedSpeakerName, encodedStyle] = raw.split(":");
  if (!encodedModelName) return undefined;

  try {
    return {
      modelName: decodeURIComponent(encodedModelName),
      speakerName: encodedSpeakerName ? decodeURIComponent(encodedSpeakerName) : undefined,
      style: encodedStyle ? decodeURIComponent(encodedStyle) : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeOverrides(overrides: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const selectedVoice = parseSbv2VoiceId(overrides?.voiceId) ?? parseSbv2VoiceId(overrides?.voice);
  if (!selectedVoice) return overrides;

  const { voiceId: _voiceId, voice: _voice, ...rest } = overrides ?? {};
  return { ...selectedVoice, ...rest };
}

export function buildSbv2SpeechProvider(): SpeechProviderPlugin {
  return {
    id: "style-bert-vits2",
    label: "Style-Bert-VITS2",

    isConfigured: ({ providerConfig }) => Boolean(trimToUndefined(providerConfig.baseUrl)),

    parseDirectiveToken: (ctx) => {
      const parsed = parseVoiceDirectiveToken(ctx);
      return parsed ? { ...ctx.currentOverrides, ...parsed } : undefined;
    },

    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => ({
      ...baseTtsConfig,
      ...talkProviderConfig,
    }),

    resolveTalkOverrides: ({ params }) => {
      const overrides: Record<string, unknown> = {};
      const voiceId =
        trimToUndefined(params.voiceId) ??
        trimToUndefined(params.voice_id) ??
        trimToUndefined(params.voice);
      const modelId = asNumber(params.modelId) ?? asNumber(params.model_id);
      const modelName =
        trimToUndefined(params.modelName) ??
        trimToUndefined(params.model_name) ??
        trimToUndefined(params.model);
      const speakerId = asNumber(params.speakerId) ?? asNumber(params.speaker_id);
      const speakerName =
        trimToUndefined(params.speakerName) ??
        trimToUndefined(params.speaker_name) ??
        trimToUndefined(params.speaker);
      const speed = asNumber(params.speed);
      const length =
        asNumber(params.length) ?? rateWpmToLength(params.rateWpm) ?? rateWpmToLength(params.rate_wpm) ?? rateWpmToLength(params.rate);
      const style = trimToUndefined(params.style);
      const styleWeight = asNumber(params.styleWeight) ?? asNumber(params.style_weight);
      const assistText = trimToUndefined(params.assistText) ?? trimToUndefined(params.assist_text);
      const assistTextWeight =
        asNumber(params.assistTextWeight) ?? asNumber(params.assist_text_weight);
      const language = trimToUndefined(params.language);

      if (voiceId) overrides.voiceId = voiceId;
      if (modelId !== undefined) overrides.modelId = modelId;
      if (modelName) overrides.modelName = modelName;
      if (speakerId !== undefined) overrides.speakerId = speakerId;
      if (speakerName) overrides.speakerName = speakerName;
      if (speed !== undefined) overrides.speed = speed;
      if (length !== undefined) overrides.length = length;
      if (style) overrides.style = style;
      if (styleWeight !== undefined) overrides.styleWeight = styleWeight;
      if (assistText) overrides.assistText = assistText;
      if (assistTextWeight !== undefined) overrides.assistTextWeight = assistTextWeight;
      if (language) overrides.language = language;

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
      const resolvedVoice = await resolveVoiceProfile({
        client,
        providerConfig: config,
        providerOverrides: normalizeOverrides(req.providerOverrides),
      });

      const audioBuffer = await client.synthesize({
        text: req.text,
        modelName: resolvedVoice.modelName,
        modelId: resolvedVoice.modelId,
        speakerId: resolvedVoice.speakerId,
        speakerName: resolvedVoice.speakerName,
        style: resolvedVoice.style,
        styleWeight: resolvedVoice.styleWeight,
        length: resolvedVoice.length,
        assistText: resolvedVoice.assistText,
        assistTextWeight: resolvedVoice.assistTextWeight,
        language: resolvedVoice.language,
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

  register(api: any) {
    api?.logger?.info?.("register start");
    api.registerSpeechProvider(buildSbv2SpeechProvider());
    api?.logger?.info?.("speech provider registered: style-bert-vits2");
  },
});
