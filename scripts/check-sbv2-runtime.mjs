#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { normalizeModelsInfo } from "../dist/sbv2-client.js";
import { resolveVoiceProfile } from "../dist/voice-resolver.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:5000";
const DEFAULT_CONFIG_PATH = `${homedir()}/.openclaw/openclaw.json`;
const DEFAULT_EXPECTED_MODELS = ["valentina01_bright"];
const DEFAULT_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = {
    configPath: process.env.OPENCLAW_CONFIG ?? DEFAULT_CONFIG_PATH,
    baseUrl: process.env.SBV2_BASE_URL,
    expectedModels: [],
    timeoutMs: undefined,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--config" && next) {
      options.configPath = next;
      index += 1;
    } else if (arg === "--base-url" && next) {
      options.baseUrl = next;
      index += 1;
    } else if (arg === "--expect-model" && next) {
      options.expectedModels.push(...next.split(",").map((value) => value.trim()).filter(Boolean));
      index += 1;
    } else if (arg === "--timeout-ms" && next) {
      const timeoutMs = Number(next);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        options.timeoutMs = timeoutMs;
      }
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/check-sbv2-runtime.mjs [options]

Options:
  --base-url <url>          SBV2 FastAPI base URL. Defaults to SBV2_BASE_URL,
                            OpenClaw provider config, then ${DEFAULT_BASE_URL}
  --config <path>           OpenClaw config path. Defaults to ${DEFAULT_CONFIG_PATH}
  --expect-model <name>     Model name expected in /models/info. Repeatable or comma-separated.
                            Defaults to ${DEFAULT_EXPECTED_MODELS.join(", ")}
  --timeout-ms <ms>         Request timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --json                    Print machine-readable JSON.
  -h, --help                Show this help.
