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
}
