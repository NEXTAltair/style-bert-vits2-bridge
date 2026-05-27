import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { Sbv2Client, type Sbv2ModelInfo } from "./sbv2-client";

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getModelName(model: Sbv2ModelInfo): string | undefined {
  return (
    trimToUndefined(model.modelName) ??
    trimToUndefined(model.model_name) ??
    trimToUndefined(model.name)
  );
}

function getSpeakerNames(model: Sbv2ModelInfo): string[] {
  const fromSpk2id =
    model.spk2id && typeof model.spk2id === "object" ? Object.keys(model.spk2id) : [];
  const fromId2spk =
    model.id2spk && typeof model.id2spk === "object" ? Object.values(model.id2spk) : [];

  return Array.from(new Set([...fromSpk2id, ...fromId2spk].map((name) => name.trim()).filter(Boolean)));
}

function buildVoiceId(modelName: string, speakerName: string): string {
  return `sbv2:${encodeURIComponent(modelName)}:${encodeURIComponent(speakerName)}`;
}

function buildSbv2SpeechProvider(): SpeechProviderPlugin {
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
          if (!modelName) return [];

          const speakerNames = getSpeakerNames(model);
          if (speakerNames.length === 0) {
            return [{ id: buildVoiceId(modelName, modelName), name: modelName }];
          }

          return speakerNames.map((speakerName) => ({
            id: buildVoiceId(modelName, speakerName),
            name: `${speakerName} (${modelName})`,
          }));
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    },

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
        language: (trimToUndefined(config.language) as "JP" | "EN" | "ZH") ?? "JP",
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
