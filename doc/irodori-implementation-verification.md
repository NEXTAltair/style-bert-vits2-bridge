# Irodori実装・Issue対応の検証記録

Date: 2026-10-17. ローカル実装の記録であり、リリース・本番適用・全Issue完了の宣言ではない。

## 検証済み

- bridge: 実際の公開OpenClaw SDK 2026.10.4に対する `pnpm run check` 成功。`pnpm test`: 414 passed / 4 skipped。skipは既存のSBV2 live tests。`pnpm run build` 成功。
- Python workflow: 26 tests成功、`py_compile` / `git diff --check`成功。GPUやnetworkを使わないsynthetic subprocessで検証。
- host: 基準commit `40b01eef9fb`の隔離checkoutで、routing/persona/model/preferences/resource所有権と新API、bridge結合の7ファイル72 tests成功。最終bridge build後、新API8件と結合1件の9 testsも再実行成功。
- 結合fixtureは実bridgeのコンパイル済みhook/provider、実hostの選択/音声専用タグ解析/合成前整形を使用。表示文を維持し、56種のUnicodeがmock HTTPのAPI本文まで残り、指定voiceも変わらないことを確認。実GPU合成や聴感の評価ではない。
- 最終reviewで未知trigger、inbound条件不足、structured配信との競合を発見し修正。user turnのみ、inboundモードのガイド省略、host方式に応じたvoiceText/inlineタグの排他指示へ変更。独立した再reviewは修正を承認、focused tests 43/43成功。READMEの配信経路表記も整合させた。
- 配布dry-runは63ファイル。最終report/fixture/host patchを含み、依存・メモリ・Python cache・音声/モデル資産を含まない。新規ガイドのstrict JSON例5件・ローカルリンク8件を検証。
- host patchのreverse apply check成功。公開SDK不足をhost内部importやprivileged gateway呼出しで回避していない。

## 実API境界の追加確認

- 隔離hostの実選択API・音声専用タグ解析・合成処理、build済みbridgeを、現在稼働するWSL native speech.cpp 0.8.9 CUDAへ接続したopt-in試験が1/1成功。HTTP mockではなく実際の `/v1/audio/speech` を1回呼び出した。
- 絵文字注釈を含む短文が最終API本文まで一致し、表示用本文は変わらないこと、同じモデル・参照声・速度・seed・instructionsが使われ、試験前後のmodel catalogが一致することを確認。約2.52秒で4.714秒の48kHz/mono/PCM16非無音WAVを生成しhashを照合。
- 試験全体は82.61秒、うちテスト本体2.575秒。大半は隔離hostのworker生成であり、音声推論の停止ではない。
- 設定は試験プロセス内だけ。利用者の `auto=off`、声、サービス、Gateway本体は変更せず、音声再生も行っていない。実LLMによる本文生成、稼働中Gatewayへの機能有効化、聴感改善はまだ未検証。private試験素材やローカルfixtureは配布patchに含めない。

## gateの制約

- host本体の `pnpm tsgo` は既存の `src/infra/restart-coordinator.ts:10` の未使用型 `SafeGatewayRestartCounts` (TS6196)で失敗。同ファイルは本パッチで変更しておらず、HEADにも該当宣言がある。host全体の型check成功とは扱わない。
- hostの変更8ファイルのlintは0 warnings / 0 errors。前提のplugin SDK境界宣言buildも成功 (12,366 files emitted)。speech testsを含むhostの `tsconfig.core.test.other.json` 型checkも成功。最初のテストfixtureでDiscord固有型に未定義のaccount TTSを置いていた点は、汎用channel fixtureに修正した。修正後の8 runtime testsも再実行成功。
- 最初の隔離host依存共有linkは型checkの所有境界に拒否されたため、依存を隔離checkout内へコピーした。境界checkを無効化せず、本番checkoutの依存は変更していない。

## #93: 読み仮名登録の導線

README、manifestのschema/UI hints、voice skill、[登録ガイド](../skills/voice/references/pronunciation-replacements.md)へ実装済み。strict JSON、ファイル先/inline優先、path解決、SBV2限定、upstream user_dictとの違いを明示。通常OC経路でtts:textは辞書バイパスにならない。GitHub上のcloseや公開は行っていない。

## #94: GPU停止の観測改善、原因調査は保留

追加の原因調査は保留。試験で停止は再現せず、音声経路の整理で改善した可能性はあるが、因果や根治は未確定。既存証拠と診断改善を保持し、再発時に再検討する。#94を解決済みとして閉じるための根拠ではない。

