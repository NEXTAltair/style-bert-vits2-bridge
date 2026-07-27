# Style-Bert-VITS2 Bridge

OpenClaw の TTS プロバイダープラグイン。ローカルで稼働する [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) API サーバーを呼び出し、日本語音声を生成します。

## 前提条件

- OpenClaw `>= 2026.5.28`
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

`defaultModelName` と `defaultSpeakerName` は声の同一性を決めます。`defaultStyle` はそのモデル内の初期表情です。別の声にしたい場合は model / speaker を変え、同じ声の表情だけを変えたい場合は `/models/info` の `style2id` に存在する style を directive や Talk params から切り替えます。

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
3. プラグインが SBV2 `/voice` の text hard limit を超えていないことを確認
4. プラグインが解決済みパラメーターで SBV2 の `POST /voice` にテキストを送信
5. SBV2 が WAV 音声 (PCM 16bit mono 44100Hz) を返却
6. チャネル（Discord 等）が必要に応じてフォーマット変換して配信

bridge は provider capability として SBV2 `/voice` の読み上げ本文上限を公開します。`/openapi.json` から `text.schema.maxLength` を取得できる場合は、その起動中serverの実効値を使います。OpenAPIへ到達できない場合は、SBV2の起動時設定を推測せず上限不明として扱います。到達可能な `/openapi.json` に `maxLength` が無い場合も、SBV2側でtext limitが無効な設定として扱い、bridge側では上限を広告・強制しません。合成時は、発音置換後にSBV2へ実際に送る本文が取得済みの実効上限を超える場合だけ `/voice` に送信せず、OpenClaw本体側で短いspoken textを準備するための明確なエラーにします。

見えるチャット本文を自然な読み上げ文に変換する処理、`tts.maxTextLength` やuser preferenceとprovider hard limitの統合はOpenClaw本体側の責務です。このbridgeはSBV2固有のhard limitを公開し、送信直前の安全ガードを担当します。

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

低レベルの `sdp_ratio`、`noise`、`noisew`、`auto_split`、`split_interval` は OpenClaw agent が扱う per-request override からは受け付けません。`sdp_ratio`、`noise`、`noisew` が必要な場合は operator が provider config の既定値として固定します。`auto_split` と `split_interval` は bridge provider config では扱いません。

## 動作確認

「音が出ない」「別の声になる」「fallback provider に切り替わった可能性がある」場合は、次の順で確認します。

1. `pnpm run check:sbv2` で SBV2 server、OpenClaw provider config、期待モデルの有無を確認する。
2. `openclaw plugins inspect style-bert-vits2-bridge --runtime --json` で `speechProviderIds` に `style-bert-vits2` が含まれることを確認する。
3. `/models/info` の model / speaker / style と、OpenClaw config の `defaultModelName` / `defaultSpeakerName` / `defaultStyle` が一致していることを確認する。
4. `/tts audio`、voice override、Talk mode の順で実際の合成経路を確認する。
5. `/tts status` と OpenClaw の debug log で、実際の `provider`、`fallbackFrom`、`attempts` を確認する。音声が出ていても、fallback により `style-bert-vits2` 以外の provider が使われている場合がある。

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

この bridge は `v0.1.0` から OpenClaw `2026.5.28` を安定版の互換性下限にしています。`openclaw/plugin-sdk/plugin-entry`、`openclaw/plugin-sdk/speech`、`definePluginEntry(...)`、`api.registerSpeechProvider(...)` は 2026.5 系でも継続利用できます。

`/tts audio` では、通常合成と voice override の両方を確認します。

```text
/tts audio こんにちは。これは Style-Bert-VITS2 の確認です。
/tts voice=sbv2:valentina01_bright:valentina01_bright:00_Neutral audio こんにちは。Valentina 指定の確認です。
/tts model_name=valentina01_bright speaker_name=valentina01_bright style=00_Neutral audio こんにちは。
/tts model_name=valentina01_bright speaker_name=valentina01_bright style=01_Bright audio こんにちは。同じモデルとスピーカーで style だけを変えた確認です。
```

