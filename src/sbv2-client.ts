export interface Sbv2SynthesizeParams {
  text: string;
  encoding?: string;
  modelName?: string;
  modelId?: number;
  speakerName?: string;
  speakerId?: number;
  sdpRatio?: number;
  noise?: number;
  noisew?: number;
  length?: number;
  language?: "JP" | "EN" | "ZH";
  autoSplit?: boolean;
  splitInterval?: number;
  assistText?: string;
  assistTextWeight?: number;
  style?: string;
  styleWeight?: number;
}

export interface Sbv2ClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export interface Sbv2ModelInfo {
  id?: number;
  name?: string;
  modelName?: string;
  model_name?: string;
  configPath?: string;
  config_path?: string;
  modelPath?: string;
  model_path?: string;
  spk2id?: Record<string, number>;
  id2spk?: Record<string, string>;
  style2id?: Record<string, number>;
  [key: string]: unknown;
}

/** Maps camelCase param keys to the snake_case query params SBV2 expects. */
const PARAM_KEY_MAP: Record<string, string> = {
  modelName: "model_name",
  modelId: "model_id",
  speakerName: "speaker_name",
  speakerId: "speaker_id",
  sdpRatio: "sdp_ratio",
  assistText: "assist_text",
  assistTextWeight: "assist_text_weight",
  autoSplit: "auto_split",
  splitInterval: "split_interval",
  styleWeight: "style_weight",
};

export class Sbv2Client {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: Sbv2ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async synthesize(params: Sbv2SynthesizeParams): Promise<Buffer> {
    const url = new URL("/voice", this.baseUrl);

    // SBV2 requires encoding=utf-8 to properly URL-decode non-ASCII text
    const effective = { encoding: "utf-8", ...params };

    for (const [key, value] of Object.entries(effective)) {
      if (value === undefined || value === null) continue;
      const queryKey = PARAM_KEY_MAP[key] ?? key;
      url.searchParams.set(queryKey, String(value));
    }

    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `SBV2 /voice failed: ${response.status} ${response.statusText} – ${body}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async getModelsInfo(): Promise<Sbv2ModelInfo[]> {
    const url = new URL("/models/info", this.baseUrl);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`SBV2 /models/info request failed: ${formatError(error)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `SBV2 /models/info failed: ${response.status} ${response.statusText} – ${body}`,
      );
    }

    const payload = await response.json();
    return normalizeModelsInfo(payload);
  }
}

function normalizeModelsInfo(payload: unknown): Sbv2ModelInfo[] {
  if (Array.isArray(payload)) {
    const models = payload.filter(isRecord);
    return models.map((model) => ({ ...model }));
  }

  if (!isRecord(payload)) {
    throw new Error("SBV2 /models/info returned an unexpected payload");
  }

  return Object.entries(payload).flatMap(([name, value]) => {
    if (!isRecord(value)) return [];
    return [{ name, ...value }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
