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
openclaw plugins install --link . --force
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
          "modelName": "your-model-name",
          "speakerId": 0,
          "speakerName": "speaker",
          "style": "Neutral",
          "language": "JP"
        }
      }
    }
  }
}
```

`baseUrl` が設定されていればプロバイダーは有効になります。

## 仕組み

1. OpenClaw が `/tts audio` コマンド等で音声生成をリクエスト
2. プラグインが SBV2 の `POST /voice` にテキストを送信
3. SBV2 が WAV 音声 (PCM 16bit mono 44100Hz) を返却
4. チャネル（Discord 等）が必要に応じてフォーマット変換して配信

## 設定項目

| キー | 型 | 説明 |
|------|------|------|
| `baseUrl` | string | **必須** — SBV2 API の URL |
| `timeoutMs` | integer | リクエストタイムアウト (ms)。デフォルト 30000 |
| `modelName` | string | デフォルトのモデル名（`model_assets/` 内のディレクトリ名） |
| `speakerId` | integer | デフォルトのスピーカー ID（0 始まり） |
| `speakerName` | string | デフォルトのスピーカー名（`speakerId` より優先） |
| `style` | string | デフォルトのスタイル。デフォルト `"Neutral"` |
| `language` | string | 言語 (`JP` / `EN` / `ZH`)。デフォルト `JP` |

## 開発

```bash
pnpm install          # 依存インストール
pnpm run check        # 型チェック
pnpm test             # テスト実行
pnpm run build        # dist/ に配布用 entrypoint を生成
```

配布・検証時の entrypoint は `package.json#openclaw.extensions` の `./dist/index.js` です。source checkout で作業した後は `pnpm run build` を実行してから `openclaw plugins install --link . --force` または runtime inspection を行ってください。

manifest と runtime registration の確認:

```bash
openclaw plugins inspect style-bert-vits2-bridge --runtime --json
```

`openclaw plugins validate` は simple tool plugin metadata 用のコマンドなので、この capability plugin の検証には使いません。

## バンドルスキル

`skills/voice` — エージェントがモデル・スピーカー・スタイルを選択する際のガイダンスを提供します。`style_weight` の注意点や `assist_text` による感情混合の使い方などを含みます。

## ライセンス

MIT
