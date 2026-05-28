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
    name: "valentina01_bright",
    speakers: [{ id: 0, name: "valentina01_bright" }],
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
  it("resolves the Valentina hard default without explicit config", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {},
      }),
    ).resolves.toEqual(DEFAULT_VOICE_PROFILE);
  });

  it("lets provider config defaults override bridge hard defaults", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          defaultModelName: "custom-model",
          defaultSpeakerName: "custom-speaker",
          defaultStyle: "Neutral",
        },
      }),
    ).resolves.toMatchObject({
      modelName: "custom-model",
      speakerName: "custom-speaker",
      style: "Neutral",
    });
  });

  it("lets per-request overrides beat provider config defaults", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {
          defaultModelName: "custom-model",
          defaultSpeakerName: "custom-speaker",
          defaultStyle: "Neutral",
        },
        providerOverrides: {
          modelName: "valentina01_bright",
          speakerName: "valentina01_bright",
          style: "00_Neutral",
          styleWeight: 0.7,
          assistText: "bright",
        },
      }),
    ).resolves.toMatchObject({
      modelName: "valentina01_bright",
      speakerName: "valentina01_bright",
      style: "00_Neutral",
      styleWeight: 0.7,
      assistText: "bright",
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

  it("rejects unknown voice profiles", async () => {
    await expect(
      resolveVoiceProfile({
        client: client(),
        providerConfig: {},
        providerOverrides: { voiceId: "missing" },
      }),
    ).rejects.toThrow('SBV2 voice profile "missing" is not available');
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
        id: "valentina01_bright:valentina01_bright",
        name: "valentina01_bright (valentina01_bright)",
      },
      {
        id: "custom-model:custom-speaker",
        name: "custom-speaker (custom-model)",
      },
    ]);
  });

  it("parses whitelisted directive tokens under policy controls", () => {
    expect(
      parseVoiceDirectiveToken({
        key: "style_weight",
        value: "0.75",
        policy: { allowVoiceSettings: true },
      }),
    ).toEqual({ styleWeight: 0.75 });

    expect(
      parseVoiceDirectiveToken({
        key: "model_name",
        value: "custom-model",
        policy: { allowModelId: false },
      }),
    ).toBeUndefined();
  });
});
