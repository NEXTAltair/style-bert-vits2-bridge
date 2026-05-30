import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { Sbv2Client } from "./sbv2-client.js";
import {
  listVoiceProfiles,
  parseVoiceDirectiveToken,
  resolveVoiceProfile,
  type Sbv2ResolvedVoiceProfile,
} from "./voice-resolver.js";

interface Sbv2ProviderLogger {
  debug?: (message: string, data?: unknown) => void;
}

interface Sbv2SpeechProviderOptions {
  logger?: Sbv2ProviderLogger;
}

interface Sbv2TelemetryMetadata extends Record<string, unknown> {
  provider: "style-bert-vits2";
  baseUrl: string;
  voiceId?: string;
  modelName?: string;
  modelId?: number;
  speakerName?: string;
  speakerId?: number;
  style?: string;
  styleWeight?: number;
  length?: number;
  language?: string;
  outputFormat: "wav";
  audioBytes?: number;
}

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

function asSbv2Language(value: unknown): Sbv2ResolvedVoiceProfile["language"] | undefined {
  const language = trimToUndefined(value);
  return language === "JP" || language === "EN" || language === "ZH" ? language : undefined;
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

function sanitizeBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "<invalid baseUrl>";
  }
}

function readVoiceContext(
  config: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
): Partial<Sbv2ResolvedVoiceProfile> {
  return {
    voiceId: trimToUndefined(overrides?.voiceId) ?? trimToUndefined(overrides?.voice),
    modelName:
      trimToUndefined(overrides?.modelName) ??
      trimToUndefined(overrides?.model) ??
      trimToUndefined(config.defaultModelName) ??
      trimToUndefined(config.modelName),
    modelId: asNumber(overrides?.modelId) ?? asNumber(config.defaultModelId) ?? asNumber(config.modelId),
    speakerName:
      trimToUndefined(overrides?.speakerName) ??
      trimToUndefined(overrides?.speaker) ??
      trimToUndefined(config.defaultSpeakerName) ??
      trimToUndefined(config.speakerName),
    speakerId:
      asNumber(overrides?.speakerId) ??
      asNumber(config.defaultSpeakerId) ??
      asNumber(config.speakerId),
    style:
      trimToUndefined(overrides?.style) ??
      trimToUndefined(config.defaultStyle) ??
      trimToUndefined(config.style),
    styleWeight:
      asNumber(overrides?.styleWeight) ??
      asNumber(config.defaultStyleWeight) ??
      asNumber(config.styleWeight),
    length:
      asNumber(overrides?.length) ??
      asNumber(config.defaultLength) ??
      asNumber(config.length),
    language:
      asSbv2Language(overrides?.language) ??
      asSbv2Language(config.defaultLanguage) ??
      asSbv2Language(config.language),
  };
}

function buildTelemetryMetadata(args: {
  baseUrl: string;
  resolvedVoice: Partial<Sbv2ResolvedVoiceProfile>;
  audioBytes?: number;
}): Sbv2TelemetryMetadata {
  const { resolvedVoice } = args;
  return {
    provider: "style-bert-vits2",
    baseUrl: sanitizeBaseUrl(args.baseUrl),
    voiceId: resolvedVoice.voiceId,
    modelName: resolvedVoice.modelName,
    modelId: resolvedVoice.modelId,
    speakerName: resolvedVoice.speakerName,
    speakerId: resolvedVoice.speakerId,
    style: resolvedVoice.style,
    styleWeight: resolvedVoice.styleWeight,
    length: resolvedVoice.length,
    language: resolvedVoice.language,
    outputFormat: "wav",
    audioBytes: args.audioBytes,
  };
}

function formatTelemetryContext(metadata: Sbv2TelemetryMetadata): string {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}

function withTelemetryContext(error: unknown, metadata: Sbv2TelemetryMetadata): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}. SBV2 telemetry context: ${formatTelemetryContext(metadata)}`);
}

export function buildSbv2SpeechProvider(options: Sbv2SpeechProviderOptions = {}): SpeechProviderPlugin {
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
      const providerOverrides = normalizeOverrides(req.providerOverrides);
      let resolvedVoice: Sbv2ResolvedVoiceProfile;

      try {
        resolvedVoice = await resolveVoiceProfile({
          client,
          providerConfig: config,
          providerOverrides,
        });
      } catch (error) {
        throw withTelemetryContext(
          error,
          buildTelemetryMetadata({
            baseUrl,
            resolvedVoice: readVoiceContext(config, providerOverrides),
          }),
        );
      }

      let audioBuffer: Buffer;
      try {
        audioBuffer = await client.synthesize({
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
      } catch (error) {
        throw withTelemetryContext(
          error,
          buildTelemetryMetadata({
            baseUrl,
            resolvedVoice,
          }),
        );
      }

      const metadata = buildTelemetryMetadata({
        baseUrl,
        resolvedVoice,
        audioBytes: audioBuffer.length,
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

  register(api: any) {
    api?.logger?.info?.("register start");
    api.registerSpeechProvider(buildSbv2SpeechProvider({ logger: api?.logger }));
    api?.logger?.info?.("speech provider registered: style-bert-vits2");
  },
});
