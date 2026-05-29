# ADR 0003: OpenClaw UI And Audio Delivery

- **日付**: 2026-05-28
- **ステータス**: Proposed

## Context

Style-Bert-VITS2 Bridge は音声生成 provider であり、直接 UI を描画しない。ユーザーが触る UI は OpenClaw 経由で提供される。

想定 surface は次の通り。

- `/tts audio` slash command。
- Talk mode。
- Control UI / webchat。
- Discord などの channel delivery。
- 将来の voice note / mobile / telephony surface。

Bridge は SBV2 `/voice` から WAV を受け取り、OpenClaw に `audioBuffer` と metadata を返す。現時点では `outputFormat: "wav"`、`fileExtension: ".wav"`、`voiceCompatible: false` とする。

観測上、Discord では音声 delivery が成功している。一方、Control UI / webchat では `/tts audio` の生成結果が見えにくいことがある。この問題は SBV2 provider 固有ではなく、OpenClaw surface 側の audio artifact 表示・添付・再生の問題である可能性が高い。

## Decision

Bridge は UI を直接提供しない。OpenClaw の speech provider contract に従って audio artifact と metadata を返し、UI 表示・添付・再生・channel 変換は OpenClaw surface 側に委ねる。

Bridge が提供する UI-facing 情報は次の範囲に限定する。

- provider id: `style-bert-vits2`。
- provider label: `Style-Bert-VITS2`。
- provider configured state: `baseUrl` が設定されているか。
- `listVoices` または profile resolver による selectable voice metadata。
- `parseDirectiveToken` warning による directive 入力ミスの説明。
- synthesize failure 時の operator-friendly error。
- audio result metadata: format、extension、voice compatibility。

OpenClaw 経由の UI は次の考え方で提供する。

- `/tts audio`: OpenClaw が command UI と audio artifact 表示を担当する。Bridge は directive token を override に変換し、WAV を返す。
- Talk mode: OpenClaw が会話 lifecycle と speech request を担当する。Bridge は Talk params を SBV2 profile/override に変換する。
- Control UI / webchat: OpenClaw が audio player、attachment、download link の表示を担当する。Bridge は成功/失敗が判断できる metadata と error を返す。
- Discord/channel delivery: OpenClaw channel が必要に応じて format 変換や送信を担当する。
- voice note / mobile / telephony: Bridge が直接対応するまでは `voiceCompatible: false` とし、WAV artifact として扱う。

Control UI / webchat で audio artifact が見えない場合は、bridge 内で独自 UI を増やさず、OpenClaw 本体または surface 側 issue として切り分ける。

## Rationale

Bridge が UI を持たないことで、OpenClaw の surface ごとの実装と重複しない。Provider は音声生成に集中し、OpenClaw は user interaction と media delivery に集中できる。

代替案として、bridge が Control UI / webchat 用の専用表示や download link を返す方法がある。しかし surface ごとの UI contract が provider に漏れ、Discord、webchat、Talk、mobile で挙動が分岐しやすくなるため採用しない。

別の代替案として、bridge が OGG/Opus 変換まで行い `voiceCompatible: true` を返す方法がある。しかし現在の最小経路は SBV2 の WAV を安定して OpenClaw に渡すことであり、voice note / mobile / telephony の codec 要件は未確定である。形式変換は必要性と責務境界を確認してから追加する。

WAV を返して `voiceCompatible: false` にすることで、bridge の現在の保証範囲を明示できる。Channel 側で変換可能な surface は OpenClaw に任せ、直接 voice-compatible artifact を要求する surface には別設計で対応する。

## Consequences

良い点:

- Bridge の責務が音声生成と provider metadata に限定される。
- UI の表示改善を OpenClaw surface 共通の問題として扱える。
- Discord、webchat、Talk、mobile の delivery 差分を provider 内に抱え込まない。
- `voiceCompatible: false` により、WAV artifact と voice-note ready artifact の違いが明確になる。

悪い点・トレードオフ:

- Control UI / webchat の見え方は bridge だけでは修正できない。
- Mobile や voice note で即利用したい場合、追加の codec 変換または OpenClaw channel 側対応が必要になる。
- Operator は当面、runtime inspect、SBV2 `/status`、`/models/info`、live smoke test で provider 健全性を確認する必要がある。
- OpenClaw の media artifact contract が変わる場合、bridge の metadata も追従が必要になる。
