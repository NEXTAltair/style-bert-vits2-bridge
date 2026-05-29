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

export interface Sbv2NamedItem {
  id?: number;
  name: string;
}

export interface Sbv2ModelInfo {
  id?: number;
  sourceId?: string;
  name: string;
  modelName?: string;
  model_name?: string;
  configPath?: string;
  config_path?: string;
  modelPath?: string;
  model_path?: string;
  spk2id?: Record<string, number>;
  id2spk?: Record<string, string>;
  speaker2id?: Record<string, number>;
  speaker2Id?: Record<string, number>;
  speaker_map?: Record<string, number>;
  speakerMap?: Record<string, number>;
  style2id?: Record<string, number>;
  style2Id?: Record<string, number>;
  id2style?: Record<string, string>;
  style_map?: Record<string, number>;
  styleMap?: Record<string, number>;
  speakers: Sbv2NamedItem[];
  styles: Sbv2NamedItem[];
  raw: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWavBuffer(value: Buffer): boolean {
  return (
    value.length >= 12 &&
    value.toString("ascii", 0, 4) === "RIFF" &&
    value.toString("ascii", 8, 12) === "WAVE"
  );
}

function modelNameFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2) return undefined;
  return segments[segments.length - 2];
}

function normalizeNamedCollection(value: unknown): Sbv2NamedItem[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index): Sbv2NamedItem[] => {
      if (typeof item === "string" && item.trim()) {
        return [{ id: index, name: item.trim() }];
      }

      if (!isRecord(item)) {
        return [];
      }

      const name =
        asNonEmptyString(item.name) ??
        asNonEmptyString(item.speaker_name) ??
        asNonEmptyString(item.speakerName) ??
        asNonEmptyString(item.style_name) ??
        asNonEmptyString(item.styleName);

      if (!name) {
        return [];
      }

      const id =
        asFiniteNumber(item.id) ??
        asFiniteNumber(item.speaker_id) ??
        asFiniteNumber(item.speakerId) ??
        asFiniteNumber(item.style_id) ??
        asFiniteNumber(item.styleId) ??
        index;

      return [{ id, name }];
    });
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([name, id]): Sbv2NamedItem[] => {
      const trimmed = name.trim();

      if (typeof id === "string" && id.trim()) {
        const numericId = Number(trimmed);
        return [{ id: Number.isFinite(numericId) ? numericId : undefined, name: id.trim() }];
      }

      if (!trimmed) {
        return [];
      }

      return [{ id: asFiniteNumber(id), name: trimmed }];
    });
  }

  return [];
}

function normalizeModelInfoEntry(nameHint: string | undefined, value: unknown): Sbv2ModelInfo | undefined {
  if (!isRecord(value)) {
    return nameHint
      ? { name: nameHint, sourceId: nameHint, speakers: [], styles: [], raw: value }
      : undefined;
  }

  const numericId = nameHint && /^\d+$/.test(nameHint) ? Number(nameHint) : undefined;
  const modelName =
    asNonEmptyString(value.model_name) ??
    asNonEmptyString(value.modelName) ??
    modelNameFromPath(asNonEmptyString(value.configPath) ?? asNonEmptyString(value.config_path)) ??
    modelNameFromPath(asNonEmptyString(value.modelPath) ?? asNonEmptyString(value.model_path)) ??
    asNonEmptyString(value.name) ??
    (numericId === undefined ? nameHint : undefined);

  if (!modelName) {
    return undefined;
  }

  const speakers = normalizeNamedCollection(
    value.speakers ??
      value.speaker2id ??
      value.speaker2Id ??
      value.spk2id ??
      value.id2speaker ??
      value.id2spk ??
      value.speaker_map ??
      value.speakerMap,
  );
  const styles = normalizeNamedCollection(
    value.styles ??
      value.style2id ??
      value.style2Id ??
      value.id2style ??
      value.style_map ??
      value.styleMap,
  );

  return {
    sourceId: nameHint,
    id: asFiniteNumber(value.id) ?? numericId,
    ...(value as Record<string, unknown>),
    name: modelName,
    speakers,
    styles,
    raw: value,
  } as Sbv2ModelInfo;
}

export function normalizeModelsInfo(value: unknown): Sbv2ModelInfo[] {
  const modelsValue = isRecord(value) && Array.isArray(value.models) ? value.models : value;
  const models = Array.isArray(modelsValue)
    ? modelsValue.flatMap((item): Sbv2ModelInfo[] => {
        const model = normalizeModelInfoEntry(undefined, item);
        return model ? [model] : [];
      })
    : isRecord(modelsValue)
      ? Object.entries(modelsValue).flatMap(([name, item]): Sbv2ModelInfo[] => {
          const model = normalizeModelInfoEntry(name, item);
          return model ? [model] : [];
        })
      : [];

  if (!models.length) {
    throw new Error("SBV2 /models/info returned an unsupported model list shape");
  }

  return models;
}

export class Sbv2Client {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: Sbv2ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
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
        `SBV2 /models/info failed: ${response.status} ${response.statusText} - ${body}`,
      );
    }

    return normalizeModelsInfo(await response.json());
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
        `SBV2 /voice failed: ${response.status} ${response.statusText} - ${body}`,
      );
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!isWavBuffer(audio)) {
      throw new Error(`SBV2 /voice returned a non-WAV response (${audio.length} bytes)`);
    }

    return audio;
  }
}
