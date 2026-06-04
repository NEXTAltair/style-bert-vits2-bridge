---
name: sbv2-model-ops
description: Style-Bert-VITS2 の制作系 CLI 操作を始める前後の確認チェックリスト
---

# SBV2 Model Ops — 制作系操作チェックリスト

このスキルは、TTS 再生より重い SBV2 制作系操作を始める前後の確認に使います。詳細な学習手順は `model-production`、声色選択は `voice` を参照してください。

対象操作:

- `datasets ingest` / `datasets prepare`
- style 素材分類と `style_gen`
- `training run`
- `models merge-plan` / `models merge-run`
- `evaluation run`
- `models promote` / `models rename-*`

## 実行前確認

長時間処理、GPU/CPU 高負荷、artifact 作成、既存 model への影響がある操作では、実行前に次をユーザーへ提示して確認します。

```text
SBV2 の制作処理を開始します。
入力: <source / manifest / model / candidate>
出力名: <modelName または outputModelName>
処理: <ingest/prepare/style/training/merge/evaluation/promote/rename と stage>
設定: <epochs / batch size / merge parameters / base-url>
bridge state: <workspace または job output/log>
SBV2 dataset: <resolved dataset_root>/<modelName>
SBV2 loadable model: <resolved assets_root>/<modelName>
既存出力への上書きは行いません。開始してよいですか。
```

確認なしに、既存 dataset、model assets、checkpoint、job artifact の上書きや削除、生成音声や素材の公開・共有・外部送信を行いません。

## 長めの制作処理の委譲

`datasets prepare`、`training run`、`models merge-run`、`evaluation run` は、ユーザーが同期実行を明示しない限り OpenClaw sub-agent / background task へ委譲します。

親 session では plan、ユーザー確認、起動結果だけ扱い、実行中の poll loop は持ちません。実行中の監視は OpenClaw task ledger を使います。

起動直後に親へ返す ID は OpenClaw `runId` / `childSessionKey`、または plugin runtime に渡した `sessionKey` と返却された `runId` です。`sbv2-bridge jobId` は起動時に必ず存在するものとして扱わず、完了後の job manifest ID として扱います。

sub-agent へ渡す情報:

- operation と full command / cwd
- 入力 manifest、model、output model name、stage、`base-url`
- ユーザー確認済み範囲
- overwrite しない前提
- 外部送信禁止
- 完了後に読むべき CLI JSON、`summary.json`、`manifest.json`、`job.log`、`artifactPaths`

親へすぐ返す情報:

- OpenClaw `runId`
- `childSessionKey` または plugin runtime に渡した `sessionKey`
- operation、実行 command / cwd、入力 / 出力名
- `openclaw tasks show <runId|childSessionKey|sessionKey>`
- 完了時に sub-agent が bridge `jobId` と summary を返すこと

## 実行後確認

処理完了後は、コマンド成功だけで採用判断をしません。次を確認します。

- job manifest、job log、`summary.json`、必要に応じて `recipe.json`
- `config.json` の `model_name`、`data.spk2id`、`data.style2id`
- `style_vectors.npy` と style 数の整合
- `/models/refresh` 後の `/models/info` 登録
- 評価 sample 音声の A/B 比較と人間の listening note

## Merge 判断

`models merge-plan` で入力 model、選択 `.safetensors`、出力名、互換性、weight / coefficient、必要なら `--style-recipe` を先に確認します。

- `usual`: 2モデルの通常ブレンド。声質、pitch、style、tempo の各 weight を調整します。
- `add-diff`: model B と model C の差分を model A に適用します。
- `weighted-sum`: model A/B/C の係数で合成します。
- `add-null`: model B を model A へ足す方向の2モデル合成です。

未指定の merge 数値は `0.5` です。処理成功は artifact 生成の成功であり、意味のあるモデルかどうかは `recipe.json`、`/models/info`、sample 音声で確認します。

## Style Merge 判断

独立した `models style-merge-*` は使いません。複数 style を持つ派生モデルを作る時は、`models merge-plan/run --style-recipe <path>` を使い、モデル本体と `style_vectors.npy` / `config.json:data.style2id` を同じ merge operation の中で一貫して作ります。

`--style-recipe` は style 対応表だけを持ちます。method、model A/B/C、weight / coefficient は `models merge-*` の引数を正とします。

```json
{
  "schemaVersion": 1,
  "styles": [
    { "styleA": "Neutral", "styleB": "Happy", "outputStyle": "Happy" }
  ]
}
```

`usual` / `add-null` では `styleA` / `styleB` / `outputStyle`、`add-diff` / `weighted-sum` では `styleA` / `styleB` / `styleC` / `outputStyle` を使います。style vector の混合比は、`usual` / `add-diff` / `add-null` では `--speech-style-weight`、`weighted-sum` では A/B/C 係数です。

`clear`、`soft`、`bright`、`alert` などの tone ラベルは、実際に `style2id` に存在する style 名として確認できる場合だけ使います。感情 style の効きが弱い時に最初に調整するのは生成時 `/voice style_weight` です。model merge の `--speech-style-weight` はモデルと style vector を作り直す時の混合比であり、既存 style の再生時の強さではありません。

## 失敗時の切り分け

1. bridge `jobId` があれば `sbv2-bridge jobs status <jobId>` と `sbv2-bridge jobs log <jobId> --tail 80`
2. bridge `jobId` が無ければ OpenClaw `runId`、実行 command、cwd、stdout/stderr、入力 manifest / model path
3. `summary.json` / `recipe.json` / job manifest の first error
4. 入力 manifest、model assets、選択 `.safetensors`、出力名衝突
5. `config.json`、`style2id`、`style_vectors.npy`
6. SBV2 scripts、pretrained directory、GPU/CPU、依存関係、`base-url`
