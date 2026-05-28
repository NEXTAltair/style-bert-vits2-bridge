import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { Sbv2Client } from "./sbv2-client";
import {
  listVoiceProfiles,
  parseVoiceDirectiveToken,
  resolveVoiceProfile,
} from "./voice-resolver";

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
      const voiceId = trimToUndefined(params.voiceId) ?? trimToUndefined(params.voice);
      const modelId = asNumber(params.modelId);
      const modelName = trimToUndefined(params.modelName) ?? trimToUndefined(params.model);
      const speed = asNumber(params.speed) ?? asNumber(params.rate);

      if (voiceId) overrides.voiceId = voiceId;
      if (modelId !== undefined) overrides.modelId = modelId;
      if (modelName) overrides.modelName = modelName;
      if (speed !== undefined) overrides.speed = speed;

      return overrides;
    },

    listVoices: async (req) => {
      const baseUrl = trimToUndefined(req.providerConfig?.baseUrl) ?? trimToUndefined(req.baseUrl);
      if (!baseUrl) {
        throw new Error("Style-Bert-VITS2 baseUrl is not configured");
      }

      const client = new Sbv2Client({ baseUrl });
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
        providerOverrides: req.providerOverrides,
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
