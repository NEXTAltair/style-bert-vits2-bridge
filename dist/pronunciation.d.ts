export declare function isPronunciationReplacementMap(value: unknown): value is Record<string, string>;
export declare function loadPronunciationReplacements(filePath: unknown): Record<string, string> | undefined;
export declare function resolvePronunciationReplacements(config: {
    pronunciationReplacements?: unknown;
    pronunciationReplacementsPath?: unknown;
}): Record<string, string> | undefined;
export declare function applyPronunciationReplacements(text: string, replacements: unknown): string;
