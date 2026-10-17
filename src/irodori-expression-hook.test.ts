import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerIrodoriExpressionHook } from "./irodori-expression-hook.js";
import { IRODORI_EXPRESSIONS } from "./irodori-expressions.js";

type Hook = (event: { prompt: string; messages: unknown[] }, ctx: {
  agentId?: string; sessionKey?: string; channel?: string; accountId?: string; trigger?: string;
  hookInvocation?: { assertActive: () => void };
}) => Promise<{ appendSystemContext: string } | undefined>;
const ready = { version: 1, ready: true, auto: "always", provider: "irodori", model: "irodori-tts", allowText: true, maxLength: 400 };
function fixture(enabled = true, supported = true) {
  const prepare = vi.fn().mockResolvedValue(ready);
  const warn = vi.fn();
  const getSessionEntry = vi.fn().mockReturnValue({ ttsAuto: "tagged" });
  let hook: Hook | undefined;
  const on = vi.fn((name: string, handler: Hook) => { expect(name).toBe("before_prompt_build"); hook = handler; });
  // The fixture supplies only the public operations this registration uses.
  const api = { pluginConfig: { irodoriExpressiveText: enabled }, config: {},
    runtime: { tts: supported ? { prepareSpeechPromptContext: prepare } : {}, agent: { session: { getSessionEntry } } },
    logger: { warn }, on,
  } as unknown as OpenClawPluginApi;
  registerIrodoriExpressionHook(api);
  return { prepare, warn, getSessionEntry, on, run: (ctx = {}) => hook!({ prompt: "Do not read or rewrite this input", messages: [] }, { trigger: "user", ...ctx }) };
}

describe("opt-in Irodori prompt hook", () => {
  it("has no prompt hook or state read when disabled", () => {
    const f = fixture(false); expect(f.on).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });
  it("keeps old hosts usable with an actionable capability warning", () => {
    const f = fixture(true, false); expect(f.on).not.toHaveBeenCalled(); expect(f.warn).toHaveBeenCalledWith(expect.stringContaining("prepareSpeechPromptContext"));
  });
  it("uses host-owned selection and all documented annotations without touching messages", async () => {
    const f = fixture(); const result = await f.run({ agentId: "main", sessionKey: "agent:main:test", channel: "webchat", accountId: "example" });
    expect(f.prepare).toHaveBeenCalledWith({ cfg: {}, agentId: "main", channelId: "webchat", accountId: "example", sessionAuto: "tagged" });
    for (const [emoji, meaning] of IRODORI_EXPRESSIONS) expect(result?.appendSystemContext).toContain(`${emoji}: ${meaning}`);
    expect(result?.appendSystemContext).not.toContain("Do not read or rewrite this input");
  });
  it("defers to structured voiceText instead of unconditionally requesting inline tags", async () => {
    const result = await fixture().run();
    expect(result?.appendSystemContext).toContain("If the host requires structured/message-tool delivery");
    expect(result?.appendSystemContext).toContain("voiceText");
    expect(result?.appendSystemContext).toContain("Only on an inline-reply route");
  });
  it("does not retain a previous Irodori decision after the selected model changes to Qwen", async () => {
    const f = fixture(); expect(await f.run()).toBeDefined();
    f.prepare.mockResolvedValue({ ...ready, provider: "speech-cpp", model: "qwen3-tts-1.7b" });
    expect(await f.run()).toBeUndefined();
    f.prepare.mockResolvedValue({ ...ready, provider: "speech-cpp", model: "irodori-tts-mf" });
    expect(await f.run()).toBeDefined();
  });
  it.each([{ ready: false }, { auto: "off" }, { auto: "inbound" }, { allowText: false }, { version: 2 }, { maxLength: -1 }, { maxLength: NaN }, { provider: "style-bert-vits2" }])("fails closed for %j", async (patch) => {
    const f = fixture(); f.prepare.mockResolvedValue({ ...ready, ...patch }); expect(await f.run()).toBeUndefined();
  });
  it("does not add speech generation guidance to background maintenance", async () => {
    const f = fixture(); for (const trigger of [undefined, "heartbeat", "cron", "event", "manual", "memory", "overflow", "unknown"]) expect(await f.run({ trigger })).toBeUndefined();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("does not publish a prompt after the owning invocation ends", async () => {
    const f = fixture(); const assertActive = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("ended"); });
    expect(await f.run({ hookInvocation: { assertActive } })).toBeUndefined();
  });
  it("never includes private error details in its warning and warns at most once", async () => {
    const f = fixture(); f.prepare.mockRejectedValue(new Error("private-text credential-value /home/private"));
    expect(await f.run()).toBeUndefined(); expect(await f.run()).toBeUndefined();
    expect(f.warn).toHaveBeenCalledTimes(1);
    for (const secret of ["credential-value", "private-text", "/home/private"]) {
      expect(JSON.stringify(f.warn.mock.calls)).not.toContain(secret);
    }
  });
});
