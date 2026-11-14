import { describe, expect, it } from "vitest";
import type { Sbv2ModelInfo } from "./sbv2-client.js";
import {
  DEFAULT_VOICE_PROFILE,
  listVoiceProfiles,
  parseVoiceDirectiveToken,
  resolveVoiceProfile,
} from "./voice-resolver.js";

const modelInfo: Sbv2ModelInfo[] = [
  {
    name: "sample_voice",
    speakers: [{ id: 0, name: "sample_voice" }],
    styles: [{ id: 0, name: "00_Neutral" }],
    raw: {},
  },
  {
    name: "custom-model",
    speakers: [{ id: 1, name: "custom-speaker" }],
    styles: [{ id: 0, name: "Neutral" }],
    raw: {},
  },
];

function client(models = modelInfo) {
  return {
    getModelsInfo: async () => models,
  };
}

describe("resolveVoiceProfile", () => {
  it("resolves the first loaded model from /models/info without explicit config", async () => {
    expect(DEFAULT_VOICE_PROFILE).toEqual({
      voiceId: "default",
      language: "JP",
    });

    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {},
      }),
    ).resolves.toEqual({
      voiceId: "default",
      modelName: "sample_voice",
      speakerName: "sample_voice",
      style: "00_Neutral",
      language: "JP",
    });
  });

  it("prefers Neutral over 00_Neutral and falls back to first style when resolving default model", async () => {
    await expect(
      resolveVoiceProfile({
        client: client([
          {
            name: "first-model",
            speakers: [{ id: 0, name: "first-speaker" }],
            styles: [
              { id: 0, name: "Happy" },
              { id: 1, name: "00_Neutral" },
              { id: 2, name: "Neutral" },
            ],
            raw: {},
          },
        ]),
        providerConfig: {},
      }),
    ).resolves.toEqual({
      voiceId: "default",
      modelName: "first-model",
      speakerName: "first-speaker",
      style: "Neutral",
      language: "JP",
    });

    await expect(
      resolveVoiceProfile({
        client: client([
          {
            name: "expressive-only",
            speakers: [],
            styles: [{ id: 0, name: "Calm" }],
            raw: {},
          },
        ]),
        providerConfig: {},
      }),
    ).resolves.toEqual({
      voiceId: "default",
      modelName: "expressive-only",
      style: "Calm",
      language: "JP",
    });

    await expect(
      resolveVoiceProfile({
        client: client([]),
        providerConfig: {},
      }),
    ).rejects.toThrow("SBV2 model could not be resolved from the selected voice profile");
  });

  it("lets provider config defaults override bridge defaults", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          defaultModelName: "custom-model",
          defaultSpeakerName: "custom-speaker",
          defaultStyle: "Neutral",
          defaultSdpRatio: 0.15,
          defaultNoise: 0.45,
          defaultNoisew: 0.55,
        },
      }),
    ).resolves.toMatchObject({
      modelName: "custom-model",
      speakerName: "custom-speaker",
      style: "Neutral",
      sdpRatio: 0.15,
      noise: 0.45,
      noisew: 0.55,
    });
  });

  it("lets per-request overrides beat provider config defaults except low-level inference knobs", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          defaultModelName: "custom-model",
          defaultSpeakerName: "custom-speaker",
          defaultStyle: "Neutral",
          defaultSdpRatio: 0.15,
          defaultNoise: 0.45,
          defaultNoisew: 0.55,
        },
        providerOverrides: {
          modelName: "sample_voice",
          speakerName: "sample_voice",
          style: "00_Neutral",
          styleWeight: 0.7,
          sdpRatio: 0.1,
          noise: 0.35,
          noisew: 0.45,
          assistText: "bright",
        },
      }),
    ).resolves.toMatchObject({
      modelName: "sample_voice",
      speakerName: "sample_voice",
      style: "00_Neutral",
      styleWeight: 0.7,
      sdpRatio: 0.15,
      noise: 0.45,
      noisew: 0.55,
      assistText: "bright",
    });
  });

  it("applies emotion context between provider defaults and explicit request overrides", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          defaultModelName: "custom-model",
          defaultSpeakerName: "custom-speaker",
          defaultStyle: "Neutral",
        },
        providerContextOverrides: {
          modelName: "sample_voice",
          speakerName: "sample_voice",
          style: "00_Neutral",
        },
        providerOverrides: {
          style: "00_Neutral",
          styleWeight: 0.7,
        },
      }),
    ).resolves.toMatchObject({
      modelName: "sample_voice",
      speakerName: "sample_voice",
      style: "00_Neutral",
      styleWeight: 0.7,
    });
  });

  it("supports legacy README config keys", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          modelName: "custom-model",
          speakerName: "custom-speaker",
          style: "Neutral",
        },
      }),
    ).resolves.toMatchObject({
      modelName: "custom-model",
      speakerName: "custom-speaker",
      style: "Neutral",
    });
  });

  it("honors modelId-only config without keeping the hard-default model name", async () => {
    const result = await resolveVoiceProfile({
      client: client([
        {
          id: 2,
          sourceId: "2",
          name: "numeric-model",
          speakers: [{ id: 0, name: "numeric-speaker" }],
          styles: [],
          raw: {},
        },
      ]),
      providerConfig: {
        defaultModelId: 2,
        defaultSpeakerName: "numeric-speaker",
      },
    });

    expect(result).toMatchObject({
      modelId: 2,
      speakerName: "numeric-speaker",
    });
    expect(result.modelName).toBeUndefined();
    expect(result.style).toBeUndefined();
  });

  it("honors speakerId-only overrides without keeping stale speaker names", async () => {
    const result = await resolveVoiceProfile({
      client: client([
        {
          name: "sample_voice",
          speakers: [
            { id: 0, name: "sample_voice" },
            { id: 1, name: "second-speaker" },
          ],
          styles: [{ id: 0, name: "00_Neutral" }],
          raw: {},
        },
      ]),
      providerConfig: {},
      providerOverrides: {
        speakerId: 1,
      },
    });

    expect(result.speakerId).toBe(1);
    expect(result.speakerName).toBeUndefined();
    expect(result.style).toBe("00_Neutral");
  });

  it("preserves style when only the speaker changes", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          defaultModelName: "custom-model",
          defaultStyle: "Neutral",
        },
        providerOverrides: {
          speakerName: "custom-speaker",
        },
      }),
    ).resolves.toMatchObject({
      modelName: "custom-model",
      speakerName: "custom-speaker",
      style: "Neutral",
    });
  });

  it("matches modelId against normalized model ids and numeric source ids", async () => {
    const result = await resolveVoiceProfile({
      client: client([
        {
          id: 2,
          sourceId: "2",
          name: "sparse-model",
          speakers: [{ id: 0, name: "sparse-speaker" }],
          styles: [],
          raw: {},
        },
      ]),
      providerConfig: {},
      providerOverrides: {
        modelId: 2,
        speakerName: "sparse-speaker",
      },
    });

    expect(result).toMatchObject({
      modelId: 2,
      speakerName: "sparse-speaker",
    });
    expect(result.modelName).toBeUndefined();
    expect(result.style).toBeUndefined();
  });

  it("rejects unknown voice profiles", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {},
        providerOverrides: { voiceId: "missing" },
      }),
    ).rejects.toThrow('SBV2 voice profile "missing" is not available');
  });

  it("rejects malformed selectable SBV2 voice ids", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {},
        providerOverrides: { voiceId: "sbv2:" },
      }),
    ).rejects.toThrow('Malformed SBV2 voice ID "sbv2:"');
  });

  it("rejects unavailable model, speaker, and style values", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: { modelName: "missing" },
      }),
    ).rejects.toThrow('SBV2 model "missing" was not found in /models/info');

    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          modelName: "custom-model",
          speakerName: "missing",
          style: "Neutral",
        },
      }),
    ).rejects.toThrow('SBV2 speaker "missing" is not available for model "custom-model"');

    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          modelName: "custom-model",
          speakerName: "custom-speaker",
          style: "missing",
        },
      }),
    ).rejects.toThrow('SBV2 style "missing" is not available for model "custom-model"');
  });
});

