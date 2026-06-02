/**
 * Minimal type stubs for openclaw/plugin-sdk.
 * These will be replaced by the real SDK types once the plugin
 * is installed into an OpenClaw environment.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";

  interface OpenClawLogger {
    debug?: (message: string, data?: unknown) => void;
    info?: (message: string, data?: unknown) => void;
  }

  interface OpenClawPluginApi {
    logger?: OpenClawLogger;
    registerSpeechProvider(provider: SpeechProviderPlugin): void;
  }

  interface PluginEntryOptions {
    id: string;
    name: string;
    description?: string;
    register: (api: OpenClawPluginApi) => void;
  }

  export function definePluginEntry(options: PluginEntryOptions): PluginEntryOptions;
}

declare module "openclaw/plugin-sdk/speech" {
  /** Provider-specific config from messages.tts.providers.<id> */
  export type SpeechProviderConfig = Record<string, unknown>;

  export interface SpeechProviderOverrides {
    [key: string]: unknown;
  }

  export interface SpeechSynthesizeRequest {
    text: string;
    providerConfig: SpeechProviderConfig;
    providerOverrides?: SpeechProviderOverrides;
    target?: string;
    timeoutMs?: number;
  }

  export interface SpeechSynthesizeResult {
    audioBuffer: Buffer;
    outputFormat: string;
    fileExtension: string;
    voiceCompatible: boolean;
    metadata?: Record<string, unknown>;
  }

  export interface SpeechDirectiveTokenParseContext {
    key: string;
    value: string;
    policy: Record<string, boolean>;
    currentOverrides?: SpeechProviderOverrides;
  }

  export interface SpeechDirectiveTokenParseResult {
    handled: boolean;
    overrides?: SpeechProviderOverrides;
    warnings?: string[];
  }

  export interface SpeechProviderPlugin {
    id: string;
    label: string;
    autoSelectOrder?: number;
    models?: readonly string[];
    capabilities?: {
      text?: {
        maxInputChars?: number;
      };
    };
    resolveCapabilities?: (ctx: {
      providerConfig?: SpeechProviderConfig;
      apiKey?: string;
      baseUrl?: string;
    }) => Promise<{
      text?: {
        maxInputChars?: number;
      };
    }>;
    resolveConfig?: (ctx: { rawConfig: Record<string, unknown> }) => unknown;
    parseDirectiveToken?: (
      ctx: SpeechDirectiveTokenParseContext,
    ) => SpeechDirectiveTokenParseResult | undefined;
    resolveTalkConfig?: (ctx: {
      baseTtsConfig: Record<string, unknown>;
      talkProviderConfig: Record<string, unknown>;
    }) => unknown;
    resolveTalkOverrides?: (ctx: { params: Record<string, unknown> }) => unknown;
    listVoices?: (req: {
      providerConfig?: SpeechProviderConfig;
      apiKey?: string;
      baseUrl?: string;
    }) => Promise<Array<{ id: string; name?: string }>>;
    isConfigured: (ctx: { providerConfig: SpeechProviderConfig }) => boolean;
    synthesize: (req: SpeechSynthesizeRequest) => Promise<SpeechSynthesizeResult>;
  }
}
