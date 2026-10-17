# Irodoriの音声専用本文を自動生成する

## 仕組み

返答を作るLLMへIrodori用の表現ガイドを渡し、通常の表示本文と `[[tts:text]]...[[/tts:text]]` の音声専用本文を同じ応答で生成させます。別LLMへの書換え依頼、単語ベースの感情判定、Qwen用ト書きの生成は行いません。OpenClawが音声専用本文を選び、bridgeがAPIの `input` へ渡します。

意味が公式に公開された45種すべてを候補にし、文脈に合う感情・話し方・話速・非言語音・音響効果を選びます。定番数種類に固定せず、全種消化や大量投入も強制しません。意味が未記載の11種は勝手に自動選択せず、明示された注釈としては保持します。対応表は [emoji-controls.md](emoji-controls.md)。

## 有効化と前提

この機能は既定OFF。既存のplugin entryへ次をマージします。これは設定例であり、skillを読むだけで本番設定を書き換えません。

```json
{
  "plugins": {
    "entries": {
      "style-bert-vits2-bridge": {
        "enabled": true,
        "config": { "irodoriExpressiveText": true },
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

`hooks.allowPromptInjection` がfalseの場合は使えません。conversation accessはホストが要求するprompt hook権限で、この実装はhookへ渡される会話履歴を読んだり外部送信したりしません。現在のsessionのTTS auto overrideと、ホストが解決した音声選択だけを参照します。

**ホスト側に `api.runtime.tts.prepareSpeechPromptContext` が必要です。公開済みOpenClaw 2026.10.4 SDKにはこのメソッドがありません。** 同梱の [host接続パッチ](../../../doc/patches/openclaw-speech-prompt-context.patch) とその [説明](../../../doc/adr/0007-irodori-expressive-speech.md) を確認してください。対応APIがないhostでは理由を警告し、絵文字ガイドだけを無効にします。通常の音声合成は維持します。未対応hostで機能が稼働したとは扱いません。

ホストは既存のTTS選択処理を使い、ユーザーpreference、persona、agent/channel/account設定、sessionのauto設定を反映します。bridgeは選択規則を独自実装せず、provider/モデルが不明、未対応、利用不可の場合はガイドを追加しません。

- `irodori`: 対応Irodoriモデルでのみ適用。既定モデルは `irodori-tts`。
- `speech-cpp`: `model`を対応Irodori IDとして明示した場合のみ。例えば `irodori-tts` / `irodori-tts-mf` / `irodori-tts-large`。モデル省略や未確認の別名を、GUIの現在値から推測しません。
- QwenやSBV2: 変更なし。Qwenの既存の手動instructions転送もそのままです。

## 読み上げ設定は変更しない

- `auto=off`または音声本文override禁止ならガイドを追加せず、勝手に音声を生成しません。
- `inbound`は現在の公開hookから入力音声の有無を確定できないため、この自動ガイドを追加しません。通常のinbound TTSは維持します。`tagged`は会話が音声返答を求める場合だけで、ガイドがあるだけで毎回tagを出す指示にはしません。
- `trigger=user`を明示されたturnのみが対象です。trigger不明・イベント・メンテナンスturnではガイドを追加しません。
- 配信方式をpluginが推測せず、hostが指定するmessage-tool配信なら`voiceText`、inline返答なら音声専用タグ、方式不明なら生成省略と指示します。同時使用は指示しません。
- voice、基盤、速度、seed、自動TTS設定には書込みを行いません。

## 表現・検証の境界

表示文を変更せず、読み上げ文の意味・数値・否定・固有名詞を維持して注釈を加えるよう指示します。すでに明示された台本や絵文字を優先し、二重に演技指定を足しません。通常は注釈を1個ずつ台詞と同じ行へ置きます。ホストの連続絵文字・絵文字だけの行の装飾除去は、この機能でも変更していません。

これはLLMへの生成指示であり、全返答での完全な遵守や聴感の改善をコードで保証するものではありません。未注釈の文しか返らなければ、通常の読み上げへ戻ります。固定通知、直接API、過去の未注釈本文、単発の `/tts audio` に後付けでLLM変換を掛ける機能ではありません。手動の表現読み上げでは既存skillの対応表を使います。

状態はturnごとに取得し、provider/model変更後に古い選択をキャッシュして使いません。取得失敗やhook失効時はガイドを省略し、会話本文・秘密値・生のエラー内容をログに残しません。
