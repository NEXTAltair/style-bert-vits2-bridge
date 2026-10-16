# Irodori制作コマンド

以下の `irodori` は `python3 <plugin-root>/scripts/irodori-workflow.py` または `sbv2-bridge irodori` の略。利用者向けの手操作手順ではなく、agentが実行する入口。

## 声素材の取り込み

```bash
irodori create --name sample --source /audio/selected --caption "自然で聞き取りやすい声" --json
```

`--source` は繰り返せる。ディレクトリは現存する音声を再帰取得する。原本に手を加えず、管理領域の `voices/<name>/ref_*.wav` へコピー/変換する。既定storeは `~/.openclaw/state/style-bert-vits2-bridge/irodori`、`--store` で変更可能。

基盤は既定 `Aratako/Irodori-TTS-v4.1-Small`。`--hf-checkpoint <id>` または `--checkpoint <local model.safetensors>` で明示できる。取り込み時にはダウンロードもGPU処理もしない。推論時は指定モデルが未取得なら公式runtimeがモデルを取得する。

出力の `profilePath` を後続へ渡す。原本の隣の同名 `.txt` があれば学習用台本として保存する。既存の選別manifestがある場合はファイルの現存/hashを確認し、含まれる正確な台本をtraining用JSONLへ転記する。

## 同じ声で話し方だけ調整

```bash
irodori tune --profile /state/voices/sample/profile.json --name sample-bright --tone bright
irodori audition --profile /state/voices/sample/profile.json --candidate /state/voices/sample-bright/profile.json --irodori-root /src/Irodori-TTS --plan
irodori audition --profile /state/voices/sample/profile.json --candidate /state/voices/sample-bright/profile.json --irodori-root /src/Irodori-TTS
```

`--caption <文章>` と `--speed <0.25..4>` も使える。caption明示とtoneを併用するとcaptionを優先する。元profileは変更されない。試聴は既定3短文、必要なら `--texts <UTF-8 file>` (1行1文) または `--text <1文>`。A/Bは同じseed (既定42)、参照/基盤/学習済み資産を固定する。既存ディレクトリへ上書きせず、新しいjob folderへ1文ずつ保存する。

`audition.json` に各ファイルの台本、profile、seed、seconds、SHA256がある。runtimeのstdout/stderrは `job.log`。CLIプロセスが成功でもWAVが無ければfailed。試聴判断は自動採用しない。

## 素材から話者を学習する

Speaker Inversionは基盤重みを固定し、声の同一性を表す小さいトークンを学習する。LoRAは基盤へ適用する差分を学習する。どちらも単独で動く新しい基盤モデルではない。

学習にはローカルの基盤checkpointが必要。profileがHF指定なら、同じモデルの取得済みsnapshotを調べて `--checkpoint` に指定する。別の基盤で学習したembedding/LoRAは使わない。任意のcheckpointへ自動的に置き換えない。

Hugging Faceキャッシュは `snapshots/<revision>/model.safetensors` を指定し、`resolve` / `realpath` で拡張子のない `blobs/<hash>` に置き換えない。公式runtimeは拡張子で形式を判別し、snapshot隣接のtokenizerも参照する。hash検証はリンク先の内容に対して行える。

台本の追加形式:

```jsonl
{"audio":"/absolute/original/clip01.wav","text":"音声で実際に話している内容。"}
{"audio":"/absolute/original/clip02.wav","text":"次の発話。"}
```

`audio` は原本または取り込み済みWAVの絶対パス。重複キーは拒否する。台本なしで学習へ進まない。`--asr-url http://127.0.0.1:<port>` を指定した場合だけ、欠けた台本をローカルの `/v1/audio/transcriptions` から作る。speech.cppならASRモデルがロード済みである必要がある。TTSだけのサーバーへ送ってもASRは動かない。

```bash
irodori train --profile /state/voices/sample/profile.json --checkpoint /models/model.safetensors --transcripts /audio/texts.jsonl --method speaker-inversion --irodori-root /src/Irodori-TTS --plan
irodori train --profile /state/voices/sample/profile.json --checkpoint /models/model.safetensors --transcripts /audio/texts.jsonl --method speaker-inversion --irodori-root /src/Irodori-TTS
```

`--method lora` でLoRA。`--steps` は既定300、`--batch-size` は1。小さな試験の開始値であり、品質が仕上がる学習回数を意味しない。短いrunに長い公式warmupを当てないようconstant schedulerを使い、validation splitとW&Bを無効化している。OOMならGPUを使う既存処理を調べる。他の音声サービスを勝手に止めない。

実行順:

1. 台本と元音声のhash、30s超clip、checkpoint、出力先を検証。
2. `source.jsonl` を作り、公式 `prepare_manifest.py --dataset json --data-files ...` によりローカル素材をlatent化。データの外部uploadはしない。
3. 準備行数とlatentの存在を全件確認。公式prepareがclipを黙ってskipした場合は学習せず停止。
4. 公式 `train.py` を実行し、最終embeddingまたはLoRAの存在を確認。
5. 新しい `profile.json` に基盤hashと成果物を保存し、`job.json` に終了状態を残す。

`job.json` は完了/失敗時のreceipt、実行中は `plan.json` と `job.log` を使う。wrapperの途中resume/cancel APIはない。失敗出力を消して同じ場所へ再実行せず、新しいjob folderを使う。学習済みprofileへの追加学習/optimizer resumeは未実装で、新規runは元のreference profileから始める。

学習後は返却された `profilePath` を `audition` に使う。話者埋め込みには `--ref-embed`、LoRAには `--lora-adapter` を自動的に渡す。

## 試聴メモとAPI設定案

```bash
irodori note --manifest /state/jobs/audition/audition.json --sample A_01 --decision hold --message "語尾が少し沈む"
irodori export --profile /state/jobs/training/profile.json --base-url http://127.0.0.1:8088
```

上のnoteの `--manifest` には実際の `audition.json` のパスを1引数で渡す。noteは原receiptを変更せず、`*-note-<id>.json` を返す。続けて記録する場合は返却された最新manifestを使う。`adopt` も試聴上の採用記録であり、本番TTS切替は行わない。

`export` が返す `config` は `tts.providers.irodori` 向け。`ref_wavs` / `ref_embed` / `lora_adapter` はAPIサーバー側のファイルパス。公式 [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) を同じ基盤checkpointで起動する必要がある。Gradio本体をこのAPIサーバーと混同しない。
