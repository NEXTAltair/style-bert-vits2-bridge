export interface EmotionStateSelection {
    mood: string;
    profileName: string;
    overrides: Record<string, unknown>;
}
export declare function resolveEmotionStateSelection(config: Record<string, unknown>): Promise<EmotionStateSelection | undefined>;