describe("voice resolver helpers", () => {
  it("lists voices from model and speaker metadata", () => {
    expect(listVoiceProfiles(modelInfo)).toEqual([
      {
        id: "sbv2:custom-model:custom-speaker:Neutral",
        name: "custom-speaker (custom-model)",
      },
      {
        id: "sbv2:sample_voice:sample_voice:00_Neutral",
        name: "sample_voice (sample_voice)",
      },
    ]);
  });

  it("lists selectable SBV2 IDs for speakerless and styleless models", () => {
    expect(
      listVoiceProfiles([
        {
          name: "speakerless",
          speakers: [],
          styles: [{ id: 0, name: "Neutral" }],
          raw: {},
        },
        {
          name: "styleless",
          speakers: [{ id: 0, name: "alice" }],
          styles: [],
          raw: {},
        },
      ]),
    ).toEqual([
      { id: "sbv2:styleless:alice", name: "alice (styleless)" },
      { id: "sbv2:speakerless::Neutral", name: "speakerless" },
    ]);
  });

  it("prefers Neutral styles when building selectable voice ids", () => {
    expect(
      listVoiceProfiles([
        {
          name: "demo",
          speakers: [{ id: 0, name: "alice" }],
          styles: [
            { id: 1, name: "Happy" },
            { id: 0, name: "Neutral" },
          ],
          raw: {},
        },
      ]),
    ).toEqual([{ id: "sbv2:demo:alice:Neutral", name: "alice (demo)" }]);
  });

  it("parses whitelisted directive tokens under policy controls", () => {
    expect(
      parseVoiceDirectiveToken({
        key: "noise",
        value: "0.45",
        policy: { allowVoiceSettings: true },
      }),
    ).toBeUndefined();

    expect(
      parseVoiceDirectiveToken({
        key: "model_name",
        value: "custom-model",
        policy: { allowModelId: false },
      }),
    ).toBeUndefined();

    expect(
      parseVoiceDirectiveToken({
        key: "voiceId",
        value: "sbv2:demo:alice:Neutral",
        policy: { allowVoice: true },
      }),
    ).toEqual({ voiceId: "sbv2:demo:alice:Neutral" });
  });
});