- commandごとのprogress JSON、checkpointファイル証拠、任意の無出力timeoutを追加。既定0で強制終了しない。Linux/WSLでは自分の子process groupだけを停止し、leader終了後も残る子孫への中断を継続する。Windowsは直接の子だけ。
- 実際のtqdm行に複数の比率があるとき、`epoch_step=1/7`を総進捗`276/300`と誤認しない。LoRAの親checkpointディレクトリから保存stepを取得し、改行なし最終行とUTF-8境界も扱う。
- failed receipt、checkpoint、元profileを保持。途中成果物を完成済みモデルとして採用しない。checkpointの存在は重みの完全性・有限性の証明ではない。
- 元の停止は再現性・原因とも未確定。wrapperがwaitしていた事実だけでGPU停止の原因とは断定できない。無出力timeoutは進捗のないログが出続ける場合の検知ではない。
- 当初の非破壊観測では共有RTX 3080 10 GiBの使用量が約9.2 GiB。WSLのcompute-process照会はprocess別内訳を返さず、kernel journalにも該当障害は見つからなかった。これは元の事象の原因を証明・否定しない。
- その後、本人の明示許可で復帰可能な音声処理を一時停止した。初回は空き4500 MiBの安全条件を満たさず、GPU試験を開始せず復帰。別の新規出力先で約5 GiBの空きを確保した再試験は、元入力による300step学習2回 (各300/300、全工程約176秒/148秒) と、既存比較profileの4文推論 (全工程約66秒) が全件成功。終了後、停止対象の元model一覧一致・health応答・service復帰をreceiptで確認した。Irodori healthは起動確認でありモデルロード・合成成功とは区別する。
- Windows speech.cpp等の残存処理がありGPU専有試験ではない。2秒間隔190サンプルの全GPU使用量は4283-9524 MiBで、当該学習プロセス単体の使用量ではない。保存先と元の失敗receiptは分離し、音声素材・profile・ログはprivate領域に保持。後続の運用構成変更は別作業として扱い、過去の試験復帰手順を再実行しない。
- 結論は「この条件の試験では停止が再現しなかった」。共有GPU競合が元の原因だった、根本修正が完了した、とは主張しない。原因究明には停止時の証拠がなお不足しており、Issueは未解決。
- 実ログのbyte比率 `0.00/1.43k` をstep比率と誤認する別の診断バグを発見。日付も除外する回帰試験をred→greenで追加し、25 tests成功。GPU停止の根本修正とは別件。

### 追加の原因調査と観測補強

- 元学習の起動scriptも `HF_HUB_OFFLINE=1` だった。完走試験だけがofflineだったという仮説は採用しない。別途起動された旧推論の実効環境はreceiptから確定できない。
- SilentCipherの最後の「Downloading」表示だけでネットワーク待ちとは特定できない。現環境の実get_model関数と実cacheを使い、GPUモデル構築だけをstub化したCPU検証では、同じ表示からsocket接続0回・約14msでモデル構築入口へ進んだ。その後にはCUDAへの転送やGPU上での重み読込もある。取得処理やwatermarkは変更しない。
- 遡及できなかった実効環境を次回から残すため、実際の子プロセスへ渡す環境snapshotから、offline指定3項目・CPUスレッド数3項目・unbuffered指定だけをprogress JSONへ記録する。秘密値や環境全体を記録しない。未設定はnull、子へ渡す値は変更しない。
- 回帰試験は追加前にmissing-fieldで失敗し、修正後26/26成功。childへの実値継承・ログの値・receipt保存・非対象の秘密変数の非記録を確認。py_compileとdiff-checkも成功。これは観測の修正であり、過去のGPU停止の根治ではない。

## 実運用の未実施事項

この実装作業では本番host/config/声/TTS ON-OFFは未変更 (許可された診断用の一時停止・復帰を除く)。別作業の音声経路移行とは区別する。自動ガイドはopt-inであり、hostパッチ適用と設定が必要。現在 `auto=inbound` の自動ガイドは対象外で、通常TTSは維持。LLMの全出力遵守・聴感改善・GPU停止解消を保証していない。本記録の実装・試験段階では公開やGateway再起動は行っていない。GitHubへの公開状態はPRとリリース記録で確認し、本番Gatewayへの機能適用とは区別する。

## 結合テストの再実行

1. bridgeで `pnpm run build`。
2. 対応hostの隔離checkoutへ[hostパッチ](patches/openclaw-speech-prompt-context.patch)を適用し、そのcheckout内で依存を用意する。本番へ直接適用しない。
3. [結合fixture](fixtures/irodori-host-integration.test.ts.txt)をhostの `src/tts/tts-bridge-local-integration.test.ts` へコピー。`.txt`はbridge側の通常テストに誤収集させないため。
4. hostで `BRIDGE_ROOT=/absolute/bridge pnpm test src/tts/tts-prompt-context.test.ts src/tts/tts-bridge-local-integration.test.ts --maxWorkers=1`。

配布に含むのはpatch・fixture・手順であり、hostcheckoutや依存copy、ユーザー音声・制作素材は含まない。
