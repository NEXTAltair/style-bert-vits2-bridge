// Published 2026.10.4 still requires the sync hook. Current main prefers the
// async hook; derive its context from the real SDK, and retain both entrypoints.
export function speechConfiguredHooks(check) {
    return {
        isConfigured: check,
        isConfiguredAsync: async (context) => check(context),
    };
}
