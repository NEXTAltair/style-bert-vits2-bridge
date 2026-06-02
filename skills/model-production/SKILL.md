---
name: model-production
description: Style-Bert-VITS2 の音声素材 ingest から dataset prepare、training、evaluation、model promotion までの制作手順
---

# Model Production — SBV2 学習モデル作成ガイド

このスキルは、音声ファイルまたは音声ディレクトリから Style-Bert-VITS2 (SBV2) の学習モデルを作成する制作 workflow をガイドします。TTS 再生や声色選択は `voice` skill を使います。

## 基本方針

音声素材からモデルを作る標準順は次の通りです。

1. `datasets ingest`: 音声素材を bridge 管理 workspace にコピーし、dataset manifest を作る
2. `datasets prepare`: SBV2 の slice / transcription を実行し、`Data/<modelName>/raw` と `esd.list` を作る
3. `training plan`: 学習 stage と出力先を確認する
4. `training run`: `resample`、`preprocess_text`、`bert_gen`、`style_gen`、`train_ms` を job として実行する
5. `evaluation run`: 候補モデルの試聴用 sample と評価 manifest を作る
6. `evaluation note`: 人間の試聴結果を evaluation manifest に記録する
7. `models promote`: 評価済み candidate を `model_assets/<modelName>` に昇格する

`modelName` は pipeline 全体のキーです。SBV2 の単一話者 workflow に合わせ、別の speaker name や project name は通常入力として持ちません。

## 実行前確認

`datasets prepare`、`training run`、`evaluation run`、`models promote` は artifact 作成や長時間/GPU処理を伴います。開始前にユーザーへ次を提示して確認してください。

```text
SBV2 の制作処理を開始します。
入力: <source path または manifest / candidate>
出力: <datasets workspace / Data/<modelName> / model_assets/<modelName> / jobs>
処理: <ingest/prepare/training/evaluation/promote と stage>
既存出力への上書きは行いません。開始してよいですか。
```

ユーザー確認なしに、既存の `Data/<modelName>`、`model_assets/<modelName>`、checkpoint、job artifact を上書きまたは削除しないでください。生成モデル、評価音声、入力音声の公開、共有、外部 upload、外部送信も行いません。

## Dataset ingest

まず音声素材を bridge workspace に取り込みます。

```bash
sbv2-bridge datasets ingest \
  --model-name my_voice \
  --source /path/to/audio-or-directory \
  --language ja \
  --use-jp-extra \
  --json
```

`--source` は音声ファイルまたはディレクトリです。ディレクトリ直下に複数のサブディレクトリがある場合、その相対構造は style group として manifest に記録されます。

出力の `dataset.manifestPath` を後続工程で使います。

## Dataset prepare

`datasets prepare` は SBV2 root で slice / transcription を呼び、SBV2 が学習に使う dataset を作ります。

```bash
sbv2-bridge datasets prepare \
  --manifest /path/to/manifest.json \
  --json
```

既存の `Data/<modelName>/raw`、`Data/<modelName>/esd.list`、`model_assets/<modelName>` がある場合は上書きせず失敗します。失敗したら `jobs status` と `jobs log` を確認してください。

## Training

先に plan で stage、出力先、衝突リスクを確認します。

```bash
sbv2-bridge training plan \
  --manifest /path/to/manifest.json \
  --json
```

問題なければ学習を開始します。

```bash
sbv2-bridge training run \
  --manifest /path/to/manifest.json \
  --json
```

stage を限定する場合は `--stage resample --stage preprocess-text` のように指定します。通常は全 stage を実行します。既存の `Data/<modelName>/models` や `model_assets/<modelName>` は上書きしません。

## Job 確認

長時間処理中または失敗時は、job status と log を確認します。

```bash
sbv2-bridge jobs status <jobId>
sbv2-bridge jobs log <jobId> --tail 80
```

次に `summary.json`、dataset manifest、SBV2 `Data/<modelName>` / `model_assets/<modelName>`、既存出力との衝突、SBV2 script や pretrained directory、GPU/依存関係を確認します。

## Evaluation

学習済み candidate は、固定テスト文セットで sample WAV と評価 manifest を作ります。

```bash
sbv2-bridge evaluation run \
  --model-name my_voice \
  --base-url http://127.0.0.1:5000 \
  --json
```

人間の試聴結果は evaluation manifest に記録します。

```bash
sbv2-bridge evaluation note \
  --evaluation /path/to/evaluation.json \
  --case ja-short \
  --decision hold \
  --message "語尾が少し不安定"
```

`reject` または reject recommendation がある model は promotion しません。

## Promotion

候補一覧を確認します。

```bash
sbv2-bridge models candidates \
  --model-name my_voice \
  --json
```

評価済み candidate を `model_assets/<modelName>` に昇格します。実行時は model name の明示確認が必要です。

```bash
sbv2-bridge models promote \
  --model-name my_voice \
  --source /path/to/candidate-directory \
  --confirm-model-name my_voice \
  --evaluation /path/to/evaluation.json \
  --base-url http://127.0.0.1:5000 \
  --json
```

promotion 後は SBV2 `/models/refresh` と `/models/info` の結果を確認し、必要に応じて OpenClaw provider config の `defaultModelName` / `defaultSpeakerName` / `defaultStyle` を更新します。
