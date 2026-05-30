import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
export function isPronunciationReplacementMap(value) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string"));
}
function asNonEmptyString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function resolveUserPath(value) {
    if (value === "~") {
        return homedir();
    }
    if (value.startsWith("~/")) {
        return path.join(homedir(), value.slice(2));
    }
    return path.resolve(value);
}
export function loadPronunciationReplacements(filePath) {
    const configuredPath = asNonEmptyString(filePath);
    if (!configuredPath)
        return undefined;
    const resolvedPath = resolveUserPath(configuredPath);
    if (!existsSync(resolvedPath)) {
        throw new Error(`pronunciation replacements file was not found: ${resolvedPath}`);
    }
    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
    if (!isPronunciationReplacementMap(parsed)) {
        throw new Error(`pronunciation replacements file must be a JSON object of string values: ${resolvedPath}`);
    }
    return parsed;
}
export function resolvePronunciationReplacements(config) {
    const fileReplacements = loadPronunciationReplacements(config.pronunciationReplacementsPath);
    const inlineReplacements = isPronunciationReplacementMap(config.pronunciationReplacements)
        ? config.pronunciationReplacements
        : undefined;
    return fileReplacements || inlineReplacements
        ? { ...fileReplacements, ...inlineReplacements }
        : undefined;
}
export function applyPronunciationReplacements(text, replacements) {
    if (!isPronunciationReplacementMap(replacements))
        return text;
    return Object.entries(replacements)
        .filter(([from]) => from.length > 0)
        .sort(([left], [right]) => right.length - left.length)
        .reduce((next, [from, to]) => next.split(from).join(to), text);
}