Talk mode では provider config の既定値に加えて、Talk params から `voice_id`、`model_name`、`speaker_name`、`style`、`rate`、`style_weight`、`assist_text` などを渡せます。`rate` は WPM として扱われ、SBV2 の `length` に変換されます。指定した model / speaker / style が `/models/info` に無い場合は、operator 向けに整形された validation error が返ります。

Control UI / webchat で音声 artifact が見えない場合でも、Discord など別 channel で配信でき、`/tts status` と debug telemetry が成功しているなら bridge の合成自体は成功しています。UI 表示、添付、再生、channel 変換は OpenClaw 本体または surface 側の責務として切り分けます。

SBV2 API が起動しているローカル環境では live smoke test も実行できます。

```bash
SBV2_BASE_URL=http://127.0.0.1:5000 pnpm test
```

live smoke test は `/status`、`/models/info`、短文 `/voice`、WAV header、invalid model 指定時の失敗を確認します。

## 制作機能の安全運用

SBV2 の制作系 CLI は、TTS 再生よりも処理時間、GPU/CPU 負荷、生成 artifact の量が大きくなります。agent が `datasets prepare`、`training run`、`evaluation run`、`models merge-run` のような長時間処理を始める前には、対象 manifest、入力モデル、出力モデル名、実行 stage、保存先、想定される負荷をユーザーに提示して確認します。

確認文言の例:

```text
SBV2 の長時間処理を開始します。
入力: <manifest または model_assets>
bridge state: <ingest workspace または job output/log>
SBV2 dataset: <resolved dataset_root>/<modelName>
SBV2 loadable model: <resolved assets_root>/<modelName>
job log: <jobs path>
処理: <prepare/training/evaluation/merge と stage>
既存出力への上書きは行いません。開始してよいですか。
```

agent は次の操作を自動実行しません。実行する場合は、対象、理由、退避または復旧方針を明示して人間の確認を挟みます。

- 既存の resolved `dataset_root/<modelName>`、resolved `assets_root/<modelName>`、checkpoint、job artifact の上書き
- dataset、model、checkpoint、job log、evaluation sample の削除
- model artifact、評価音声、入力音声の公開、共有、外部 upload、外部送信
- SBV2 root 外や plugin state 外へ大きな artifact を移動する操作

`datasets prepare`、`training run`、`models merge-run`、`evaluation run` は、ユーザーが同期実行を明示しない限り OpenClaw の sub-agent / background task へ委譲します。親 session は plan、ユーザー確認、起動結果だけを扱い、実行中に `jobs status` を繰り返す poll loop は持ちません。実行中の監視は OpenClaw task ledger を使い、完了後の制作記録は bridge job manifest を使います。

起動直後に親 session へ返す ID は OpenClaw `runId` と `childSessionKey`、または plugin runtime に渡した `sessionKey` と返却された `runId` です。agent tool 経由では `sessions_spawn` の `runId` / `childSessionKey` を、plugin runtime 経由では `api.runtime.subagent.run(...)` の `runId` と呼び出し時の `sessionKey` を記録します。`sbv2-bridge jobId` は起動時に必ず存在するものとして扱わず、完了後の job manifest ID として扱います。

起動直後の報告には、operation、実行 command / cwd、入力 manifest / model / output model name、手動確認コマンド `openclaw tasks show <runId|childSessionKey|sessionKey>`、完了時に sub-agent が bridge `jobId` と summary を返すことを含めます。完了後、sub-agent は CLI JSON、`summary.json`、`manifest.json`、`job.log`、`artifactPaths` を読んで短く報告します。

artifact と log の既定保存先:

- job manifest / status / log: `~/.openclaw/state/style-bert-vits2-bridge/jobs`
- dataset ingest workspace: `~/.openclaw/state/style-bert-vits2-bridge/datasets`
- SBV2 dataset output: `<SBV2 root>/Data/<modelName>`
- SBV2 model assets: `<SBV2 root>/model_assets/<modelName>`
- evaluation / merge summary: 各 job の output directory と `artifactPaths`

