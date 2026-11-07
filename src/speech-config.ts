import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

type SpeechConfiguredContext = Parameters<NonNullable<SpeechProviderPlugin["isConfiguredAsync"]>>[0];

// The host prefers isConfiguredAsync. The SDK still requires the deprecated
// synchronous isConfigured until its removal release (final compatibility day
// 2026-12-31), so supply both from one check typed by the async contract.
export function speechConfiguredHooks(check: (context: SpeechConfiguredContext) => boolean) {
  return {
    isConfigured: check,
    isConfiguredAsync: async (context: SpeechConfiguredContext) => check(context),
  };
}
