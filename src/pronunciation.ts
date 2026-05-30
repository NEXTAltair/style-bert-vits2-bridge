export function isPronunciationReplacementMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function applyPronunciationReplacements(
  text: string,
  replacements: unknown,
): string {
  if (!isPronunciationReplacementMap(replacements)) return text;

  return Object.entries(replacements)
    .filter(([from]) => from.length > 0)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((next, [from, to]) => next.split(from).join(to), text);
}
