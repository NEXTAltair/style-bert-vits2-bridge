import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

// Published 2026.10.4 still requires the sync hook. Current main prefers the
// async hook; derive its context from the real SDK, and retain both entrypoints.
export function speechConfiguredHooks(check: SpeechProviderPlugin["isConfigured"]) {
  return {
    isConfigured: check,
    isConfiguredAsync: async (context: Parameters<typeof check>[0]) => check(context),
  };
}
