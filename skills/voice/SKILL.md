---
name: "voice"
description: "Style-Bert-VITS2のモデル・speaker・style選択とFastAPIのtmux起動・稼働確認"
---

# Voice — Style-Bert-VITS2 声色選択ガイド

このスキルは、Style-Bert-VITS2 (SBV2) で音声を生成する際のモデル・スピーカー・スタイル選択をガイドします。


## SBV2 FastAPI の起動確認

TTS実行前に`http://127.0.0.1:5000/status`を確認します。応答しない場合は、OpenClaw/Gatewayの実行ターミナルを占有するforeground processや、その子として残す`nohup` / `setsid`ではなく、専用のdetached tmux session `sbv2-fastapi`で起動します。通常運用ではsystemd service登録は不要です。

```bash
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:5000/status
```

疎通しない場合は既存sessionを確認します。

```bash
tmux has-session -t sbv2-fastapi 2>/dev/null
tmux capture-pane -t sbv2-fastapi -p -S - | tail -80
```

sessionが存在する場合は重複起動しません。sessionが無い場合だけ起動します。

```bash
tmux new-session -d -s sbv2-fastapi -c /home/altair/src/Style-Bert-VITS2
tmux set-option -t sbv2-fastapi remain-on-exit on
tmux send-keys -t sbv2-fastapi -l -- 'exec uv run server_fastapi.py'
tmux send-keys -t sbv2-fastapi Enter
```

モデルロードには時間がかかるため、起動後は最大120秒待って`/status`と`/models/info`を確認します。

```bash
for _ in $(seq 1 60); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:5000/status; then
    break
  fi
  sleep 2
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:5000/models/info
```

最後まで失敗する場合は、別のTTS providerへ声を切り替えず、`tmux capture-pane -t sbv2-fastapi -p -S - | tail -120`でログを確認してSBV2 unavailableとして扱います。OpenClaw本体の自動TTSはこのskillを毎回実行するとは限りません。現行のspeech provider plugin contractではbridge自身が後続providerへのfallbackを禁止できないため、自動TTSをfail-closedにするにはOpenClaw本体側の対応が必要です。

基本ルール: model / speaker は声の同一性を決め、style は選択済みモデル内の表情・トーンを決めます。別の声にしたい場合は model / speaker を選び直し、現在の声の表現だけを変えたい場合に style を選びます。

## モデル

SBV2 は `model_assets/` 内のディレクトリ名でモデルを指定します。`/models/info` でロード済みモデル一覧を取得できます。

- `model_name`: ディレクトリ名で指定（`model_id` より優先）
- `model_id`: 数値で指定（デフォルト 0）

モデルは声質・学習済み話者の土台です。「どの声を使うか」を決めるときは style ではなく model を選びます。

## スピーカー

複数話者モデルでは、`esd.list` の登場順で `speaker_id` が決まります（0始まり）。

- `speaker_name`: 話者名で指定（`speaker_id` より優先）
- `speaker_id`: 数値で指定（デフォルト 0）

スピーカーは同じモデル内の話者を決めます。単一話者モデルでは model name と speaker name が同じになることがあります。

## スタイル

スタイルはモデルごとに異なります。SBV2 に渡してよい style 名は、ロード済みモデルの `/models/info` に出る `style2id` のキーだけです。

- `style`: スタイル名（デフォルト "Neutral"）
- `style_weight`: スタイルの強さ（デフォルト 1.0）
  - **1.0 を超えると音声が崩壊する可能性があります**。0.0〜1.0 の範囲で調整してください。

スタイルは「どの声が良いか」を決める項目ではありません。選択済みの model / speaker を保ったまま、明るい、落ち着いた、注意喚起などの表情を切り替える項目です。

`style_weight` は音声生成時に既存 style をどの強さで使うかの値です。`models merge-*` の `--speech-style-weight` や `--style-recipe` による style vector の混合比とは別物です。感情 style の効きが弱い時は、まず生成時 `style_weight` と sample 音声を確認し、モデルマージ比率を変えて作り直す判断はその後に行います。

### style の実体

SBV2 の style は `style_vectors.npy` の行と `config.json` の `data.style2id` の対応で決まります。カスタムモデルでは、raw 音声を `Data/<model>/raw/<style名>/*.wav` のように分類してから style vector を生成します。

`raw` 直下に WAV だけがあるモデルは、基本的に `Neutral` だけになります。style サブフォルダが 2 個以上ある場合は、`Neutral` と各サブフォルダ名が style として生成されます。

`clear`、`soft`、`bright`、`alert` などはエージェント内の tone 分類です。`style2id` に同名の style が存在しない限り、SBV2 に渡す style 名ではありません。`length`、`sdp_ratio`、`noise`、`assist_text` などで作った比較音声も、学習済み style とは別物として扱います。

## 話速

