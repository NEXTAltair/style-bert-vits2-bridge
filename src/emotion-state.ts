import { readFile } from "node:fs/promises";

const PROFILE_KEYS = [
  "voiceId",
  "modelName",
  "modelId",
  "speakerName",
  "speakerId",
  "style",
  "styleWeight",
  "length",
  "language",
  "assistText",
  "assistTextWeight",
] as const;

export interface EmotionStateSelection {
  mood: string;
  profileName: string;
  overrides: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMood(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
}

function selectProfileName(mood: string, profiles: Record<string, unknown>): string | undefined {
  const normalizedMood = normalizeMood(mood);
  const entries = Object.keys(profiles)
    .filter((name) => name !== "default")
    .map((name) => ({ name, normalized: normalizeMood(name) }))
    .filter((entry) => entry.normalized);

  const exact = entries.find((entry) => entry.normalized === normalizedMood);
  if (exact) return exact.name;

  const contained = entries
    .filter((entry) => normalizedMood.includes(entry.normalized))
    .sort((left, right) => right.normalized.length - left.normalized.length)[0];
  return contained?.name ?? (isRecord(profiles.default) ? "default" : undefined);
}

function sanitizeProfile(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const profile = Object.fromEntries(
    PROFILE_KEYS.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]),
  );
  return Object.keys(profile).length ? profile : undefined;
}

export async function resolveEmotionStateSelection(
  config: Record<string, unknown>,
): Promise<EmotionStateSelection | undefined> {
  const statePath = typeof config.emotionStatePath === "string"
    ? config.emotionStatePath.trim()
    : "";
  const profiles = isRecord(config.emotionProfiles) ? config.emotionProfiles : undefined;
  if (!statePath || !profiles) return undefined;

  const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  if (!isRecord(state) || typeof state.mood !== "string" || !state.mood.trim()) return undefined;

  const mood = state.mood.trim();
  const profileName = selectProfileName(mood, profiles);
  if (!profileName) return undefined;
  const overrides = sanitizeProfile(profiles[profileName]);
  return overrides ? { mood, profileName, overrides } : undefined;
}
