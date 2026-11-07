// The host prefers isConfiguredAsync. The SDK still requires the deprecated
// synchronous isConfigured until its removal release (final compatibility day
// 2026-12-31), so supply both from one check typed by the async contract.
export function speechConfiguredHooks(check) {
    return {
        isConfigured: check,
        isConfiguredAsync: async (context) => check(context),
    };
}
