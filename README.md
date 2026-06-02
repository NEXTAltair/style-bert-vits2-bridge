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

Valentina 系の推奨開始点は次の通りです。

| キー | 推奨値 | 備考 |
|------|------|------|
| `defaultModelName` | `valentina01_bright` | `/models/info` の model name と一致させる |
| `defaultSpeakerName` | `valentina01_bright` | speaker name を優先して指定する |
| `defaultStyle` | `00_Neutral` | まず neutral で確認してから style を変える |
| `defaultLanguage` | `JP` | 日本語入力の通常値 |
| `defaultStyleWeight` | 未指定または控えめな値 | 強くしすぎると音声が崩れやすい |
| `defaultLength` | 未指定または `1` 前後 | 大きいほど遅く、小さいほど速い |

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

「音が出ない」「別の声になる」「fallback provider に切り替わった可能性がある」場合は、次の順で確認します。

1. `pnpm run check:sbv2` で SBV2 server、OpenClaw provider config、期待モデルの有無を確認する。
2. `openclaw plugins inspect style-bert-vits2-bridge --runtime --json` で `speechProviderIds` に `style-bert-vits2` が含まれることを確認する。
3. `/models/info` の model / speaker / style と、OpenClaw config の `defaultModelName` / `defaultSpeakerName` / `defaultStyle` が一致していることを確認する。
4. `/tts audio`、voice override、Talk mode の順で実際の合成経路を確認する。
5. `/tts status` と OpenClaw の debug log で `style-bert-vits2` 以外の provider が選ばれていないか、または SBV2 validation error が出ていないか確認する。

SBV2 API 単体の起動確認:

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

OpenClaw 側では runtime inspection で provider registration を確認します。cold inspect や plugin list では runtime registration が表示されないことがあるため、capability 確認には `--runtime` を使います。

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

Control UI / webchat で音声 artifact が見えない場合でも、Discord など別 channel で配信でき、`/tts status` と debug telemetry が成功しているなら bridge の合成自体は成功しています。UI 表示、添付、再生、channel 変換は OpenClaw 本体または surface 側の責務として切り分けます。

SBV2 API が起動しているローカル環境では live smoke test も実行できます。

```bash
SBV2_BASE_URL=http://127.0.0.1:5000 pnpm test
```

live smoke test は `/status`、`/models/info`、短文 `/voice`、WAV header、invalid model 指定時の失敗を確認します。

## モデル作成用データセット

bridge は SBV2 の GUI でいう「データセット作成」タブ相当の素材準備を CLI から実行できます。まず音声を bridge workspace に取り込みます。

```bash
sbv2-bridge datasets ingest \
  --model-name my_voice \
  --source /path/to/audio-or-directory \
  --language ja \
  --use-jp-extra \
  --json
```

出力された `dataset.manifestPath` を使って、SBV2 側の slice と transcription を実行します。

```bash
sbv2-bridge datasets prepare \
  --manifest /path/to/manifest.json \
  --json
```

`datasets prepare` は SBV2 root で `uv run python slice.py ...` と `uv run python transcribe.py ...` を呼び、`Data/<modelName>/raw` と `Data/<modelName>/esd.list` を作成します。文字起こしは `litagin/anime-whisper`、batch size 16、初期プロンプト空文字を既定にします。

サブディレクトリごとに音声を置いた場合、その相対構造は SBV2 の `raw/` に渡されるため、style ごとの素材分けに使えます。既存の `Data/<modelName>/raw`、`Data/<modelName>/esd.list`、`model_assets/<modelName>` がある場合は上書きせず失敗します。

この段階で行う品質確認は `esd.list` と raw wav の対応、speaker/language/text の軽量検証までです。SBV2 の auto preprocess、`resample`、`preprocess_text`、`bert_gen`、`style_gen`、学習、モデルマージは別工程として扱います。

学習系 wrapper は、同じ manifest から実行計画を確認してから起動できます。

```bash
sbv2-bridge training plan \
  --manifest /path/to/manifest.json \
  --json
```

通常実行は SBV2 の `resample`、`preprocess_text`、`bert_gen`、`style_gen`、`train_ms` を agent-safe job として順に呼びます。

```bash
sbv2-bridge training run \
  --manifest /path/to/manifest.json \
  --json
```

`--stage resample --stage preprocess-text` のように stage を限定できます。既存の `Data/<modelName>/models` や `model_assets/<modelName>` は上書きしません。実 SBV2 での training 完走検証は bridge の wrapper test では行わず、CLI は計画、preflight、job log、summary、失敗分類を提供します。

学習済み candidate は、固定テスト文セットで一括生成して評価 artifact を作れます。

```bash
sbv2-bridge evaluation run \
  --model-name valentina_custom \
  --base-url http://127.0.0.1:5000 \
  --json
```

`evaluation run` は `samples/*.wav`、`evaluation.json`、`summary.json` を `model-evaluate` job に記録します。既定では日本語の短文、長文、句読点、英数字混在、neutral 指定のテスト文を使います。独自のテスト文セットは `--test-set /path/to/test-set.json` で渡せます。

人間の試聴結果は evaluation manifest に追記できます。

```bash
sbv2-bridge evaluation note \
  --evaluation /path/to/evaluation.json \
  --case ja-short \
  --decision hold \
  --message "語尾が少し不安定"
```

`models promote` に `--evaluation /path/to/evaluation.json` を渡すと、明示的な `reject` または reject recommendation の model は昇格を止めます。

### Healthcheck / lifecycle 境界

この bridge は SBV2 FastAPI server manager ではありません。SBV2 server の起動、停止、GPU/backend 選択、モデルファイルの配置、モデルロードは SBV2 側または運用スクリプトの責務です。bridge は設定済みの `baseUrl` に対して `/models/info` と `/voice` を呼び、失敗時に operator が切り分けやすいエラーを返します。