SBV2 dataset output と model assets は既定例です。実際の path は SBV2 の `configs/paths.yml`、次に `configs/default_paths.yml`、最後に SBV2 既定値から解決されます。CLI JSON の `pathRoles.sbv2Dataset` と `pathRoles.sbv2LoadableModel`、または非 JSON 出力の `SBV2 dataset:` / `SBV2 loadable model:` を正として扱ってください。bridge state は ingest copy、manifest、job log、summary 用であり、SBV2 FastAPI の `/models/info` / `/voice` は bridge state から model をロードしません。

失敗時は、bridge `jobId` が生成済みなら `sbv2-bridge jobs status <jobId>` と `sbv2-bridge jobs log <jobId> --tail 80` を確認します。bridge `jobId` が無い場合は OpenClaw `runId`、実行 command、cwd、stdout/stderr、入力 manifest / model path、次に見るべき path を返します。次に job の `summary.json`、入力 manifest、CLI の `pathRoles`、既存出力との衝突、SBV2 script や pretrained directory の有無、GPU/依存関係の状態を切り分けます。

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

`datasets prepare` は SBV2 root で `uv run python slice.py ...` と `uv run python transcribe.py ...` を呼び、resolved `dataset_root/<modelName>/raw` と resolved `dataset_root/<modelName>/esd.list` を作成します。slice は SBV2 既定と同じ `min_sec=2`、`max_sec=12`、`min_silence_dur_ms=700`、`num_processes=3` を使います。文字起こしは `litagin/anime-whisper`、batch size 16、初期プロンプト空文字を既定にします。slice / transcription の詳細 option は通常 CLI と OpenClaw agent surface では公開しません。

サブディレクトリごとに音声を置いた場合、その相対構造は SBV2 の `raw/` に渡されるため、style ごとの素材分けに使えます。既存の resolved `dataset_root/<modelName>/raw`、resolved `dataset_root/<modelName>/esd.list`、resolved `assets_root/<modelName>` がある場合は上書きせず失敗します。

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

`--stage resample --stage preprocess-text` のように stage を限定できます。既存の resolved `dataset_root/<modelName>/models` や resolved `assets_root/<modelName>` は上書きしません。実 SBV2 での training 完走検証は bridge の wrapper test では行わず、CLI は計画、preflight、job log、summary、失敗分類を提供します。

学習済みまたは既存の `model_assets` は、SBV2 のモデル本体マージ相当の flow で派生モデルにできます。まず dry-run 相当の plan を確認します。

```bash
sbv2-bridge models merge-plan \
  --method usual \
  --model-a voice_a \
  --model-b voice_b \
  --output-model-name voice_mix \
  --voice-weight 0.4 \
  --voice-pitch-weight 0.2 \
  --speech-style-weight 0.6 \
  --tempo-weight 0.3 \
  --json
```

対応する method は `usual`、`add-diff`、`weighted-sum`、`add-null` です。`usual` / `add-diff` / `add-null` は声質、声の高さ、話し方、テンポの4 weight を指定します。`weighted-sum` は `--model-a-coeff`、`--model-b-coeff`、`--model-c-coeff` を指定します。

モデル本体と複数 style を一貫してマージしたい場合は、`--style-recipe` で style 対応表を渡します。style vector の混合比は SBV2 GUI と同じく、`usual` / `add-diff` / `add-null` では `--speech-style-weight`、`weighted-sum` では A/B/C 係数を使います。style 対応表は method や weight を持たず、実在する style 名の対応だけを持ちます。

```json
{
  "schemaVersion": 1,
  "styles": [
    { "styleA": "Neutral", "styleB": "Happy", "outputStyle": "Happy" }
  ]
}
```

`add-diff` と `weighted-sum` では各行に `styleC` も指定します。