- `length`: 話速の倍率（デフォルト 1.0）。値が大きいほどゆっくり、小さいほど速くなります。

## 感情補助テキスト

別のテキストの感情・声色を混合して音声に反映できます。抑揚やテンポが犠牲になる傾向があります。

- `assist_text`: 感情の参考にするテキスト
- `assist_text_weight`: 補助テキストの影響度（デフォルト 1.0）

`assist_text` は常用しません。短い文脈だけでは意図した tone が出ない場合に、短い補助文を一時的に足します。説明文のような長い補助テキストや、本文と矛盾する感情は避けてください。

## 読み置換辞書

`pronunciationReplacements` / `pronunciationReplacementsPath` は、自然な会話文として読み上げたい語の読みを補正するための辞書です。辞書は「読ませたい言葉の読みを直す」ために使い、そもそも TTS に投げるべきではない text を読める形にする逃げ道として使いません。

辞書に追加してよいもの:

- 製品名: `Style-Bert-VITS2`, `OpenClaw`
- モデル名: `SBV2`, `Valentina`
- よく使う略語: `API`, `TTS`
- 固有名詞や専門語で、モデルが自然な会話文の中で繰り返し読み間違えるもの

辞書で処理しないもの:

- URL
- `Issue: https://...` のような GitHub issue / PR status 行
- shell command
- tool / status / operator output
- error log
- file path
- repo slug
- JSON
- stack trace

これらは読み置換ではなく、TTS に投げる前の eligibility、filter、要約、skip、または tool/status text preparation 側で扱います。たとえば `Issue: https://...` を辞書で救おうとせず、必要なら「Issue を確認しました」のような自然文に変換するか、読み上げ対象から外してください。

読み間違いを見つけた時の triage:

1. その text が自然な会話文として意図して読み上げたい内容か確認する。
2. URL、command、log、status、JSON、path、stack trace なら辞書ではなく eligibility / filter / 要約 / skip 側で扱う。
3. 会話文中の固有名詞、製品名、略語、専門語の継続的な読み間違いなら辞書に追加する。
4. 置換後の文が SBV2 `/voice` の text hard limit を超えないことを確認する。

## Valentina style / emotion 選択

Valentina 系モデルの style は SBV2 共通の emotion taxonomy ではなく、モデルごとの `style2id` に定義された style 名です。`/docs` は API 仕様確認用であり、ロード済みモデル情報は `/models/info` で確認できます。

Valentina などの style 対応モデルでは、まず現在使う `model_name` と `speaker_name` を声の同一性として固定します。その後、現在の感情、文脈、応答温度に合わせて `style2id` 内の style を動的に選びます。

`clear`、`soft`、`serious`、`alert` などの tone は、エージェントが文脈に応じて style を選ぶための分類名です。該当する実 style が無いモデルでは `Neutral` を使い、必要なら推論パラメータで控えめに調整します。

### 選択ルール

1. model / speaker を声の同一性として先に決める。
2. `/models/info` の `style2id` に含まれる style 名だけを `/voice` に渡す。
3. tone 分類は固定 mapping ではなく、エージェントが文脈と `style2id` を見て判断する。
4. style を分類する場合は、必要に応じて以下の用途で考える。
   - `clear`: 明るく聞き取りやすい説明
   - `soft`: 柔らかい応答、落ち着いた相槌
   - `serious`: 注意、事務的な確認、低めの温度感
   - `alert`: 短い警告、割り込み、重要通知
5. `style_weight` はエージェントまたは呼び出し側が文脈に応じて決める。スキル内で tone ごとの固定値を持たない。
6. `assist_text` は style だけで足りない場合にだけ使う。

## 選択の指針

1. まず `/models/info` でロード済みモデルとスピーカーを確認する
2. ユーザーの要望に近い声色の model / speaker を選ぶ
3. 同じ声の表情だけを変える場合は model / speaker を維持し、style だけを変える
4. Valentina 系は `style2id` に存在する style だけを候補にする
5. `style_weight` はエージェントまたは呼び出し側が文脈に応じて決める
6. 話速は 0.8〜1.2 の範囲が自然

## 制作系操作の安全確認

音声素材の ingest、dataset prepare、training、evaluation、model promotion、model merge は TTS 再生よりも影響が大きい制作系操作です。長時間処理や GPU/CPU 高負荷処理を開始する前に、入力、出力名、保存先、stage、既存出力に上書きしないことをユーザーへ確認してください。

agent はユーザー確認なしに、既存 model/dataset/checkpoint/job artifact の上書きや削除、生成モデルや音声 artifact の公開、共有、外部 upload、外部送信を行いません。

失敗時は README の制作機能安全運用に従い、`jobs status`、`jobs log`、`summary.json`、入力 manifest、SBV2 `Data/` と `model_assets/`、GPU/依存関係の順で切り分けます。
