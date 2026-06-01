# ADR 0004: SBV2 Production Capability Surface

- **日付**: 2026-06-01
- **ステータス**: Proposed

## Context

Style-Bert-VITS2 Bridge は、現在 OpenClaw の speech provider として SBV2 `/voice` を呼び出し、WAV を返す再生用途を担当している。

次の段階では、音声ファイルの取り込み、dataset 化、前処理、学習、評価、model_assets への昇格、必要に応じたモデルマージなど、SBV2 の制作・運用機能も agent から扱えるようにしたい。

これらの操作は、通常の TTS 合成よりも影響範囲が大きい。

- 音声素材には利用許諾、本人同意、ライセンス確認が必要になる。
- 前処理、学習、評価、マージは長時間処理になり、GPU/CPU を占有しうる。
- dataset、checkpoint、model_assets、既存モデルを誤って上書きする危険がある。
- 失敗時に、入力、ログ、成果物、再実行可能性を後から追跡できる必要がある。

既存の speech provider contract にこれらを混ぜると、再生経路の責務が曖昧になり、OpenClaw の TTS routing、Talk mode、media delivery と制作 workflow が結合してしまう。

一方で、最初から OpenClaw runtime に専用 capability を追加すると、SBV2 側の CLI/API 詳細が固まる前に plugin SDK surface を先に固定してしまう。

そのため、制作機能は段階的に公開する必要がある。

## Decision

SBV2 の非再生機能は、既存の TTS provider から分離した制作 surface として扱う。

初期実装は bridge repo 内の TypeScript CLI として作る。将来の CLI 名は `sbv2-bridge` とし、製品 CLI の実装は `src/cli`、build artifact は `dist/cli` に置く方針とする。

`scripts/` は診断、開発補助、read-only smoke check の置き場に留める。音声 ingest、dataset 作成、学習、評価、昇格、マージなどの制作 pipeline 本体は `scripts/` には置かない。

OpenClaw agent からの利用は、CLI と job 基盤が安定した後に agent tool として接続する。Agent tool は CLI option をそのまま露出せず、schema、permission class、確認ルールを通して呼び出す。

Plugin-distributed skill は、操作手順、声や style の選択、安全確認の判断補助を担当する。Skill だけで危険操作や長時間処理を直接実行する surface にはしない。

制作機能の権限レベルは次の分類を基本にする。

- `read-only`: status、models、datasets、jobs の一覧や詳細取得。
- `create-artifact`: audio ingest、dataset manifest 作成、前処理成果物、評価 report 作成。
- `long-running`: resample、preprocess、bert generation、style generation、training、evaluation、merge。
- `gpu-heavy`: GPU または大きな CPU load を使う長時間処理。
- `overwrite`: 既存 dataset、checkpoint、model_assets、registry entry に影響する操作。
- `external-impact`: 外部送信、公開、共有、またはローカル環境外への artifact export。

`overwrite` と `external-impact` は、agent が自動実行してはならない。実行前に対象、入力、出力先、rollback または退避方針を明示し、人間の確認を挟む。

長時間処理は同期完了を前提にしない。開始操作は `jobId` を返し、job manifest から状態を追跡する。

Job manifest は、少なくとも次の情報を持つ方針とする。

- `jobId`
- state
- created / started / finished timestamp
- operation kind
- input summary
- output directory
- artifact paths
- log path
- first error
- retryability
- cancellation support

各子 issue で具体機能を実装する時は、SBV2 本体の該当 CLI/API を一次情報として確認してから wrapper contract を決める。

## Rationale

CLI から始めることで、SBV2 の実 CLI、出力ファイル、dataset layout、学習ログ、checkpoint、model_assets 昇格条件を実測しながら wrapper を固められる。

同時に、CLI を bridge repo の製品面として扱うことで、将来の OpenClaw agent tool から同じ実行単位を呼び出せる。これにより、agent tool、手動運用、CI smoke、debug の間で処理経路を共有できる。

代替案として、最初から OpenClaw agent tool を実装する方法がある。しかし、SBV2 の制作 pipeline は長時間処理、GPU 使用、artifact 管理、確認 gate が多く、先に runtime tool schema を固定すると後で破壊的変更が増えやすい。

別の代替案として、すべてを `scripts/` に置く方法がある。この方法は初期実装が簡単だが、制作 pipeline が開発補助 script と同じ扱いになり、配布物、CLI 名、help、exit code、job manifest の責務が曖昧になるため採用しない。

さらに別の代替案として、制作機能を別 plugin または別 repository に分ける方法がある。しかし、TTS provider、voice profile、model discovery、model_assets の扱いは bridge と共有するため、現時点では同じ bridge repo 内に置く方が一貫性がある。

既存 TTS provider は、OpenClaw の speech provider contract に従う再生機能として維持する。制作機能は別 surface として進めることで、`/tts` や Talk mode の安定性を守れる。

## Consequences

良い点:

- TTS provider の責務を再生に限定したまま、制作機能を拡張できる。
- SBV2 の実仕様を確認しながら CLI contract を育てられる。
- 後続の agent tool は、安定した CLI と job manifest を schema 付きで包める。
- 長時間処理、GPU 使用、上書き、外部影響操作を permission class と確認 gate で扱える。
- Job manifest により、進捗、ログ、成果物、失敗理由、再実行可能性を追跡できる。

悪い点・トレードオフ:

- 最初の段階では OpenClaw UI から直接操作できない。
- CLI contract と agent tool contract の二層を保守する必要がある。
- `src/cli` と package entrypoint / bin 定義は後続 issue で追加設計が必要になる。
- OpenClaw plugin SDK に制作 capability が追加される場合、agent tool 接続方針を見直す可能性がある。
- SBV2 本体の CLI/API 変更に追従するため、wrapper 側の互換性確認が必要になる。
