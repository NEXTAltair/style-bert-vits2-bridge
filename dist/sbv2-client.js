/** Maps camelCase param keys to the snake_case query params SBV2 expects. */
const PARAM_KEY_MAP = {
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
    baseUrl;
    timeoutMs;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }
    async synthesize(params) {
        const url = new URL("/voice", this.baseUrl);
        // SBV2 requires encoding=utf-8 to properly URL-decode non-ASCII text
        const effective = { encoding: "utf-8", ...params };
        for (const [key, value] of Object.entries(effective)) {
            if (value === undefined || value === null)
                continue;
            const queryKey = PARAM_KEY_MAP[key] ?? key;
            url.searchParams.set(queryKey, String(value));
        }
        const response = await fetch(url, {
            method: "POST",
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`SBV2 /voice failed: ${response.status} ${response.statusText} – ${body}`);
        }
        return Buffer.from(await response.arrayBuffer());
    }
    async getModelsInfo() {
        const url = new URL("/models/info", this.baseUrl);
        let response;
        try {
            response = await fetch(url, {
                method: "GET",
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (error) {
            throw new Error(`SBV2 /models/info request failed: ${formatError(error)}`);
        }
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`SBV2 /models/info failed: ${response.status} ${response.statusText} – ${body}`);
        }
        const payload = await response.json();
        return normalizeModelsInfo(payload);
    }
}
function normalizeModelsInfo(payload) {
    if (Array.isArray(payload)) {
        const models = payload.filter(isRecord);
        return models.map((model) => ({ ...model }));
    }
    if (!isRecord(payload)) {
        throw new Error("SBV2 /models/info returned an unexpected payload");
    }
    return Object.entries(payload).flatMap(([name, value]) => {
        if (!isRecord(value))
            return [];
        const numericId = /^\d+$/.test(name) ? Number(name) : undefined;
        return [
            {
                sourceId: name,
                id: typeof value.id === "number" ? value.id : numericId,
                ...(numericId === undefined ? { name } : {}),
                ...value,
            },
        ];
    });
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
