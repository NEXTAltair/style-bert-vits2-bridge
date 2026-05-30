# ADR 0001: OpenClaw Speech Provider Boundary

- **日付**: 2026-05-28
- **ステータス**: Accepted

## Context

Style-Bert-VITS2 Bridge は OpenClaw の speech provider plugin として、OpenClaw から受け取った音声生成要求を Style-Bert-VITS2 API に変換する。

OpenClaw には TTS runtime、`/tts` directive、Talk mode、media delivery、plugin registration がある。一方、Style-Bert-VITS2 には model、speaker、style、style weight、length、assist text など、OpenClaw の generic TTS 抽象より細かい音声生成パラメーターがある。

この plugin が OpenClaw の command parser や UI runtime を再実装すると、OpenClaw 本体の policy、provider routing、surface ごとの media delivery と責務が重複する。逆に OpenClaw 側に SBV2 固有の model/speaker/style 知識を持たせると、provider abstraction が崩れる。

そのため、OpenClaw と bridge の間でどの情報を受け渡し、どちらが何を判断するかを明確にする必要がある。

## Decision

OpenClaw は speech request の共通 runtime を担当し、style-bert-vits2-bridge は SBV2 固有の provider implementation を担当する。

この境界は第二段階の provider registration、directive / Talk override、healthcheck、telemetry 実装で採用済みとする。

OpenClaw から bridge に渡す情報は次の通りとする。

- `text`: 合成対象テキスト。
- `providerConfig`: `messages.tts.providers.style-bert-vits2` 由来の durable config。
- `providerOverrides`: `/tts` directive、Talk mode、または UI からの per-request override。
- `timeoutMs`: OpenClaw runtime または provider config 由来の timeout。
- `target`: 必要に応じた出力 surface の識別情報。
- `policy`: directive token parse 時の override 許可方針。

Bridge から OpenClaw に返す情報は次の通りとする。

- `audioBuffer`: SBV2 が返した音声バイト列。
- `outputFormat`: 現時点では `wav`。
- `fileExtension`: 現時点では `.wav`。
- `voiceCompatible`: OpenClaw の voice-note / realtime voice surface にそのまま流せるかどうか。現時点では `false`。
- directive parse 結果: `handled`、`overrides`、`warnings`。

OpenClaw 側の責務は次の通りとする。

- `/tts` command と directive の基本構文解析。
- provider selection と provider routing。
- override policy の定義と適用方針。
- Talk mode から speech provider への呼び出し。
- audio artifact の保存、添付、再生 UI、channel delivery。

Bridge 側の責務は次の通りとする。

- `registerSpeechProvider` による `style-bert-vits2` provider 登録。
- `isConfigured` による `baseUrl` 設定確認。
- `synthesize` による SBV2 `/voice` 呼び出し。
- `listVoices` または voice profile resolver による `/models/info` の利用。
- `parseDirectiveToken` による SBV2 固有 token の安全な override 化。
- `resolveTalkConfig` / `resolveTalkOverrides` による Talk mode 入力の SBV2 override 化。
- SBV2 error を operator が読める形に整形すること。

## Rationale

この分担にすると、OpenClaw は provider 非依存の command、policy、UI、media delivery に集中できる。Bridge は SBV2 固有の domain knowledge に集中できる。

代替案として、bridge が `/tts` の構文解析を直接持つ方法がある。しかしこの方法では OpenClaw の policy を bypass しやすく、他 provider と異なる command semantics が増えるため採用しない。

別の代替案として、OpenClaw 本体に SBV2 固有の `model_name`、`speaker_name`、`style` 解釈を持たせる方法がある。しかしこれは provider abstraction に固有 API の知識を混ぜるため採用しない。

`parseDirectiveToken`、`resolveTalkConfig`、`resolveTalkOverrides` のような provider hook によって、OpenClaw の共通 runtime と provider 固有解釈を接続する。

## Consequences

良い点:

- OpenClaw の slash command、policy、UI delivery と bridge の SBV2 API 実装が分離される。
- SBV2 固有 parameter を plugin 側で増やしても、OpenClaw 本体の command parser を変更しなくてよい。
- directive と Talk mode の両方で同じ voice profile resolver を使える。
- provider override の whitelist と warning を bridge 側で制御できる。

悪い点・トレードオフ:

- OpenClaw の provider hook と policy surface が不足している場合、OpenClaw 側の拡張 issue が必要になる。
- Bridge は OpenClaw SDK の speech provider contract に追従する必要がある。
- UI 表示の問題は bridge だけでは完結しないため、OpenClaw surface 側の調査が必要になることがある。