`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOpenClawConfig(configPath) {
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = JSON.parse(text);
    return { ok: true, path: configPath, value: parsed };
  } catch (error) {
    return { ok: false, path: configPath, error: error instanceof Error ? error.message : String(error) };
  }
}

function getProviderConfig(config) {
  if (!isRecord(config)) {
    return {};
  }

  const messages = isRecord(config.messages) ? config.messages : {};
  const tts = isRecord(messages.tts) ? messages.tts : {};
  const providers = isRecord(tts.providers) ? tts.providers : {};
  const provider = isRecord(providers["style-bert-vits2"]) ? providers["style-bert-vits2"] : undefined;

  return {
    selectedProvider: typeof tts.provider === "string" ? tts.provider : undefined,
    hasProviderConfig: Boolean(provider),
    provider,
  };
}

function normalizeBaseUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : undefined;
}

function trimToUndefined(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asModelId(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim();
  }

  return undefined;
}

function asPositiveInteger(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

async function fetchJson(baseUrl, path, timeoutMs) {
  const url = new URL(path, baseUrl);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body = text;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // /status may return plain text depending on SBV2 version.
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeModelsInfo(value) {
  try {
    const models = normalizeModelsInfo(value).map((model, index) => ({
      id: model.id,
      index,
      sourceId: model.sourceId,
      name: model.name,
      speakers: model.speakers.map((speaker) => speaker.name),
      speakerIds: model.speakers.flatMap((speaker) => {
        const speakerId = asModelId(speaker.id);
        return speakerId ? [speakerId] : [];
      }),
      styles: model.styles.map((style) => style.name),
    }));

    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), models: [] };
  }
}

async function validateResolvedVoice(models, providerConfig) {
  try {
    const resolved = await resolveVoiceProfile({
      client: { getModelsInfo: async () => models },
      providerConfig,
    });

    return { ok: true, resolved };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function statusLine(ok, message) {
  return `${ok ? "OK " : "ERR"} ${message}`;
}

function printTextReport(report) {
  console.log(statusLine(report.config.readable, `OpenClaw config: ${report.config.path}`));
  if (!report.config.readable) {
    console.log(`    ${report.config.error}`);
  }

  console.log(statusLine(report.openclaw.hasProviderConfig, "provider config: messages.tts.providers.style-bert-vits2"));
  console.log(statusLine(report.openclaw.hasBaseUrl, "provider baseUrl configured"));
  console.log(statusLine(report.openclaw.selected, `selected provider: ${report.openclaw.selectedProvider ?? "(not set)"}`));
  console.log(`OK  SBV2 baseUrl: ${report.baseUrl}`);

  console.log(statusLine(report.status.ok, "GET /status"));
  if (!report.status.ok && report.status.error) {
    console.log(`    ${report.status.error}`);
  }

  console.log(statusLine(report.modelsInfo.ok, "GET /models/info"));
  if (!report.modelsInfo.ok && report.modelsInfo.error) {
    console.log(`    ${report.modelsInfo.error}`);
  }
  console.log(statusLine(report.modelsInfo.normalized, "normalize /models/info"));
  if (!report.modelsInfo.normalized && report.modelsInfo.normalizeError) {
    console.log(`    ${report.modelsInfo.normalizeError}`);
  }

  if (report.models.length) {
    console.log("OK  loaded models:");
    for (const model of report.models) {
      const modelId = model.id ?? model.sourceId ?? model.index;
      const speakerText = model.speakers.length ? model.speakers.join(", ") : "(none)";
      const styleText = model.styles.length ? model.styles.join(", ") : "(none)";
      console.log(`    [${modelId}] ${model.name}`);
      console.log(`        speakers: ${speakerText}`);
      console.log(`        styles: ${styleText}`);
    }
  }

  for (const expected of report.expectedModels) {
    console.log(statusLine(report.presentExpectedModels.includes(expected), `expected model: ${expected}`));
  }
  for (const expectedId of report.expectedModelIds) {
    console.log(statusLine(report.presentExpectedModelIds.includes(expectedId), `expected model id: ${expectedId}`));
  }
  for (const expected of report.expectedSpeakers) {
    console.log(statusLine(report.presentExpectedSpeakers.includes(expected), `expected speaker: ${expected}`));
  }
  for (const expectedId of report.expectedSpeakerIds) {
    console.log(statusLine(report.presentExpectedSpeakerIds.includes(expectedId), `expected speaker id: ${expectedId}`));
  }
  for (const expected of report.expectedStyles) {
    console.log(statusLine(report.presentExpectedStyles.includes(expected), `expected style: ${expected}`));
  }
  console.log(statusLine(report.voice.ok, "resolve configured voice"));
  if (!report.voice.ok && report.voice.error) {
    console.log(`    ${report.voice.error}`);
  }

  console.log(statusLine(report.ok, "overall healthcheck"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = await readOpenClawConfig(options.configPath);
  const providerConfig = getProviderConfig(config.value);
  const providerBaseUrl = normalizeBaseUrl(providerConfig.provider?.baseUrl);
  const baseUrl = normalizeBaseUrl(options.baseUrl) ?? providerBaseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? asPositiveInteger(providerConfig.provider?.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const configModelName =
    trimToUndefined(providerConfig.provider?.defaultModelName) ??
    trimToUndefined(providerConfig.provider?.modelName);
  const configModelId =
    configModelName === undefined
      ? asModelId(providerConfig.provider?.defaultModelId) ?? asModelId(providerConfig.provider?.modelId)
      : undefined;
  const configSpeakerName =
    trimToUndefined(providerConfig.provider?.defaultSpeakerName) ??
    trimToUndefined(providerConfig.provider?.speakerName);
  const configSpeakerId = asModelId(providerConfig.provider?.defaultSpeakerId) ?? asModelId(providerConfig.provider?.speakerId);
  const configStyle =
    trimToUndefined(providerConfig.provider?.defaultStyle) ??
    trimToUndefined(providerConfig.provider?.style);
  const expectedModels =
    options.expectedModels.length > 0
      ? options.expectedModels
      : [configModelName].filter(Boolean);
  const expectedModelIds =
    options.expectedModels.length > 0
      ? []
      : [configModelId].filter(Boolean);

  const effectiveExpectedModels =
    expectedModels.length || expectedModelIds.length ? expectedModels : DEFAULT_EXPECTED_MODELS;
  const status = await fetchJson(baseUrl, "/status", timeoutMs);
  const modelsInfo = await fetchJson(baseUrl, "/models/info", timeoutMs);
  const modelsSummary = modelsInfo.ok ? summarizeModelsInfo(modelsInfo.body) : { ok: false, models: [] };
  const models = modelsSummary.models;
  const voice = modelsSummary.ok
    ? await validateResolvedVoice(normalizeModelsInfo(modelsInfo.body), providerConfig.provider ?? {})
    : { ok: false, error: modelsSummary.error };
  const modelNames = new Set(models.map((model) => model.name));
  const modelIds = new Set(
    models.flatMap((model) => [asModelId(model.id), asModelId(model.sourceId), asModelId(model.index)].filter(Boolean)),
  );
  const presentExpectedModels = effectiveExpectedModels.filter((name) => modelNames.has(name));
  const presentExpectedModelIds = expectedModelIds.filter((id) => modelIds.has(id));
  const configuredVoiceTargetModels = models.filter(
    (model) =>
      voice.resolved?.modelName === model.name ||
      String(voice.resolved?.modelId) === String(model.id) ||
      String(voice.resolved?.modelId) === String(model.sourceId) ||
      String(voice.resolved?.modelId) === String(model.index),
  );
  const expectedSpeakers = [configSpeakerName].filter(Boolean);
  const expectedSpeakerIds = [configSpeakerId].filter(Boolean);
  const expectedStyles = [configStyle].filter(Boolean);
  const presentExpectedSpeakers = expectedSpeakers.filter((speaker) =>
    configuredVoiceTargetModels.some((model) => model.speakers.includes(speaker)),
  );
  const presentExpectedSpeakerIds = expectedSpeakerIds.filter((speakerId) =>
    configuredVoiceTargetModels.some((model) => model.speakerIds.includes(speakerId)),
  );
  const presentExpectedStyles = expectedStyles.filter((style) =>
    configuredVoiceTargetModels.some((model) => model.styles.includes(style)),
  );
  const openclawSelected =
    providerConfig.selectedProvider === undefined || providerConfig.selectedProvider === "style-bert-vits2";

  const report = {
    ok:
      config.ok &&
      providerConfig.hasProviderConfig &&
      Boolean(providerBaseUrl) &&
      openclawSelected &&
      status.ok &&
      modelsInfo.ok &&
      modelsSummary.ok &&
      voice.ok &&
      presentExpectedModels.length === effectiveExpectedModels.length &&
      presentExpectedModelIds.length === expectedModelIds.length &&
      presentExpectedSpeakers.length === expectedSpeakers.length &&
      presentExpectedSpeakerIds.length === expectedSpeakerIds.length &&
      presentExpectedStyles.length === expectedStyles.length,
    baseUrl,
    timeoutMs,
    config: {
      readable: config.ok,
      path: config.path,
      error: config.error,
    },
    openclaw: {
      hasProviderConfig: providerConfig.hasProviderConfig,
      hasBaseUrl: Boolean(providerBaseUrl),
      selected: openclawSelected,
      selectedProvider: providerConfig.selectedProvider,
    },
    status,
    modelsInfo: {
      ok: modelsInfo.ok,
      status: modelsInfo.status,
      statusText: modelsInfo.statusText,
      error: modelsInfo.error,
      normalized: modelsSummary.ok,
      normalizeError: modelsSummary.error,
    },
    voice,
    models,
    expectedModels: effectiveExpectedModels,
    expectedModelIds,
    expectedSpeakers,
    expectedSpeakerIds,
    expectedStyles,
    presentExpectedModels,
    presentExpectedModelIds,
    presentExpectedSpeakers,
    presentExpectedSpeakerIds,
    presentExpectedStyles,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
