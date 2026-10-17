/** Irodori v4/v4.1 annotations; not a generic emoji-to-emotion vocabulary. */
export const IRODORI_EXPRESSIONS = [
    ["👂", "囁き、耳元の音"],
    ["😮‍💨", "吐息、溜息、寝息"],
    ["⏸️", "間、沈黙"],
    ["🤭", "くすくす笑い、含み笑い"],
    ["🥵", "喘ぎ、うめき声、唸り声"],
    ["📢", "エコー、リバーブ"],
    ["😏", "からかうように、甘えるように"],
    ["🥺", "声を震わせながら、自信のなさげに"],
    ["🌬️", "息切れ、荒い息遣い、呼吸音"],
    ["😮", "息をのむ"],
    ["👅", "舐める音、咀嚼音、水音"],
    ["💋", "リップノイズ"],
    ["🫶", "優しく"],
    ["😭", "嗚咽、泣き声、悲しみ"],
    ["😱", "悲鳴、叫び、絶叫"],
    ["😪", "眠そうに、気だるげに"],
    ["😴", "寝言、いびき"],
    ["⏩", "早口、一気にまくしたてる、急いで"],
    ["📞", "電話越し、スピーカー越しのような音"],
    ["🐢", "ゆっくりと"],
    ["🥤", "唾を飲み込む音"],
    ["🤧", "咳き込み、鼻をすする、くしゃみ、咳払い"],
    ["😒", "舌打ち"],
    ["😰", "慌てて、動揺、緊張、どもり"],
    ["😆", "喜びながら"],
    ["💥", "勢いよく、勢いに任せて"],
    ["😠", "怒り、不満げに、拗ねながら"],
    ["😲", "驚き、感嘆"],
    ["🥱", "あくび"],
    ["😖", "苦しげに"],
    ["😟", "心配そうに"],
    ["🫣", "恥ずかしそうに、照れながら"],
    ["🙄", "呆れたように"],
    ["😊", "楽しげに、嬉しそうに"],
    ["😎", "得意げに、自信ありげに"],
    ["👌", "相槌、頷く音"],
    ["🙏", "懇願するように"],
    ["🥴", "酔っ払って"],
    ["🎵", "鼻歌"],
    ["🤐", "口を塞がれて"],
    ["😌", "安堵、満足げに"],
    ["🤔", "疑問の声"],
    ["💪", "力を込めて、力強く"],
    ["👃", "匂いを嗅ぐ音"],
    ["📖", "ナレーション、独白、モノローグ"],
];
/** Accepted by upstream, but no documented meanings: preserve, never invent meanings. */
export const IRODORI_UNDOCUMENTED_ANNOTATIONS = [
    "⏱️", "🍭", "🎛️", "🎭", "🐱", "👏", "💦", "📄", "📣", "🤢", "🥹",
];
export const IRODORI_ANNOTATIONS = [
    ...IRODORI_EXPRESSIONS.map(([emoji]) => emoji),
    ...IRODORI_UNDOCUMENTED_ANNOTATIONS,
];
/** Match actual supported model identifiers, not arbitrary names containing "irodori". */
export function isIrodoriModel(model) {
    if (typeof model !== "string")
        return false;
    const id = model.trim().toLowerCase();
    return /^(?:irodori-tts(?:-mf|-large)?)(?::(?:f16|q8_0|q6_k|q5_k|q4_k))?$/.test(id)
        || /^(?:aratako\/)?irodori-tts-v(?:4\.1-small(?:-mf)?|4-small|4-large)(?:-quantized)?$/.test(id)
        || /^irodori-tts-(?:859m-v4\.1|866m-mf-v4\.1|3\.4b-v4)-(?:f16|q8_0|q6_k|q5_k|q4_k)\.gguf$/.test(id);
}
/** Pure prompt builder: host owns routing, preferences and delivery eligibility. */
export function buildIrodoriExpressionPrompt(context) {
    if (!context.allowText || !context.speechEligible || context.auto === "off")
        return undefined;
    if (context.provider !== "irodori"
        && !(context.provider === "speech-cpp" && isIrodoriModel(context.model)))
        return undefined;
    if (context.provider === "irodori" && context.model && !isIrodoriModel(context.model))
        return undefined;
    const limit = Math.max(1, Math.floor(context.maxLength));
    if (!Number.isFinite(limit))
        return undefined;
    return [
        "Irodori expressive speech (audio only):",
        context.structuredDelivery
            ? "When sending an authorized voice reply, put its spoken version in the existing voiceText field; never put TTS tags into visible message text."
            : "Follow the host delivery route, never select or change it. If the host requires structured/message-tool delivery, put the spoken version in its existing voiceText field and never put TTS tags in message text. Only on an inline-reply route that supports TTS directives, generate one [[tts:text]]...[[/tts:text]] block alongside the visible reply. Never use both forms. If the route is unclear, omit audio-only text.",
        "Keep the displayed reply unchanged. Preserve the spoken wording, facts, numbers, names, negation and conditions; add expression annotations, not new claims or a different answer.",
        `Keep the complete spoken version, including annotations, within ${limit} characters. Do not silently drop important content to fit.`,
        "Choose context-appropriate annotations from ALL 45 entries below, not a fixed handful. Include emotion, delivery, tempo, nonverbal sounds or effects when appropriate; do not force a cheerful tone. Plain passages may remain unannotated. No random selection, quotas or effect stuffing.",
        "Use single annotations on the same line as the spoken words. Keep emoji Unicode sequences intact. Avoid adjacent repeated emoji and emoji-only lines: host speech normalization may remove them.",
        "Honor an explicitly supplied spoken script and annotations without reinterpreting them or adding duplicates. The additional upstream annotations with undocumented meanings must be preserved if supplied, but not selected by guessing their meanings.",
        "Do not enable TTS, change its provider/model/voice, emit Qwen instructions, or apply these controls to non-Irodori models. If speech is not authorized, omit the audio-only text; these instructions do not grant speech permission.",
        context.auto === "tagged"
            ? "Tagged mode: adding the block itself triggers speech. Add it only when the conversation actually calls for a spoken reply, never merely because this guide is present."
            : "Follow the host voice-delivery conditions for this turn, including inbound-only mode.",
        "Irodori annotation meanings:",
        ...IRODORI_EXPRESSIONS.map(([emoji, meaning]) => `${emoji}: ${meaning}`),
    ].join("\n");
}
