import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

type SynthesisRequest = Parameters<SpeechProviderPlugin["synthesize"]>[0];
type DirectiveContext = Parameters<NonNullable<SpeechProviderPlugin["parseDirectiveToken"]>>[0];
type TalkConfigContext = Parameters<NonNullable<SpeechProviderPlugin["resolveTalkConfig"]>>[0];
type TalkOverridesContext = Parameters<NonNullable<SpeechProviderPlugin["resolveTalkOverrides"]>>[0];

// Supply the fields a real host supplies; the SDK owns all request types.
export function speechRequest(
  input: Pick<SynthesisRequest, "text" | "providerConfig"> & Partial<SynthesisRequest>,
): SynthesisRequest {
  return { cfg: {}, target: "audio-file", timeoutMs: 30_000, ...input };
}

export function directiveContext(
  input: Omit<DirectiveContext, "policy"> & { policy: Partial<DirectiveContext["policy"]> },
): DirectiveContext {
  return {
    ...input,
    policy: {
      enabled: true, allowText: true, allowProvider: true, allowVoice: false,
      allowModelId: false, allowVoiceSettings: false, allowNormalization: false,
      allowSeed: false, ...input.policy,
    },
  };
}

export function talkConfigContext(
  input: Pick<TalkConfigContext, "baseTtsConfig" | "talkProviderConfig"> & Partial<TalkConfigContext>,
): TalkConfigContext {
  return { cfg: {}, timeoutMs: 30_000, ...input };
}

export function talkOverridesContext(
  input: Pick<TalkOverridesContext, "params"> & Partial<TalkOverridesContext>,
): TalkOverridesContext {
  return { talkProviderConfig: {}, ...input };
}