### Telemetry / debug

OpenClaw の `/tts status` は、直近の TTS 試行について fallback と attempted providers を表示します。SBV2 を使ったつもりで別 provider が使われた疑いがある場合は、まず `/tts status` の `Fallback`、`Attempts`、provider detail を確認してください。

bridge 側では合成成功時に、安全な telemetry metadata と debug log へ resolved profile を出します。確認できる主な項目は `provider=style-bert-vits2`、sanitized `baseUrl`、`voiceId`、`modelName`、`modelId`、`speakerName`、`speakerId`、`style`、`styleWeight`、`length`、`language`、`outputFormat=wav`、`audioBytes` です。

エラー時も同じ安全な context をエラーメッセージ末尾に付けます。`/models/info` の model / speaker / style 不一致、SBV2 server 未起動、`baseUrl` 誤りを切り分ける用途です。

debug log と telemetry には、読み上げ本文、`assistText`、音声バイナリ、base64、URL の user/password/query/hash は出しません。secret を `baseUrl` の query や userinfo に入れている場合でも、ログ上は除去されます。

### Troubleshooting

| 症状 | 主な確認点 | 対応 |
|------|------|------|
| `GET /status` が失敗する | SBV2 server 未起動、`baseUrl` 誤り、port違い | SBV2 FastAPI server を起動し、`baseUrl` を `http://127.0.0.1:5000` など実際のURLに合わせる |
| `GET /models/info` が失敗する | モデル未ロード、SBV2 API 側のエラー | SBV2 側でモデル配置とロード状態を確認する |
| `style-bert-vits2` が使われない | OpenClaw provider config、selected provider、fallback | `pnpm run check:sbv2` と `/tts status` の `Fallback` / `Attempts` を確認する |
| Valentina のつもりが別声になる | SBV2 の `model_id=0` fallback、default profile 未指定 | `defaultModelName` / `defaultSpeakerName` / `defaultStyle` を明示する |
| model / speaker / style validation error | `/models/info` と config / directive の不一致 | 実在する model / speaker / style 名に合わせる。style は agent が選ぶため bridge 側で重み付けしない |
| 音声が不自然、感情が強すぎる | `style_weight`、`length`、`assist_text`、入力文 | まず `00_Neutral` と控えめな `style_weight` で確認し、その後に style や補助テキストを調整する |
| `/tts audio` は成功するが Control UI で見えない | OpenClaw surface 側の audio artifact 表示 | bridge ではなく OpenClaw 本体または surface 側 issue として扱う |
| channel によって再生可否が違う | channel delivery、codec変換、voice-compatible artifact | bridge は `wav` を返し、必要な変換は OpenClaw channel 側で扱う |

OpenClaw 本体側 issue として扱うものは、Control UI / webchat の audio artifact 表示、fallback / provider attempts の UI 改善、channel ごとの codec 変換、voice note / mobile / telephony 向けの voice-compatible artifact 対応です。この repo では SBV2 `/models/info` / `/voice` 呼び出し、voice profile 解決、directive / Talk override、安全な error / telemetry までを扱います。

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

### 制作 job CLI

SBV2 の非再生機能は、まず bridge 内 CLI の `sbv2-bridge` から段階的に実装します。#31 の土台として job manifest / status / log 追跡を提供し、#32 では音声素材を bridge 管理の ingest workspace にコピーして dataset manifest を作成します。

job manifest と log は、agent workspace ではなくユーザー環境の plugin runtime state として保存します。既定の保存先は `~/.openclaw/state/style-bert-vits2-bridge/jobs` です。

dataset ingest workspace も agent workspace ではなく plugin runtime state に保存します。既定の保存先は `~/.openclaw/state/style-bert-vits2-bridge/datasets` です。#32 の ingest は SBV2 の `Data/<modelName>` や `model_assets/<modelName>` へ直接書き込まず、原本を壊さないコピーと manifest 作成だけを行います。

`modelName` は SBV2 production pipeline 全体のキーとして扱い、後続の slice / transcribe / preprocess / train で同じ値を使います。別の `speakerName`、project 名、dataset 名、利用許諾メモは初期 ingest 入力として扱いません。音声ディレクトリに 2 個以上の直下サブディレクトリがある場合は、SBV2 2.5+ の通常挙動に合わせ、サブディレクトリ名を style group として manifest に記録します。

```bash
pnpm run build
pnpm run sbv2-bridge -- datasets ingest \
  --model-name valentina_custom \
  --source /path/to/raw-audio-or-directory \
  --language ja \
  --use-jp-extra
pnpm run sbv2-bridge -- datasets ingest \
  --model-name multilingual_custom \
  --source /path/to/raw-audio-or-directory \
  --language ja \
  --no-use-jp-extra \
  --json
pnpm run sbv2-bridge -- jobs start-dummy --message "job store smoke"
pnpm run sbv2-bridge -- jobs start-dummy --fail --json
pnpm run sbv2-bridge -- jobs list
pnpm run sbv2-bridge -- jobs status <jobId>
pnpm run sbv2-bridge -- jobs log <jobId> --tail 20
pnpm run sbv2-bridge -- jobs cancel <jobId> --json
pnpm run sbv2-bridge -- jobs resume <jobId> --json
pnpm run sbv2-bridge -- jobs retry <failedJobId> --json
```

## バンドルスキル

`skills/voice` — エージェントがモデル・スピーカー・スタイルを選択する際のガイダンスを提供します。`style_weight` の注意点や `assist_text` による感情混合の使い方などを含みます。

## ライセンス

MIT
