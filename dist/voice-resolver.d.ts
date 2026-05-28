import type { Sbv2Client, Sbv2ModelInfo, Sbv2SynthesizeParams } from "./sbv2-client.js";
export type Sbv2Language = "JP" | "EN" | "ZH";
export interface Sbv2ResolvedVoiceProfile extends Omit<Sbv2SynthesizeParams, "text" | "encoding"> {
    voiceId: string;
}
export interface ResolveVoiceProfileOptions {
    client: Pick<Sbv2Client, "getModelsInfo">;
    providerConfig: Record<string, unknown>;
    providerOverrides?: Record<string, unknown>;
}
export declare const DEFAULT_VOICE_PROFILE: Sbv2ResolvedVoiceProfile;
export declare function resolveVoiceProfile({ client, providerConfig, providerOverrides, }: ResolveVoiceProfileOptions): Promise<Sbv2ResolvedVoiceProfile>;
export declare function listVoiceProfiles(models: Sbv2ModelInfo[]): Array<{
    id: string;
    name?: string;
}>;
export declare function parseVoiceDirectiveToken(ctx: {
    key: string;
    value: string;
    policy: Record<string, boolean>;
}): Record<string, unknown> | undefined;
