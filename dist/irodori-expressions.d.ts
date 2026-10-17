/** Irodori v4/v4.1 annotations; not a generic emoji-to-emotion vocabulary. */
export declare const IRODORI_EXPRESSIONS: readonly [readonly ["👂", "囁き、耳元の音"], readonly ["😮‍💨", "吐息、溜息、寝息"], readonly ["⏸️", "間、沈黙"], readonly ["🤭", "くすくす笑い、含み笑い"], readonly ["🥵", "喘ぎ、うめき声、唸り声"], readonly ["📢", "エコー、リバーブ"], readonly ["😏", "からかうように、甘えるように"], readonly ["🥺", "声を震わせながら、自信のなさげに"], readonly ["🌬️", "息切れ、荒い息遣い、呼吸音"], readonly ["😮", "息をのむ"], readonly ["👅", "舐める音、咀嚼音、水音"], readonly ["💋", "リップノイズ"], readonly ["🫶", "優しく"], readonly ["😭", "嗚咽、泣き声、悲しみ"], readonly ["😱", "悲鳴、叫び、絶叫"], readonly ["😪", "眠そうに、気だるげに"], readonly ["😴", "寝言、いびき"], readonly ["⏩", "早口、一気にまくしたてる、急いで"], readonly ["📞", "電話越し、スピーカー越しのような音"], readonly ["🐢", "ゆっくりと"], readonly ["🥤", "唾を飲み込む音"], readonly ["🤧", "咳き込み、鼻をすする、くしゃみ、咳払い"], readonly ["😒", "舌打ち"], readonly ["😰", "慌てて、動揺、緊張、どもり"], readonly ["😆", "喜びながら"], readonly ["💥", "勢いよく、勢いに任せて"], readonly ["😠", "怒り、不満げに、拗ねながら"], readonly ["😲", "驚き、感嘆"], readonly ["🥱", "あくび"], readonly ["😖", "苦しげに"], readonly ["😟", "心配そうに"], readonly ["🫣", "恥ずかしそうに、照れながら"], readonly ["🙄", "呆れたように"], readonly ["😊", "楽しげに、嬉しそうに"], readonly ["😎", "得意げに、自信ありげに"], readonly ["👌", "相槌、頷く音"], readonly ["🙏", "懇願するように"], readonly ["🥴", "酔っ払って"], readonly ["🎵", "鼻歌"], readonly ["🤐", "口を塞がれて"], readonly ["😌", "安堵、満足げに"], readonly ["🤔", "疑問の声"], readonly ["💪", "力を込めて、力強く"], readonly ["👃", "匂いを嗅ぐ音"], readonly ["📖", "ナレーション、独白、モノローグ"]];
/** Accepted by upstream, but no documented meanings: preserve, never invent meanings. */
export declare const IRODORI_UNDOCUMENTED_ANNOTATIONS: readonly ["⏱️", "🍭", "🎛️", "🎭", "🐱", "👏", "💦", "📄", "📣", "🤢", "🥹"];
export declare const IRODORI_ANNOTATIONS: readonly string[];
/** Match actual supported model identifiers, not arbitrary names containing "irodori". */
export declare function isIrodoriModel(model: unknown): boolean;
export type IrodoriExpressionContext = {
    provider: string;
    model?: string;
    auto: "off" | "always" | "inbound" | "tagged";
    allowText: boolean;
    maxLength: number;
    /** Guidance is applicable; actual speech authorization still belongs to delivery. */
    speechEligible: boolean;
    structuredDelivery?: boolean;
};
/** Pure prompt builder: host owns routing, preferences and delivery eligibility. */
export declare function buildIrodoriExpressionPrompt(context: IrodoriExpressionContext): string | undefined;
