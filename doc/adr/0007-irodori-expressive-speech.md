# ADR 0007: Irodori音声専用本文とhostの選択境界

- Status: Accepted; opt-in implementation, not deployed
- Date: 2026-10-17

## Decision

返答を作る同じLLMに、表示本文とは別の音声専用本文を生成させる。公開 `before_prompt_build` hookがIrodori固有のガイドを提供し、OpenClawの既存 `[[tts:text]]...[[/tts:text]]` 分離経路を使う。毎回の別LLM呼出しや単語による感情推定は追加しない。

意味が公開された45種すべてを選択候補にする。意味未記載の11種は明示入力を保持するが意味を推測しない。Qwen用instructions生成/相互変換、声質の変更、TTS有効化は対象外。

## Host contract

公開SDK 2026.10.4だけでは、persona・ユーザーpreference・session overrideまで含む実効モデルを安全に取得できない。`speech-settings.resolveEffectiveTtsConfig` だけで判定すると実際の合成とずれる。provider側でroutingを複製したり、privileged gateway APIを経由したりしない。

[host接続パッチ](../patches/openclaw-speech-prompt-context.patch)で汎用の `api.runtime.tts.prepareSpeechPromptContext` を追加する。基準commitは `40b01eef9fb`。公開バージョン番号だけを互換性判定に使わず、メソッドの存在とversion 1レスポンスを検証する。

- 入力: cfg、agentId、channelId、accountId、sessionAuto。
- 出力: version、ready、auto、allowText、maxLengthと、選択できたprovider/model/personaの識別子のみ。
- hostの既存TTS preferences・persona binding・primary-provider選択・request resource ownerを再利用する。
- 合成、fallback試行、LLM呼出し、設定書込みは行わない。credentials、provider設定全体、音声ファイルを返さない。
- readyはガイド生成の前提が整ったというsnapshotであり、将来のprovider健康性やturnの発話許可ではない。inbound/taggedや最終配信の判定はhostに残る。
- provider/model切替に追従するためturn間でキャッシュしない。取得失敗やhook失効ではガイドを省略する。

APIがない旧hostでは警告してこのガイドだけを無効化し、通常の合成を維持する。プラグイン設定は既定OFFの `irodoriExpressiveText`。prompt hookへの明示権限が必要。

## Operational boundary

- 本番Gatewayへのパッチ適用、再起動、plugin設定・TTS ON/OFF・声の切替、push/releaseはこの実装検証では行っていない。
- ガイドでLLMの事実保持・手動台本優先を指示するが、全出力をコードで保証するrewrite方式ではない。
- `trigger=user`のみ対象。不明/内部turnと`auto=inbound`は発話条件を確定できないためガイドを追加しない。通常TTSの動作は維持する。
- `tagged` ではタグそのものが再生トリガー。ガイドだけを理由に毎回タグを出さない。
- structured配信ならhostの`voiceText`、inline配信なら音声専用タグと排他的に指示する。方式不明なら音声本文生成を省略し、plugin側で配信方式を推測しない。
- 連続絵文字・絵文字だけの行はhostで除去され得る。注釈は1個ずつ台詞と同じ行へ置く。
- API本文のUnicode保持、配信処理、実際の聴感を別々の証拠として扱う。固定通知・直接APIへ後付け変換するものではない。

## Related issues

- #93: README、manifest schema/UI hints、voice skillから読み仮名辞書へ到達できるようにする。SBV2限定・file-first/inline優先・host経路の音声専用本文にも適用される境界を明示する。
- #94: 進捗JSON、保存checkpoint証拠、既定無効の任意stall timeoutを追加する。これはGPU停止の根本修正ではない。GPU共有・CUDA待ち・driverの切り分けには元の環境での追加観測が必要で、issueを完了扱いにしない。

## Verification

プラグイン全テスト/型チェック/build、hostの選択回帰、実際のtqdm行とcheckpoint形式のsyntheticテストを実施する。最終結果と制約は [検証記録](../irodori-implementation-verification.md) に記録する。
