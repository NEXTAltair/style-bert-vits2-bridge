import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { buildIrodoriExpressionPrompt, type IrodoriExpressionContext } from "./irodori-expressions.js";

function readContext(value: unknown): IrodoriExpressionContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || raw.ready !== true || typeof raw.provider !== "string"
      || typeof raw.allowText !== "boolean" || typeof raw.maxLength !== "number"
      || !Number.isSafeInteger(raw.maxLength) || raw.maxLength <= 0
      || !["off", "always", "inbound", "tagged"].includes(String(raw.auto))
      || (raw.model !== undefined && typeof raw.model !== "string")) return undefined;
  // This SDK snapshot does not attest that this turn contained inbound audio.
  // Preserve ordinary inbound-mode TTS but do not add speculative generation hints.
  if (raw.auto === "inbound") return undefined;
  return {
    provider: raw.provider, model: raw.model as string | undefined,
    auto: raw.auto as IrodoriExpressionContext["auto"], allowText: raw.allowText,
    maxLength: raw.maxLength, speechEligible: true,
  };
}

export function registerIrodoriExpressionHook(api: OpenClawPluginApi): void {
  if (api.pluginConfig?.irodoriExpressiveText !== true) return;
  const runtime = api.runtime.tts;
  // A versioned optional host capability, not a plugin-owned replica of TTS routing.
  // The published 2026.10.4 SDK predates it; keep ordinary synthesis working there.
  if (!("prepareSpeechPromptContext" in runtime)
      || typeof runtime.prepareSpeechPromptContext !== "function") {
    api.logger.warn("Irodori expressive text is enabled but this host lacks api.runtime.tts.prepareSpeechPromptContext; update the host capability. Ordinary speech is unchanged.");
    return;
  }
  const prepare = runtime.prepareSpeechPromptContext.bind(runtime);
  let warned = false;
  api.on("before_prompt_build", async (_event, ctx) => {
    // Unknown/internal turns are not permission to generate an audible reply.
    if (ctx.trigger !== "user") return;
    try {
      ctx.hookInvocation?.assertActive();
      const session = ctx.sessionKey
        ? api.runtime.agent.session.getSessionEntry({ agentId: ctx.agentId, sessionKey: ctx.sessionKey })
        : undefined;
      const raw: unknown = await prepare({
        cfg: api.config, agentId: ctx.agentId,
        channelId: ctx.channel ?? ctx.messageProvider, accountId: ctx.accountId,
        sessionAuto: session?.ttsAuto,
      });
      ctx.hookInvocation?.assertActive();
      const context = readContext(raw);
      if (!context) return;
      const hint = buildIrodoriExpressionPrompt(context);
      return hint ? { appendSystemContext: hint } : undefined;
    } catch {
      // Never log conversation text, local paths, credentials or raw host errors.
      if (!warned) {
        warned = true;
        api.logger.warn("Irodori expressive text skipped because effective TTS context was unavailable or the prompt invocation ended; ordinary speech is unchanged.");
      }
      return;
    }
  });
}