```bash
sbv2-bridge models merge-plan \
  --method usual \
  --model-a voice_a \
  --model-b voice_b \
  --output-model-name voice_mix \
  --speech-style-weight 0.6 \
  --style-recipe ./styles.json \
  --json
```

生成時 `/voice style_weight` は、既に存在する style を音声合成時にどの強さで適用するかの値です。model merge の `--speech-style-weight` や `--style-recipe` による style vector の混合比とは別物です。感情 style の効きが弱い場合は、まず生成時 `style_weight` と sample 音声を確認し、モデルマージ比率の再作成はその後に検討します。

各モデルディレクトリに `.safetensors` が1つだけある場合は自動選択します。複数ある場合は `--model-a-file model_a.safetensors` のように、モデルディレクトリ直下のファイル名を明示します。

実行時は出力名の明示確認が必要です。

```bash
sbv2-bridge models merge-run \
  --method weighted-sum \
  --model-a voice_a \
  --model-b voice_b \
  --model-c voice_c \
  --output-model-name voice_weighted \
  --confirm-output-model-name voice_weighted \
  --model-a-coeff 1 \
  --model-b-coeff -1 \
  --model-c-coeff 0 \
  --base-url http://127.0.0.1:5000 \
  --json
```

`models merge-run` は `model-merge` job、`summary.json`、`recipe.json`、生成された `config.json` / `style_vectors.npy` / `.safetensors` を記録します。`--style-recipe` 指定時は同じ job 内で `style_vectors.npy` と `config.json:data.style2id` を更新し、`style-merge-recipe.json` も記録します。job manifest の `inputSummary` には入力 model、選択された `.safetensors`、weight / coefficient、style recipe、出力 path、recipe path、refresh 結果を入れるため、OpenClaw 側の wrapper は CLI JSON、job manifest、summary から履歴表示や通知用 payload を組み立てられます。

`--base-url` を渡すと SBV2 `/models/refresh` 後に `/models/info` で出力モデルが見えるか確認します。merge artifact の生成後に refresh 確認だけが失敗した場合、job は failed になりますが、生成済みの `model_assets/<outputName>` は削除せず、manifest / summary に `outputAssetsRetained: true` と refresh 結果を記録します。既存の出力モデル名や入力モデル名と同じ出力名は拒否し、上書きはしません。

生成・検証用の運用名で作られたモデルは、SBV2 のモデル選択に使われる `model_assets/<modelName>` ディレクトリ名を安全にリネームできます。まず plan を確認します。

```bash
sbv2-bridge models rename-plan \
  --from-model-name voice_mp3_pathcheck_20260603_1828 \
  --to-model-name valentina_custom \
  --json
```

実行時は変更先モデル名の確認を必須にします。

```bash
sbv2-bridge models rename-run \
  --from-model-name voice_mp3_pathcheck_20260603_1828 \
  --to-model-name valentina_custom \
  --confirm-to-model-name valentina_custom \
  --base-url http://127.0.0.1:5000 \
  --json
```

`models rename-run` は `model_assets/<old>` を `model_assets/<new>` に移動し、`config.json` の `model_name` と、旧モデル名に完全一致する speaker map だけを更新します。SBV2 はモデルを `model_assets` 配下のディレクトリ名で選択するため、`.safetensors` ファイル名は変更しません。学習 dataset も追従させる場合だけ `--include-data` を指定し、`Data/<model>/esd.list` の speaker field も完全一致で更新したい場合は `--rename-esd-speaker` を併用します。

既存の `model_assets/<new>` は上書きしません。`--base-url` を渡すと `/models/refresh` 後に新モデルが見え、旧モデルが見えないことを確認します。refresh 確認だけが失敗した場合、リネーム済み assets は保持し、job manifest / summary に `outputAssetsRetained: true` と refresh 結果を記録します。

この bridge は現時点では OpenClaw runtime へ制作 job event を直接 push しません。OC 側へ伝える境界は production command の `--json` に含まれる `pathRoles`、job manifest、`summary.json`、`job.log` です。OC 側で UI 通知、job timeline、voice list cache refresh が必要な場合は、これらの構造化結果を読む production tool / wrapper 側で扱います。

