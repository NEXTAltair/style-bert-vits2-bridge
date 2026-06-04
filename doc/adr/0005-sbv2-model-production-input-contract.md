# ADR 0005: SBV2 Model Production Input Contract

- **日付**: 2026-06-01
- **ステータス**: Proposed

## Context

ADR 0004 では、SBV2 の非再生機能を speech provider から分離し、まず bridge repo 内 CLI と job manifest で扱う方針を決めた。

次に、音声素材から SBV2 モデルを作る production pipeline で、OpenClaw agent / bridge がどの入力を受け取り、どの設定を SBV2 既定値に任せるかを決める必要がある。

SBV2 GUI と CLI の通常導線では、音声素材は `Data/<modelName>/raw` に入り、文字起こし、前処理、BERT feature 生成、style feature 生成、学習を経て、推論用 artifact が `model_assets/<modelName>` に出力される。

SBV2 は複数話者を内部表現としては持てるが、通常導線では model name を speaker name として扱う単一話者 workflow が中心である。また、slice、transcription、preprocess、training には多数の詳細設定があるが、初期 bridge surface でそれらをすべて公開すると、CLI / agent tool contract が不必要に大きくなる。

一方で、いくつかの設定は品質や対応言語に大きく影響するため、bridge が暗黙に固定すべきではない。

## Decision

音声素材から SBV2 モデルを作る初期 bridge pipeline は、single-speaker model のみを対象にする。

bridge が通常入力として受け取る値は次の最小セットにする。

```ts
{
  modelName: string,
  sourceAudioPath: string,
  language: "ja" | "en" | "zh",
  useJpExtra: boolean
}
```

`modelName` は SBV2 pipeline 全体の識別子とする。slice、transcribe、preprocess、train、style generation の各段階で同じ `modelName` を使い、`Data/<modelName>` と `model_assets/<modelName>` を結びつける。

bridge は別の `speakerName` 入力を持たない。SBV2 に話者名が必要な箇所では、SBV2 の単一話者フローに合わせて `modelName` を使う。Project 名も別概念として持たない。

`sourceAudioPath` は、生音声ファイルまたはディレクトリを指す。ディレクトリの場合、bridge は入力構造を維持して SBV2 の `raw/` 配下に配置する。`raw/` 配下に 2 個以上のサブディレクトリがある場合、SBV2 2.5+ の通常挙動に従い、サブディレクトリ名を style として style vector が生成される。サブディレクトリが 0 個または 1 個の場合は、SBV2 は Neutral のみを生成する。

文字起こしは Hugging Face Whisper backend を使い、初期既定モデルは `litagin/anime-whisper` とする。これは SBV2 2.7.0 で追加された演技音声・キャラ声向けのモデルであり、この bridge の想定素材に合うためである。`anime-whisper` では initial prompt が無視されるため、初期 bridge surface では `initialPrompt` を公開しない。

`useJpExtra` は通常入力として公開する。JP-Extra は日本語品質を上げる一方で英語・中国語を話せなくなるため、bridge 側で暗黙固定しない。OpenClaw 側の読み置換は入力 text を日本語読みに寄せる処理であり、モデル自体の英語発話能力とは別の問題として扱う。

bridge の既定値は次の通りとする。

```ts
{
  transcriptionBackend: "hf-whisper",
  transcriptionModel: "litagin/anime-whisper",
  transcriptionBatchSize: 16,
  yomiError: "skip",
  notUseCustomBatchSampler: false,
  initialPrompt: null,
  datasetRoot: "SBV2 default",
  assetsRoot: "SBV2 default",
  sliceOptions: "SBV2 default",
  preprocessOptions: "SBV2 GUI/default"
}
```

`yomiError` は bridge 既定値を `skip` とする。SBV2 CLI 単体の既定値 `raise` ではなく、SBV2 GUI の自動前処理既定値に合わせる。読めない書き起こし行があっても処理を継続し、除外された内容は log または job manifest から追跡できるようにする。

`notUseCustomBatchSampler` は初期実装では公開せず、SBV2 GUI 既定値どおり `false` とする。これを `true` にすると 14 秒超の音声も学習対象にできるが、要求 VRAM が増えるため、必要になった時点で advanced option として扱う。

slice の詳細設定、Whisper initial prompt、preprocess 詳細設定、batch size、epochs、save interval、freeze 系設定、validation split、dataset root、assets root は初期 bridge の通常入力として公開しない。この制限は OpenClaw agent tool だけでなく通常 CLI surface にも適用する。SBV2 GUI / CLI の既定値を使い、実際に使った値は job manifest に記録する。

Style 作成タブ相当の探索的 workflow は初期 bridge scope から外す。style は学習 pipeline 中の SBV2 既定処理に任せ、入力音声のサブディレクトリ構造で指定する。UMAP、t-SNE、clustering、代表音声選択による style vector 再生成は、人間が GUI で確認しながら行う advanced workflow として扱う。

モデルマージは、この production pipeline とは別 operation として扱う。既存 `model_assets` を入力にする merge workflow は #41 で扱い、この ADR の scope には含めない。

## Rationale

SBV2 が音声素材からモデルを作る処理本体を持っているため、bridge は slice、transcription、preprocess、training の中身を再実装しない。bridge の責務は、入力 path の検証、SBV2 が期待する配置、実行引数、衝突検出、job/log/artifact path の追跡に限定する。

通常入力を `modelName`、`sourceAudioPath`、`language`、`useJpExtra` に絞ることで、agent から扱いやすい contract にできる。詳細設定は、必要性が実測されるまで SBV2 既定値に任せる方が、GUI との互換性も保ちやすい。

`useJpExtra` は例外的に通常入力へ出す。これは単なる品質 knob ではなく、英語・中国語を話せるモデルにするか、日本語品質を優先するかの設計判断だからである。

`litagin/anime-whisper` は、一般 ASR としての広い用途よりも、演技音声・キャラ声素材の文字起こしに寄った選択である。bridge の主な用途が SBV2 向け voice model production であることを考えると、初期推奨として妥当である。

`yomiError: "skip"` は、長時間 job を一つの読みエラーで止めるより、読めない行を除外して manifest/log に残す方が agent 運用に向く。完全性が必要な場合は、後続の validation / review step で検出できるようにする。

Style 作成タブは、可視化や代表音声の試聴を伴う探索的操作であり、自動 job としての判断基準が曖昧である。初期実装では SBV2 2.5+ のサブディレクトリ style 自動生成に絞る方が安全で再現性が高い。

## Consequences

良い点:

- 初期 agent tool / CLI contract が小さくなる。
- SBV2 GUI / CLI の通常導線とずれにくい。
- `modelName` を pipeline 全体のキーとして扱える。
- style はディレクトリ構造だけで指定でき、追加 UI 判断を持ち込まなくてよい。
- JP-Extra の言語能力トレードオフをユーザーが明示的に選べる。
- 読みエラーで長時間 job が止まりにくい。

悪い点・トレードオフ:

- slice、preprocess、training の細かい調整は初期 bridge からできない。
- `litagin/anime-whisper` が合わない素材では、後で transcription model の advanced override が必要になる。
- `initialPrompt` を公開しないため、固有名詞や句読点の誘導は初期 bridge ではできない。
- `notUseCustomBatchSampler` を公開しないため、長い音声を意図的に学習対象にする workflow は後続対応になる。
- style 作成タブの clustering / manual style workflow は GUI 側に残る。
