# ADR 0002: SBV2 Voice Profile And Parameter Resolution

- **日付**: 2026-05-28
- **ステータス**: Proposed

## Context

Style-Bert-VITS2 の `/voice` API は、OpenClaw の generic TTS request より多くの音声生成パラメーターを持つ。

主な SBV2 パラメーターは次の通り。

- `text`: 合成対象テキスト。
- `encoding`: 日本語 text の URL decode 安定化のため `utf-8` を指定する。
- `model_name` / `model_id`: 使用するモデル。
- `speaker_name` / `speaker_id`: 使用する話者。
- `style`: スタイルまたは emotion tone。
- `style_weight`: スタイルの強さ。
- `length`: 話速相当。値が大きいほど遅く、小さいほど速い。
- `language`: `JP` / `EN` / `ZH`。
- `sdp_ratio`, `noise`, `noisew`: 推論品質や揺らぎに関わる低レベル knob。
- `assist_text`, `assist_text_weight`: 感情補助テキスト。
- `auto_split`, `split_interval`: 長文分割。

OpenClaw の config や directive からこれらを直接すべて露出すると、無効な model/speaker/style の指定、壊れやすい低レベル knob の乱用、surface ごとの policy bypass が起こりやすい。

また、SBV2 の利用可能な model、speaker、style はローカルの `/models/info` に依存する。固定文字列だけで扱うと、operator の環境で実在しない組み合わせを指定しやすい。

## Decision

Bridge は SBV2 parameter を直接公開するのではなく、voice profile resolver を中心に解決する。

Voice profile は、OpenClaw 側から扱いやすい `voice` または `voiceId` を、SBV2 の具体的な model/speaker/style defaults に変換する単位とする。

最低限の profile 解決結果は次の shape とする。

```ts
type Sbv2ResolvedVoiceProfile = {
  voiceId: string;
  modelName?: string;
  modelId?: number;
  speakerName?: string;
  speakerId?: number;
  style?: string;
  styleWeight?: number;
  length?: number;
  language?: "JP" | "EN" | "ZH";
  assistText?: string;
  assistTextWeight?: number;
};
```

Parameter precedence は次の順にする。

1. per-request override: `/tts` directive、Talk mode params、UI selection。
2. resolved voice profile。
3. provider config defaults。
4. bridge hard defaults。

Bridge hard defaults は、SBV2 が暗黙に `model_id=0` へ落ちることを避けるため、設定または profile resolver が利用できる場合は明示的な Valentina 系 profile を優先する。現時点の既定候補は `valentina01_bright` / `valentina01_bright` / `00_Neutral` とする。

`/models/info` を使って、少なくとも次を検証する。

- 指定された `modelName` が存在する。
- 指定された `speakerName` または `speakerId` がその model に存在する。
- 指定された `style` がその model に存在する。

Allowed directive keys は whitelist 方式にする。

- voice identity: `voice`, `voice_id`, `speaker`, `speaker_name`, `speaker_id`。
- model override: `model`, `model_name`, `model_id`。
- voice settings: `style`, `style_weight`, `speed`, `length`, `assist_text`, `assist_text_weight`。

Policy mapping は次を基本とする。

- `voice`, `speaker`, `speaker_name`, `speaker_id` は `allowVoice` 相当。
- `model`, `model_name`, `model_id` は `allowModelId` 相当。
- `style`, `style_weight`, `speed`, `length`, `assist_text`, `assist_text_weight` は `allowVoiceSettings` 相当。

低レベル knob の `sdp_ratio`, `noise`, `noisew`, `auto_split`, `split_interval` は directive からは受け付けない。必要になった場合は別 issue で whitelist、range、policy mapping を決めてから追加する。

## Rationale

Voice profile resolver を中心にすると、`/tts` directive、Talk mode、UI selection、README の設定例が同じ解決規則を共有できる。

代替案として、OpenClaw から渡された key/value をそのまま SBV2 query parameter に変換する方法がある。しかしこの方法では任意の query knob が per-request で指定でき、policy と validation が弱くなるため採用しない。

別の代替案として、OpenClaw 本体に SBV2 用 voice profile を持たせる方法がある。しかし model/speaker/style は provider 固有かつローカル SBV2 server の状態に依存するため、bridge 側に置く。

`model_name` と `speaker_name` は人間に読みやすく、環境差分の debug に向く。`model_id` と `speaker_id` は SBV2 の内部順序に依存するため、profile と検証がない場所では優先しない。

`style_weight` は 1.0 を超えると音声が崩れやすいため、bridge 側で推奨範囲と validation warning を持つ。

## Consequences

良い点:

- `amitaro` など SBV2 の `model_id=0` fallback に意図せず落ちる問題を避けやすい。
- directive、Talk、UI が同じ voice/profile semantics を共有できる。
- 不正な model/speaker/style を SBV2 の 422 生ログではなく operator-friendly error にできる。
- provider config と per-request override の優先順位が明確になる。

悪い点・トレードオフ:

- `/models/info` 取得と cache invalidation の設計が必要になる。
- profile resolver が未実装の間は、config defaults だけで合成する fallback が残る。
- `allowVoiceSettings` で `style` と `assist_text` をまとめてよいかは OpenClaw policy surface に依存する。粒度が足りない場合は OpenClaw 側の policy 拡張が必要になる。
- 低レベル knob を意図的に閉じるため、advanced user には別途明示的な escape hatch が必要になる可能性がある。
