# Style-Bert-VITS2 Bridge

OpenClaw の TTS プロバイダープラグイン。ローカルで稼働する [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) API サーバーを呼び出し、日本語音声を生成します。

## 前提条件

- OpenClaw `>= 2026.3.24-beta.2`
- Node.js `>= 22`
- Style-Bert-VITS2 API サーバーが起動済みであること（デフォルト `http://127.0.0.1:5000`）

## インストール

```bash
# OpenClaw の拡張ディレクトリにクローン
cd ~/.openclaw/extensions
git clone <repo-url> style-bert-vits2-bridge
cd style-bert-vits2-bridge
pnpm install
pnpm run build
openclaw plugins install --link .
```

リンクインストール後、runtime inspection で speech provider が見えることを確認します。

```bash
openclaw plugins inspect style-bert-vits2-bridge --runtime --json
```

成功時は `speechProviderIds` に `style-bert-vits2` が含まれます。bundled skill は `openclaw.plugin.json` の `skills` から discovery されます。

## OpenClaw 設定

`openclaw.json` の `messages.tts.providers` に以下を追加:

```jsonc
{
  "messages": {
    "tts": {
      "providers": {
        "style-bert-vits2": {
          "baseUrl": "http://127.0.0.1:5000",
          // オプション
          "timeoutMs": 30000,
          "defaultModelName": "valentina01_bright",
          "defaultSpeakerName": "valentina01_bright",
          "defaultStyle": "00_Neutral",
          "defaultLanguage": "JP"
        }
      }
    }
  }
}
```

`baseUrl` が設定されていればプロバイダーは有効になります。明示指定がない場合、bridge は `valentina01_bright` / `valentina01_bright` / `00_Neutral` を既定 profile として解決します。

## 仕組み

1. OpenClaw が `/tts audio` コマンド等で音声生成をリクエスト
2. プラグインが SBV2 の `GET /models/info` で model / speaker / style を検証
3. プラグインが解決済みパラメーターで SBV2 の `POST /voice` にテキストを送信
4. SBV2 が WAV 音声 (PCM 16bit mono 44100Hz) を返却
5. チャネル（Discord 等）が必要に応じてフォーマット変換して配信

## 設定項目

| キー | 型 | 説明 |
|------|------|------|
| `baseUrl` | string | **必須** — SBV2 API の URL |
| `timeoutMs` | integer | リクエストタイムアウト (ms)。デフォルト 30000 |
| `defaultModelName` / `modelName` | string | デフォルトのモデル名（`model_assets/` 内のディレクトリ名） |
| `defaultModelId` / `modelId` | integer | デフォルトのモデル ID（0 始まり） |
| `defaultSpeakerId` / `speakerId` | integer | デフォルトのスピーカー ID（0 始まり） |
| `defaultSpeakerName` / `speakerName` | string | デフォルトのスピーカー名（`speakerId` より優先） |
| `defaultStyle` / `style` | string | デフォルトのスタイル。bridge 既定は `"00_Neutral"` |
| `defaultStyleWeight` / `styleWeight` | number | スタイルの強さ |
| `defaultLength` / `length` | number | 話速相当。大きいほど遅く、小さいほど速い |
| `defaultAssistText` / `assistText` | string | 感情補助テキスト |
| `defaultAssistTextWeight` / `assistTextWeight` | number | 感情補助テキストの影響度 |
| `defaultLanguage` / `language` | string | 言語 (`JP` / `EN` / `ZH`)。デフォルト `JP` |

`default*` キーを優先します。既存設定との互換性のため、従来の `modelName`、`speakerId`、`speakerName`、`style`、`language` なども fallback として読み取ります。新規設定では `default*` キーを使ってください。

## Voice profile と directive

bridge は OpenClaw の generic default TTS ではなく、bridge 側で SBV2 固有の voice profile を解決します。`/models/info` に存在しない model / speaker / style が指定された場合、SBV2 の 422 応答をそのまま返すのではなく、どの指定が利用できないかを示すエラーに変換します。

OpenClaw の policy が許可している場合、directive や Talk params から以下を override できます。

| キー | 説明 |
|------|------|
| `voice`, `voice_id` | bridge の固定 voice profile ID |
| `model`, `model_name`, `model_id` | SBV2 model override |
| `speaker`, `speaker_name`, `speaker_id` | SBV2 speaker override |
| `style`, `style_weight` | SBV2 style override |
| `speed`, `length` | 話速 override。`speed` は `length = 1 / speed` に変換 |
| `assist_text`, `assist_text_weight` | 感情補助テキスト override |

低レベルの `sdp_ratio`、`noise`、`noisew`、`auto_split`、`split_interval` は directive からは受け付けません。

## 開発

```bash
pnpm install          # 依存インストール
pnpm run check        # 型チェック
pnpm test             # テスト実行
pnpm run build        # dist/ に配布用 entrypoint を生成
```

配布・検証時の entrypoint は `package.json#openclaw.extensions` の `./dist/index.js` です。git install でも runtime が読めるように `dist/` は git 管理します。source checkout で作業した後は `pnpm run build` を実行してから `openclaw plugins install --link .` または runtime inspection を行ってください。

manifest と runtime registration の確認:

```bash
openclaw plugins inspect style-bert-vits2-bridge --runtime --json
```

`openclaw plugins validate` は simple tool plugin metadata 用のコマンドなので、この capability plugin の検証には使いません。

## バンドルスキル

`skills/voice` — エージェントがモデル・スピーカー・スタイルを選択する際のガイダンスを提供します。`style_weight` の注意点や `assist_text` による感情混合の使い方などを含みます。

## ライセンス

MIT