複数 style の Style ベクトルマージはモデル本体マージとは別操作です。この bridge の初期モデル本体マージは SBV2 upstream と同じく `Neutral` 1件の style を生成し、複数 style の対応表作成や `style_vectors.npy` 更新は #47 の対象です。

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

このbridgeはSBV2 FastAPI server managerではありません。SBV2 serverの起動、停止、GPU/backend選択、モデルファイルの配置、モデルロードはSBV2側または運用スクリプトの責務です。同梱の`skills/voice`には、agentがTTS実行前に専用のdetached tmux sessionでserverを起動し、readinessを確認する手順があります。tmux paneは`remain-on-exit`を有効にし、起動失敗時もログを残します。bridgeは設定済みの`baseUrl`に対して`/models/info`と`/voice`を呼び、失敗時にoperatorが切り分けやすいエラーを返します。

### Telemetry / debug

OpenClaw の `/tts status` は、直近の TTS 試行について `provider`、`fallbackFrom`、`attemptedProviders`、`attempts` を表示します。SBV2 を使ったつもりで別 provider の音声が出た疑いがある場合は、まず `/tts status` で実際の provider と fallback 元を確認してください。

bridge 側では合成成功時に、安全な telemetry metadata と debug log へ resolved profile を出します。確認できる主な項目は `provider=style-bert-vits2`、sanitized `baseUrl`、`voiceId`、`modelName`、`modelId`、`speakerName`、`speakerId`、`style`、`styleWeight`、`length`、`language`、`outputFormat=wav`、`audioBytes` です。

エラー時も同じ安全なcontextをエラーメッセージ末尾に付けます。SBV2 FastAPI server未起動、`baseUrl`誤り、`/models/info`のmodel / speaker / style不一致を切り分ける用途です。primaryの`style-bert-vits2`が失敗してfallback providerが成功した場合でも、bridge由来の失敗理由はOpenClawの`attempts`に残ります。

speech provider plugin contractには、provider自身が後続providerへのfallbackを禁止するfieldがありません。明示的なprovider / model / voice指定を伴うOpenClaw TTS requestは`disableFallback`で対象providerだけを試せますが、自動TTSには現時点で同等のglobal configがありません。自動TTSをfail-closedにするにはOpenClaw本体側の対応が必要です。bridgeはSBV2障害を別の声で隠さず、`Sbv2UnavailableError`として明示します。

debug log と telemetry には、読み上げ本文、`assistText`、音声バイナリ、base64、URL の user/password/query/hash は出しません。secret を `baseUrl` の query や userinfo に入れている場合でも、ログ上は除去されます。

### Troubleshooting

| 症状 | 主な確認点 | 対応 |
|------|------|------|
| `GET /status` が失敗する | SBV2 server 未起動、`baseUrl` 誤り、port違い | SBV2 FastAPI server を起動し、`baseUrl` を `http://127.0.0.1:5000` など実際のURLに合わせる |
| `GET /models/info` が失敗する | モデル未ロード、SBV2 API 側のエラー | SBV2 側でモデル配置とロード状態を確認する |
| `style-bert-vits2` が使われない | OpenClaw provider config、selected provider、fallback | `pnpm run check:sbv2` と `/tts status` の `Fallback` / `Attempts` を確認する |
| Valentina のつもりが別声になる | SBV2 の `model_id=0` fallback、default profile 未指定 | `defaultModelName` / `defaultSpeakerName` を明示する。style 変更では声の同一性は変わらない |
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

dataset ingest workspace も agent workspace ではなく plugin runtime state に保存します。既定の保存先は `~/.openclaw/state/style-bert-vits2-bridge/datasets` です。#32 の ingest は SBV2 の resolved `dataset_root/<modelName>` や resolved `assets_root/<modelName>` へ直接書き込まず、原本を壊さないコピーと manifest 作成だけを行います。

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
