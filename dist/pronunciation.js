export function isPronunciationReplacementMap(value) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string"));
}
export function applyPronunciationReplacements(text, replacements) {
    if (!isPronunciationReplacementMap(replacements))
        return text;
    return Object.entries(replacements)
        .filter(([from]) => from.length > 0)
        .sort(([left], [right]) => right.length - left.length)
        .reduce((next, [from, to]) => next.split(from).join(to), text);
}
