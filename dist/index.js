import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { applyPronunciationReplacements, resolvePronunciationReplacements, } from "./pronunciation.js";
import { SBV2_FALLBACK_VOICE_TEXT_MAX_CHARS, Sbv2Client } from "./sbv2-client.js";
import { listVoiceProfiles, parseVoiceDirectiveToken, resolveVoiceProfile, } from "./voice-resolver.js";
const TOOL_STATUS_REWRITE_TEXT = {
    JP: "コマンドが失敗しました。別の方法で進めます。",
    EN: "The command failed. I will try another way.",
    ZH: "命令执行失败。我会尝试其他方法。",
};
const METADATA_STATUS_REWRITE_TEXT = {
    JP: {
        github_item: "GitHub の項目を更新しました。",
        issue: "GitHub の課題を更新しました。",
        pull_request: "GitHub のプルリクエストを更新しました。",
    },
    EN: {
        github_item: "The GitHub items were updated.",
        issue: "The GitHub issue was updated.",
        pull_request: "The GitHub pull request was updated.",
    },
    ZH: {
        github_item: "GitHub 项目已更新。",
        issue: "GitHub 问题已更新。",
        pull_request: "GitHub 拉取请求已更新。",
    },
};
const COMMAND_STATUS_TOOLS = "(?:gh|git|pnpm|npm|npx|yarn|uv|python(?:\\d+(?:\\.\\d+)*)?|node(?:\\d+(?:\\.\\d+)*)?|bash|sh|tsc|vitest)";
const COMMAND_STATUS_SUBCOMMANDS = [
    "add",
    "api",
    "branch",
    "build",
    "check",
    "checkout",
    "ci",
    "clone",
    "commit",
    "config",
    "dev",
    "diff",
    "dlx",
    "exec",
    "fetch",
    "install",
    "issue",
    "lint",
    "log",
    "merge",
    "pack",
    "pr",
    "publish",
    "pull",
    "push",
    "rebase",
    "remote",
    "remove",
    "repo",
    "reset",
    "restore",
    "run",
    "show",
    "stash",
    "start",
    "status",
    "switch",
    "tag",
    "test",
    "update",
    "upgrade",
    "version",
].join("|");
const COMMAND_STATUS_SCRIPT_PATH = "(?:[a-z0-9:_-]+/[a-z0-9:_./-]+|[a-z0-9:_/-]*[a-z_][a-z0-9_-]*\\.[a-z][a-z0-9]+)";
const COMMAND_STATUS_ARGUMENT = `(?:(?:-{1,2}[a-z][a-z0-9-]*)|(?:[a-z0-9:_./-]+\\s+-{1,2}[a-z][a-z0-9-]*)|(?:${COMMAND_STATUS_SCRIPT_PATH})|(?:(?:${COMMAND_STATUS_SUBCOMMANDS})\\b))`;
const COMMAND_STATUS_COMMAND = `${COMMAND_STATUS_TOOLS}\\s+(?:(?:${COMMAND_STATUS_SUBCOMMANDS})\\b|(?:${COMMAND_STATUS_SCRIPT_PATH}))`;
const GITHUB_ISSUE_OR_PR_URL = "https?:\\/\\/github\\.com\\/[^\\/\\s)>`]+\\/[^\\/\\s)>`]+\\/(issues|pull|pulls)\\/\\d+\\b(?:\\/[^?#\\s)>`]*)?(?:\\?[^#\\s)>`]*)?(?:#[^\\s)>`]+)?";
const MARKDOWN_LINK_TITLE = `(?:"[^"\\n]*"|'[^'\\n]*'|\\([^\\)\\n]*\\))`;
const GITHUB_ISSUE_OR_PR_MARKDOWN_LINK = `\\[([^\\]\\n]*)\\]\\(\\s*${GITHUB_ISSUE_OR_PR_URL}(?:\\s+${MARKDOWN_LINK_TITLE})?\\s*\\)`;
function trimToUndefined(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }
    return undefined;
}
function asSbv2Language(value) {
    const language = trimToUndefined(value);
    return language === "JP" || language === "EN" || language === "ZH" ? language : undefined;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function rateWpmToLength(value) {
    const rateWpm = asNumber(value);
    if (rateWpm === undefined || rateWpm <= 0)
        return undefined;
    return clamp(180 / rateWpm, 0.5, 2);
}
function extractExplicitTtsText(value) {
    const match = value.match(/\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/);
    return match?.[1]?.trim() || undefined;
}
function looksLikeToolStatusText(value) {
    const text = value.trim();
    if (!text)
        return false;
    const hasDiagnosticFailure = /(?:^|\n)\s*(?:error|fatal):|(?:^|\n)\s*npm\s+ERR!|(?:^|\n)\s*ERR_PNPM_[A-Z0-9_]+|(?:^|\n)\s*YN\d{4}:\s*Error\b/i.test(text);
    const hasFailureStatus = /(?:^|\s)(?:failed|exit code\s*:?\s*\d+|command failed)(?:[:.]|$|\s)/i.test(text) ||
        hasDiagnosticFailure;
    if (!hasFailureStatus)
        return false;
    const commandInvocation = new RegExp(`(?:^|\\n)\\s*(?:(?:Error:\\s*)?Command failed(?: with exit code\\s*:?\\s*\\d+)?:\\s*)?(?:[⚠🛠️\\s]+)?${COMMAND_STATUS_TOOLS}\\s+${COMMAND_STATUS_ARGUMENT}`, "i");
    const hasOperatorPrefix = /(?:^|\s)[⚠🛠][\s️]/u.test(text);
    const hasCwdSuffix = /\(\s*in\s+(?:~\/|\/|[A-Za-z]:\\)[^)]+\)/i.test(text);
    const hasCommandFailurePrefix = /(?:^|\n)\s*(?:Error:\s*)?Command failed(?: with exit code\s*:?\s*\d+)?:/i.test(text);
    const hasMultilineError = /\n\s*(?:error|fatal|failed|exit code\s*:?\s*\d+|command failed)(?:[:.]|$|\s)/i.test(text) ||
        hasDiagnosticFailure;
    const hasUndecoratedCommandFailure = new RegExp(`(?:^|\\n)\\s*${COMMAND_STATUS_COMMAND}[^\\n]*\\b(?:failed|exit code\\s*:?\\s*\\d+|command failed)\\b`, "i").test(text);
    return commandInvocation.test(text) && (hasOperatorPrefix || hasCwdSuffix || hasCommandFailurePrefix || hasMultilineError || hasUndecoratedCommandFailure || /\s-{1,2}[a-z][a-z0-9-]*(?:[=\s]|$)/i.test(text));
}
function classifyMetadataStatusText(value) {
    const text = value.trim();
    if (!text)
        return undefined;
    const githubIssueOrPrUrlPattern = new RegExp(GITHUB_ISSUE_OR_PR_URL, "i");
    if (!githubIssueOrPrUrlPattern.test(text))
        return undefined;
    const metadataVerbs = "(?:created|opened|updated|closed|reopened|merged|commented|added|posted)";
    const metadataSubjects = "(?:github\\s+)?(?:issue|pr|pull request)";
    const metadataNumber = "(?:\\s+#?\\d+)?";
    const listPrefix = "(?:(?:[-*+]|\\d+[.)])\\s*)?";
    const terminalPunctuation = "[.。]?";
    const labelFirstMetadataLine = new RegExp(`^${listPrefix}${metadataSubjects}${metadataNumber}(?:\\s+${metadataVerbs})?\\s*[:#-]\\s*${GITHUB_ISSUE_OR_PR_URL}${terminalPunctuation}\\s*$`, "i");
    const verbFirstMetadataLine = new RegExp(`^${listPrefix}${metadataVerbs}\\s+${metadataSubjects}${metadataNumber}\\s*[:#-]\\s*${GITHUB_ISSUE_OR_PR_URL}${terminalPunctuation}\\s*$`, "i");
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length)
        return undefined;
    let kind;
    for (const line of lines) {
        const match = line.match(labelFirstMetadataLine) ?? line.match(verbFirstMetadataLine);
        const resource = match?.[1]?.toLowerCase();
        if (!resource)
            return undefined;
        const lineKind = resource === "issues" ? "issue" : "pull_request";
        kind ??= lineKind;
        if (kind !== lineKind)
            kind = "github_item";
    }
    return kind;
}
function cleanupSpeechLineAfterUrlRemoval(value) {
    return value
        .replace(/^\(\s*\)$/, "")
        .replace(/^\[\s*\]$/, "")
        .replace(/<\s*>/g, "")
        .replace(/`+\s*`+/g, "")
        .replace(/\s+([。、，,.!?！？:;])/g, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^#{1,6}\s*$/, "")
        .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^(?:[-*+]|\d+[.)])\s*$/, "")
        .replace(/^([*_]{1,3})(.+)\1$/, "$2")
        .replace(/^(?:[*_]\s*){2,}$/, "")
        .replace(/^[<>`]+$/, "")
        .replace(/^[、。，,.!?！？:;]+$/, "")
        .trim();
}
function looksLikeGithubMetadataLabelRemainder(value) {
    return /^(?:(?:[-*+]|\d+[.)])\s*)?(?:(?:created|opened|updated|closed|reopened|merged|commented|added|posted)\s+)?(?:github\s+)?(?:issue|pr|pull request)(?:(?:\s+#?\d+)|(?:\s*[:#-]\s*#?\d+))?(?:\s+(?:created|opened|updated|closed|reopened|merged|commented|added|posted))?\s*[:#-]?\s*[、。，,.!?！？:;]*\s*$/i.test(value);
}
function looksLikeMarkdownReferenceDefinitionRemainder(value) {
    return new RegExp(`^\\[[^\\]\\n]+\\]:\\s*(?:${MARKDOWN_LINK_TITLE})?\\s*$`).test(value.trim());
}
function collectGithubMarkdownReferenceIds(value) {
    const definitionPattern = new RegExp(`^\\s*\\[([^\\]\\n]+)\\]:\\s*${GITHUB_ISSUE_OR_PR_URL}(?:\\s+${MARKDOWN_LINK_TITLE})?\\s*$`, "gim");
    return new Set(Array.from(value.matchAll(definitionPattern), (match) => match[1].toLowerCase()));
}
function replaceGithubMarkdownReferenceUsages(value, githubReferenceIds) {
    if (!githubReferenceIds.size)
        return value;
    return value.replace(/\[([^\]\n]+)\]\[([^\]\n]+)\]/g, (match, label, id) => githubReferenceIds.has(id.toLowerCase()) ? label.trim() : match);
}
function sanitizeGithubUrlsFromSpeechText(value, language) {
    const githubUrlPattern = new RegExp(GITHUB_ISSUE_OR_PR_URL, "gi");
    const markdownLinkPattern = new RegExp(GITHUB_ISSUE_OR_PR_MARKDOWN_LINK, "gi");
    if (!githubUrlPattern.test(value))
        return undefined;
    let kind;
    const lines = [];
    const githubReferenceIds = collectGithubMarkdownReferenceIds(value);
    for (const line of value.split(/\r?\n/)) {
        githubUrlPattern.lastIndex = 0;
        const matches = Array.from(line.matchAll(githubUrlPattern));
        if (!matches.length) {
            const lineWithReferenceLabels = cleanupSpeechLineAfterUrlRemoval(replaceGithubMarkdownReferenceUsages(line, githubReferenceIds));
            if (lineWithReferenceLabels)
                lines.push(lineWithReferenceLabels);
            continue;
        }
        for (const match of matches) {
            const resource = match[1]?.toLowerCase();
            const lineKind = resource === "issues" ? "issue" : "pull_request";
            kind ??= lineKind;
            if (kind !== lineKind)
                kind = "github_item";
        }
        githubUrlPattern.lastIndex = 0;
        markdownLinkPattern.lastIndex = 0;
        const lineWithoutLinks = cleanupSpeechLineAfterUrlRemoval(line.replace(markdownLinkPattern, "").replace(githubUrlPattern, ""));
        const lineWithLabels = cleanupSpeechLineAfterUrlRemoval(replaceGithubMarkdownReferenceUsages(line, githubReferenceIds)
            .replace(markdownLinkPattern, (_match, label) => label.trim())
            .replace(githubUrlPattern, ""));
        const sanitizedLine = [lineWithLabels, lineWithoutLinks].find((candidate) => candidate &&
            !looksLikeGithubMetadataLabelRemainder(candidate) &&
            !looksLikeMarkdownReferenceDefinitionRemainder(candidate));
        if (sanitizedLine)
            lines.push(sanitizedLine);
    }
    const sanitizedText = lines.join("\n").trim();
    if (sanitizedText) {
        return { text: sanitizedText, textPreparation: "url_sanitize" };
    }
    if (kind) {
        return {
            text: METADATA_STATUS_REWRITE_TEXT[language ?? "JP"][kind],
            textPreparation: "metadata_status_rewrite",
        };
    }
    return undefined;
}
function prepareSpeechText(value, language) {
    const explicitText = extractExplicitTtsText(value);
    if (explicitText) {
        return { text: explicitText, textPreparation: "explicit" };
    }
    if (looksLikeToolStatusText(value)) {
        return { text: TOOL_STATUS_REWRITE_TEXT[language ?? "JP"], textPreparation: "tool_status_rewrite" };
    }
    const metadataStatusKind = classifyMetadataStatusText(value);
    if (metadataStatusKind) {
        return {
            text: METADATA_STATUS_REWRITE_TEXT[language ?? "JP"][metadataStatusKind],
            textPreparation: "metadata_status_rewrite",
        };
    }
    const sanitizedText = sanitizeGithubUrlsFromSpeechText(value, language);
    if (sanitizedText)
        return sanitizedText;
    return { text: value };
}
function parseSbv2VoiceId(value) {
    const raw = trimToUndefined(value);
    if (!raw?.startsWith("sbv2:"))
        return undefined;
    const [, encodedModelName, encodedSpeakerName, encodedStyle] = raw.split(":");
    if (!encodedModelName)
        return undefined;
    try {
        return {
            modelName: decodeURIComponent(encodedModelName),
            speakerName: encodedSpeakerName ? decodeURIComponent(encodedSpeakerName) : undefined,
            style: encodedStyle ? decodeURIComponent(encodedStyle) : undefined,
        };
    }
    catch {
        return undefined;
    }
}
function normalizeOverrides(overrides) {
    const selectedVoiceId = trimToUndefined(overrides?.voiceId) ?? trimToUndefined(overrides?.voice);
    const selectedVoice = parseSbv2VoiceId(selectedVoiceId);
    if (selectedVoiceId?.startsWith("sbv2:") && !selectedVoice) {
        throw new Error(`Malformed SBV2 voice ID "${selectedVoiceId}"`);
    }
    if (!selectedVoice)
        return overrides;
    const { voiceId: _voiceId, voice: _voice, ...rest } = overrides ?? {};
    return { voiceId: selectedVoiceId, ...selectedVoice, ...rest };
}
function sanitizeBaseUrl(value) {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return "<invalid baseUrl>";
    }
}
function readVoiceContext(config, overrides) {
    return {
        voiceId: trimToUndefined(overrides?.voiceId) ?? trimToUndefined(overrides?.voice),
        modelName: trimToUndefined(overrides?.modelName) ??
            trimToUndefined(overrides?.model) ??
            trimToUndefined(config.defaultModelName) ??
            trimToUndefined(config.modelName),
        modelId: asNumber(overrides?.modelId) ?? asNumber(config.defaultModelId) ?? asNumber(config.modelId),
        speakerName: trimToUndefined(overrides?.speakerName) ??
            trimToUndefined(overrides?.speaker) ??
            trimToUndefined(config.defaultSpeakerName) ??
            trimToUndefined(config.speakerName),
        speakerId: asNumber(overrides?.speakerId) ??
            asNumber(config.defaultSpeakerId) ??
            asNumber(config.speakerId),
        style: trimToUndefined(overrides?.style) ??
            trimToUndefined(config.defaultStyle) ??
            trimToUndefined(config.style),
        styleWeight: asNumber(overrides?.styleWeight) ??
            asNumber(config.defaultStyleWeight) ??
            asNumber(config.styleWeight),
        sdpRatio: asNumber(overrides?.sdpRatio) ??
            asNumber(config.defaultSdpRatio) ??
            asNumber(config.sdpRatio),
        noise: asNumber(overrides?.noise) ??
            asNumber(config.defaultNoise) ??
            asNumber(config.noise),
        noisew: asNumber(overrides?.noisew) ??
            asNumber(config.defaultNoisew) ??
            asNumber(config.noisew),
        length: asNumber(overrides?.length) ??
            asNumber(config.defaultLength) ??
            asNumber(config.length),
        language: asSbv2Language(overrides?.language) ??
            asSbv2Language(config.defaultLanguage) ??
            asSbv2Language(config.language),
    };
}
function buildTelemetryMetadata(args) {
    const { resolvedVoice } = args;
    const metadata = {
        provider: "style-bert-vits2",
        baseUrl: sanitizeBaseUrl(args.baseUrl),
        voiceId: resolvedVoice.voiceId,
        modelName: resolvedVoice.modelName,
        modelId: resolvedVoice.modelId,
        speakerName: resolvedVoice.speakerName,
        speakerId: resolvedVoice.speakerId,
        style: resolvedVoice.style,
        styleWeight: resolvedVoice.styleWeight,
        sdpRatio: resolvedVoice.sdpRatio,
        noise: resolvedVoice.noise,
        noisew: resolvedVoice.noisew,
        length: resolvedVoice.length,
        language: resolvedVoice.language,
        outputFormat: "wav",
        audioBytes: args.audioBytes,
    };
    if (args.textPreparation)
        metadata.textPreparation = args.textPreparation;
    return metadata;
}
function formatTelemetryContext(metadata) {
    const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}
function withTelemetryContext(error, metadata) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message}. SBV2 telemetry context: ${formatTelemetryContext(metadata)}`);
}
function assertSbv2TextWithinHardLimit(text, maxInputChars) {
    if (maxInputChars === undefined)
        return;
    const textChars = Array.from(text).length;
    if (textChars <= maxInputChars)
        return;
    throw new Error(`SBV2 /voice text is too long: ${textChars} chars exceeds provider hard limit ${maxInputChars}. ` +
        "Prepare shorter spoken text before synthesis.");
}
export function buildSbv2SpeechProvider(options = {}) {
    return {
        id: "style-bert-vits2",
        label: "Style-Bert-VITS2",
        capabilities: {
            text: {
                maxInputChars: SBV2_FALLBACK_VOICE_TEXT_MAX_CHARS,
            },
        },
        isConfigured: ({ providerConfig }) => Boolean(trimToUndefined(providerConfig.baseUrl)),
        resolveCapabilities: async (req) => {
            const config = req.providerConfig ?? {};
            const baseUrl = trimToUndefined(config.baseUrl) ?? trimToUndefined(req.baseUrl);
            if (!baseUrl) {
                return {
                    text: {
                        maxInputChars: SBV2_FALLBACK_VOICE_TEXT_MAX_CHARS,
                    },
                };
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            return {
                text: await client.getTextCapabilities(),
            };
        },
        parseDirectiveToken: (ctx) => {
            const parsed = parseVoiceDirectiveToken(ctx);
            return parsed ? { handled: true, overrides: { ...ctx.currentOverrides, ...parsed } } : undefined;
        },
        resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => ({
            ...baseTtsConfig,
            ...talkProviderConfig,
        }),
        resolveTalkOverrides: ({ params }) => {
            const overrides = {};
            const voiceId = trimToUndefined(params.voiceId) ??
                trimToUndefined(params.voice_id) ??
                trimToUndefined(params.voice);
            const modelId = asNumber(params.modelId) ?? asNumber(params.model_id);
            const modelName = trimToUndefined(params.modelName) ??
                trimToUndefined(params.model_name) ??
                trimToUndefined(params.model);
            const speakerId = asNumber(params.speakerId) ?? asNumber(params.speaker_id);
            const speakerName = trimToUndefined(params.speakerName) ??
                trimToUndefined(params.speaker_name) ??
                trimToUndefined(params.speaker);
            const speed = asNumber(params.speed);
            const length = asNumber(params.length) ?? rateWpmToLength(params.rateWpm) ?? rateWpmToLength(params.rate_wpm) ?? rateWpmToLength(params.rate);
            const style = trimToUndefined(params.style);
            const styleWeight = asNumber(params.styleWeight) ?? asNumber(params.style_weight);
            const sdpRatio = asNumber(params.sdpRatio) ?? asNumber(params.sdp_ratio);
            const noise = asNumber(params.noise);
            const noisew = asNumber(params.noisew) ?? asNumber(params.noise_w);
            const assistText = trimToUndefined(params.assistText) ?? trimToUndefined(params.assist_text);
            const assistTextWeight = asNumber(params.assistTextWeight) ?? asNumber(params.assist_text_weight);
            const language = trimToUndefined(params.language);
            if (voiceId)
                overrides.voiceId = voiceId;
            if (modelId !== undefined)
                overrides.modelId = modelId;
            if (modelName)
                overrides.modelName = modelName;
            if (speakerId !== undefined)
                overrides.speakerId = speakerId;
            if (speakerName)
                overrides.speakerName = speakerName;
            if (speed !== undefined)
                overrides.speed = speed;
            if (length !== undefined)
                overrides.length = length;
            if (style)
                overrides.style = style;
            if (styleWeight !== undefined)
                overrides.styleWeight = styleWeight;
            if (sdpRatio !== undefined)
                overrides.sdpRatio = sdpRatio;
            if (noise !== undefined)
                overrides.noise = noise;
            if (noisew !== undefined)
                overrides.noisew = noisew;
            if (assistText)
                overrides.assistText = assistText;
            if (assistTextWeight !== undefined)
                overrides.assistTextWeight = assistTextWeight;
            if (language)
                overrides.language = language;
            return overrides;
        },
        listVoices: async (req) => {
            const config = req.providerConfig ?? {};
            const baseUrl = trimToUndefined(config.baseUrl) ?? trimToUndefined(req.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            return listVoiceProfiles(await client.getModelsInfo());
        },
        synthesize: async (req) => {
            const config = req.providerConfig;
            const baseUrl = trimToUndefined(config.baseUrl);
            if (!baseUrl) {
                throw new Error("Style-Bert-VITS2 baseUrl is not configured");
            }
            const timeoutMs = asNumber(config.timeoutMs) ?? req.timeoutMs ?? 30_000;
            const client = new Sbv2Client({ baseUrl, timeoutMs });
            const providerOverrides = normalizeOverrides(req.providerOverrides);
            let resolvedVoice;
            const pronunciationReplacements = resolvePronunciationReplacements(config);
            const textCapabilities = await client.getTextCapabilities();
            const explicitText = extractExplicitTtsText(req.text);
            const earlyPreparedText = explicitText
                ? { text: explicitText, textPreparation: "explicit" }
                : prepareSpeechText(req.text, "JP");
            if (earlyPreparedText.textPreparation === undefined || earlyPreparedText.textPreparation === "explicit") {
                const earlyPreflightText = earlyPreparedText.textPreparation === "explicit"
                    ? earlyPreparedText.text
                    : applyPronunciationReplacements(earlyPreparedText.text, pronunciationReplacements);
                assertSbv2TextWithinHardLimit(earlyPreflightText, textCapabilities.maxInputChars);
            }
            try {
                resolvedVoice = await resolveVoiceProfile({
                    client,
                    providerConfig: config,
                    providerOverrides,
                });
            }
            catch (error) {
                throw withTelemetryContext(error, buildTelemetryMetadata({
                    baseUrl,
                    resolvedVoice: readVoiceContext(config, providerOverrides),
                }));
            }
            const preflightPreparedText = explicitText
                ? { text: explicitText, textPreparation: "explicit" }
                : prepareSpeechText(req.text, resolvedVoice.language);
            const preflightText = preflightPreparedText.textPreparation === "explicit"
                ? preflightPreparedText.text
                : applyPronunciationReplacements(preflightPreparedText.text, pronunciationReplacements);
            assertSbv2TextWithinHardLimit(preflightText, textCapabilities.maxInputChars);
            let audioBuffer;
            const preparedText = prepareSpeechText(req.text, resolvedVoice.language);
            try {
                const synthesisText = preparedText.textPreparation === "explicit"
                    ? preparedText.text
                    : applyPronunciationReplacements(preparedText.text, pronunciationReplacements);
                assertSbv2TextWithinHardLimit(synthesisText, textCapabilities.maxInputChars);
                audioBuffer = await client.synthesize({
                    text: synthesisText,
                    modelName: resolvedVoice.modelName,
                    modelId: resolvedVoice.modelId,
                    speakerId: resolvedVoice.speakerId,
                    speakerName: resolvedVoice.speakerName,
                    style: resolvedVoice.style,
                    styleWeight: resolvedVoice.styleWeight,
                    sdpRatio: resolvedVoice.sdpRatio,
                    noise: resolvedVoice.noise,
                    noisew: resolvedVoice.noisew,
                    length: resolvedVoice.length,
                    assistText: resolvedVoice.assistText,
                    assistTextWeight: resolvedVoice.assistTextWeight,
                    language: resolvedVoice.language,
                });
            }
            catch (error) {
                throw withTelemetryContext(error, buildTelemetryMetadata({
                    baseUrl,
                    resolvedVoice,
                    textPreparation: preparedText.textPreparation,
                }));
            }
            const metadata = buildTelemetryMetadata({
                baseUrl,
                resolvedVoice,
                audioBytes: audioBuffer.length,
                textPreparation: preparedText.textPreparation,
            });
            options.logger?.debug?.("style-bert-vits2 synthesis resolved", metadata);
            return {
                audioBuffer,
                outputFormat: "wav",
                fileExtension: ".wav",
                voiceCompatible: false,
                metadata,
            };
        },
    };
}
export default definePluginEntry({
    id: "style-bert-vits2-bridge",
    name: "Style-Bert-VITS2 Bridge",
    description: "Bridge OpenClaw to a Style-Bert-VITS2 API server for speech generation.",
    register(api) {
        api?.logger?.info?.("register start");
        api.registerSpeechProvider(buildSbv2SpeechProvider({ logger: api?.logger }));
        api?.logger?.info?.("speech provider registered: style-bert-vits2");
    },
});
