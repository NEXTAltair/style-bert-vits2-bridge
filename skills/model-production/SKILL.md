---
name: model-production
description: Style-Bert-VITS2 の音声素材 ingest から dataset prepare、training、model promotion、evaluation までの制作手順
---

# Model Production — SBV2 学習モデル作成ガイド

このスキルは、音声ファイルまたは音声ディレクトリから Style-Bert-VITS2 (SBV2) の学習モデルを作成する制作 workflow をガイドします。TTS 再生や声色選択は `voice` skill、制作系操作の開始前後チェックは `sbv2-model-ops` skill を使います。

## 基本方針

音声素材からモデルを作る標準順は次の通りです。

1. `datasets ingest`: 音声素材を bridge 管理 workspace にコピーし、dataset manifest を作る
2. `datasets prepare`: SBV2 の slice / transcription を実行し、resolved `dataset_root/<modelName>/raw` と `esd.list` を作る
3. `training plan`: 学習 stage と出力先を確認する
4. `training run`: `resample`、`preprocess_text`、`bert_gen`、`style_gen`、`train_ms` を job として実行する
5. `models candidates`: 昇格できる候補ディレクトリを確認する
6. `models promote`: candidate を resolved `assets_root/<modelName>` に昇格し、SBV2 からロード可能にする
7. `evaluation run`: 昇格後モデルの試聴用 sample と評価 manifest を作る
8. `evaluation note`: 人間の試聴結果を evaluation manifest に記録する

`modelName` は pipeline 全体のキーです。SBV2 の単一話者 workflow に合わせ、別の speaker name や project name は通常入力として持ちません。

保存先は SBV2 の `configs/paths.yml`、次に `configs/default_paths.yml`、最後に SBV2 既定値から解決します。`Data/<modelName>` と `model_assets/<modelName>` は既定例であり、実際の `dataset_root` / `assets_root` が変わっている環境では CLI の `pathRoles` と表示された path を正としてください。

```text
bridge state:
  ingest copy、manifest、job log、summary 用。SBV2 FastAPI からはロードされません。

SBV2 dataset:
  resolved dataset_root/<modelName>。slice/transcribe/preprocess/training 用です。

SBV2 loadable model:
  resolved assets_root/<modelName>。/models/info と /voice が使う runtime model です。
```

## 実行前確認

`datasets ingest`、`datasets prepare`、`training run`、`evaluation run`、`models promote` は artifact 作成、音声素材の永続化、長時間/GPU処理を伴います。開始前にユーザーへ次を提示して確認してください。

```text
SBV2 の制作処理を開始します。
入力: <source path または manifest / candidate>
bridge state: <ingest workspace または job output/log>
SBV2 dataset: <resolved dataset_root>/<modelName>
SBV2 loadable model: <resolved assets_root>/<modelName>
job log: <jobs path>
処理: <ingest/prepare/training/evaluation/promote と stage>
既存出力への上書きは行いません。開始してよいですか。
```

ユーザー確認なしに、既存の resolved `dataset_root/<modelName>`、resolved `assets_root/<modelName>`、checkpoint、job artifact を上書きまたは削除しないでください。生成モデル、評価音声、入力音声の公開、共有、外部 upload、外部送信も行いません。

## Dataset ingest

まず音声素材を bridge workspace に取り込みます。

```bash
sbv2-bridge datasets ingest \
  --model-name my_voice \
  --source /path/to/audio-or-directory \
  --language ja \
  --no-use-jp-extra \
  --json
```

JP-Extra は英語・中国語発話をできなくするため、英語、中国語、多言語発話を残したいモデルでは `--no-use-jp-extra` を明示してください。日本語専用モデルで日本語品質を優先する場合だけ `--use-jp-extra` を使います。

```bash
sbv2-bridge datasets ingest \
  --model-name my_japanese_voice \
  --source /path/to/audio-or-directory \
  --language ja \
  --use-jp-extra \
  --json
```

`--source` は音声ファイルまたはディレクトリです。ディレクトリ直下に複数のサブディレクトリがある場合、その相対構造は style group として manifest に記録されます。

出力の `dataset.manifestPath` を後続工程で使います。`pathRoles.bridgeState` は一時 workspace、`pathRoles.sbv2Dataset` は SBV2 の学習 dataset、`pathRoles.sbv2LoadableModel` は最終的に FastAPI が読む model assets です。

## Dataset prepare

`datasets prepare` は SBV2 root で slice / transcription を呼び、SBV2 が学習に使う dataset を作ります。

```bash
sbv2-bridge datasets prepare \
  --manifest /path/to/manifest.json \
  --json
```

既存の resolved `dataset_root/<modelName>/raw`、resolved `dataset_root/<modelName>/esd.list`、resolved `assets_root/<modelName>` がある場合は上書きせず失敗します。失敗したら `jobs status` と `jobs log` を確認してください。

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

stage を限定する場合は `--stage resample --stage preprocess-text` のように指定します。通常は全 stage を実行します。既存の resolved `dataset_root/<modelName>/models` や resolved `assets_root/<modelName>` は上書きしません。

## Job 確認

長時間処理中または失敗時は、job status と log を確認します。

```bash
sbv2-bridge jobs status <jobId>
sbv2-bridge jobs log <jobId> --tail 80
```

次に `summary.json`、dataset manifest、CLI の `pathRoles`、既存出力との衝突、SBV2 script や pretrained directory、GPU/依存関係を確認します。

## Promotion

候補一覧を確認します。

```bash
sbv2-bridge models candidates \
  --model-name my_voice \
  --json
```

学習済み candidate を resolved `assets_root/<modelName>` に昇格します。実行時は model name の明示確認が必要です。

```bash
sbv2-bridge models promote \
  --model-name my_voice \
  --source /path/to/candidate-directory \
  --confirm-model-name my_voice \
  --base-url http://127.0.0.1:5000 \
  --json
```

`evaluation run` は SBV2 からロード可能な resolved `assets_root/<modelName>` を合成対象にします。学習直後の candidate directory を直接評価せず、先に `models promote` で resolved `assets_root/<modelName>` へ昇格してください。

## Evaluation

昇格後モデルは、固定テスト文セットで sample WAV と評価 manifest を作ります。

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

`reject` または reject recommendation がある model は OpenClaw の既定 voice に採用しません。問題がない場合だけ、OpenClaw provider config の `defaultModelName` / `defaultSpeakerName` / `defaultStyle` を更新します。
