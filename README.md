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

`--runtime` を付けない cold inspect や plugin list では、OpenClaw runtime を起動せず manifest だけを見るため、speech provider registration が表示されないことがあります。この plugin の capability 確認には runtime inspection を使ってください。

`openclaw plugins install --link .` はローカル checkout をそのまま参照する開発用インストールです。source を編集した場合は `pnpm run build` を実行して `dist/` を更新すると、リンク先 runtime に反映されます。通常配布や git/package 経由の `openclaw plugins install` では、同梱された `dist/index.js` と `openclaw.plugin.json` が読み込まれます。

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

SBV2 側の暗黙既定に任せると `model_id=0` に落ちます。観測環境では `model_id=0` が `amitaro` だったため、Valentina 系を使いたい場合は上のように `defaultModelName`、`defaultSpeakerName`、`defaultStyle` を明示してください。

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

## 動作確認

SBV2 API が起動していることを先に確認します。

```bash
curl -fsS http://127.0.0.1:5000/status
curl -fsS http://127.0.0.1:5000/models/info
```

まとめて切り分ける場合は read-only 診断スクリプトを使います。

```bash
pnpm run check:sbv2
pnpm run check:sbv2 -- --base-url http://127.0.0.1:5000 --expect-model valentina01_bright
```

このスクリプトは以下を確認します。

- OpenClaw config の `messages.tts.providers.style-bert-vits2`
- `messages.tts.provider` が未指定、または `style-bert-vits2` であること
- SBV2 の `GET /status`
- SBV2 の `GET /models/info`
- `/models/info` に期待するモデル名が含まれること

出力が `GET /status` で失敗する場合は SBV2 server 未起動または `baseUrl` 誤りです。`GET /models/info` だけ失敗する場合は SBV2 API 側のモデルロード状態を確認してください。期待モデルだけが失敗する場合は、SBV2 の `model_assets/`、ロード済みモデル、または OpenClaw の default model 設定がずれています。provider config や selected provider が失敗する場合は OpenClaw config 側の provider 選択ミスです。

OpenClaw 側では runtime inspection で provider registration を確認します。

```bash
openclaw plugins inspect style-bert-vits2-bridge --runtime --json
```

`speechProviderIds` に `style-bert-vits2` が含まれれば、OpenClaw runtime から provider が見えています。`dist/index.js` は OpenClaw plugin runtime から読み込まれる前提の entrypoint です。通常の Node.js script から直接 import すると、`openclaw/plugin-sdk/*` 解決や runtime mock が無いため失敗することがあります。

`/tts audio` では、通常合成と voice override の両方を確認します。

```text
/tts audio こんにちは。これは Style-Bert-VITS2 の確認です。
/tts voice=sbv2:valentina01_bright:valentina01_bright:00_Neutral audio こんにちは。Valentina 指定の確認です。
/tts model_name=valentina01_bright speaker_name=valentina01_bright style=00_Neutral audio こんにちは。
```

Talk mode では provider config の既定値に加えて、Talk params から `voice_id`、`model_name`、`speaker_name`、`style`、`rate`、`style_weight`、`assist_text` などを渡せます。`rate` は WPM として扱われ、SBV2 の `length` に変換されます。指定した model / speaker / style が `/models/info` に無い場合は、operator 向けに整形された validation error が返ります。

SBV2 API が起動しているローカル環境では live smoke test も実行できます。

```bash
SBV2_BASE_URL=http://127.0.0.1:5000 pnpm test
```

live smoke test は `/status`、`/models/info`、短文 `/voice`、WAV header、invalid model 指定時の失敗を確認します。

### Healthcheck / lifecycle 境界

この bridge は SBV2 FastAPI server manager ではありません。SBV2 server の起動、停止、GPU/backend 選択、モデルファイルの配置、モデルロードは SBV2 側または運用スクリプトの責務です。bridge は設定済みの `baseUrl` に対して `/models/info` と `/voice` を呼び、失敗時に operator が切り分けやすいエラーを返します。

「音声品質が期待と違う」「読み上げ内容が不自然」「fallback provider に切り替わった可能性がある」場合は、次の順で確認します。

1. `pnpm run check:sbv2` で SBV2 server、OpenClaw provider config、期待モデルの有無を確認する。
2. `openclaw plugins inspect style-bert-vits2-bridge --runtime --json` で `speechProviderIds` に `style-bert-vits2` が含まれることを確認する。
3. `/models/info` の model / speaker / style と、OpenClaw config の `defaultModelName` / `defaultSpeakerName` / `defaultStyle` が一致していることを確認する。
4. OpenClaw の debug log で `style-bert-vits2` 以外の provider が選ばれていないか、または SBV2 validation error が出ていないか確認する。
5. server 未起動、モデル未ロード、provider 選択ミスのどれでもない場合に、読み上げ本文、style、`assist_text`、話速などの品質調整として扱う。

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
