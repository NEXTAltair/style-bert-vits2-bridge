#!/usr/bin/env python3
"""Local, non-destructive Irodori voice production. No third-party wrapper dependencies."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid
import urllib.parse
import urllib.request
import wave


DEFAULT_STORE = Path.home() / ".openclaw/state/style-bert-vits2-bridge/irodori"
AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac"}
TEST_TEXTS = [
    "おかえり。今日の作業は、ここまで進んだよ。",
    "設定を確認した。接続先を変えて、もう一度試してみるね。",
    "明日の午後三時十五分に、もう一度知らせるよ。",
]
TONES = {
    "bright": "声の個性は保ち、明るく親しみやすい自然な話し方。",
    "calm": "声の個性は保ち、落ち着いた自然な話し方。抑揚を消さず、暗く沈みすぎない。",
    "neutral": "声の個性は保ち、自然な会話調。感情を誇張せず、聞き取りやすく話す。",
}


def load_json(file: Path) -> dict:
    with file.open(encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {file}")
    return value


def save_new(file: Path, data: dict) -> None:
    with file.open("x", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def digest(file: Path) -> str:
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def checkpoint_path(value: str) -> Path:
    # HF snapshots link model.safetensors to an extensionless blob. Upstream uses
    # the suffix and adjacent tokenizer files, so retain the snapshot path.
    return Path(os.path.abspath(str(Path(value).expanduser())))


def wav_seconds(file: Path) -> float:
    with wave.open(str(file), "rb") as audio:
        if audio.getnchannels() < 1 or audio.getframerate() <= 0 or audio.getnframes() <= 0:
            raise ValueError(f"Empty or invalid WAV: {file}")
        return audio.getnframes() / audio.getframerate()


def safe_name(value: str) -> str:
    if not value or value in {".", ".."} or any(c in value for c in '/\\\0:'):
        raise ValueError("Name must be one directory component, without /, \\, or :")
    return value


def runtime(args) -> tuple[Path, str]:
    root = Path(args.irodori_root).expanduser().resolve()
    python = args.python or str(root / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python"))
    for script in ("infer.py", "prepare_manifest.py", "train.py"):
        if not (root / script).is_file():
            raise ValueError(f"Irodori source missing {script}: {root}")
    if not Path(python).is_file() and shutil.which(python) is None:
        raise ValueError(f"Irodori Python not found: {python}")
    return root, python


def read_profile(file: str | Path, *, verify: bool = True) -> dict:
    file = Path(file).expanduser().resolve()
    data = load_json(file)
    if data.get("schemaVersion") != 1 or data.get("engine") != "irodori":
        raise ValueError(f"Not an Irodori voice profile: {file}")
    if not isinstance(data.get("model"), dict) or data["model"].get("source") not in {"local", "hf"}:
        raise ValueError(f"Invalid base model: {file}")
    if not isinstance(data.get("assets"), list) or not data["assets"]:
        raise ValueError(f"Profile has no source audio: {file}")
    if not isinstance(data.get("caption"), str):
        raise ValueError(f"Invalid caption: {file}")
    speed = data.get("speed")
    if not isinstance(speed, (float, int)) or not math.isfinite(speed) or not 0.25 <= speed <= 4:
        raise ValueError(f"Speed must be between 0.25 and 4: {file}")
    if verify:
        for asset in data["assets"]:
            if digest(Path(asset["path"])) != asset["sha256"]:
                raise ValueError(f"Source audio changed: {asset['path']}")
        model = data["model"]
        if model["source"] == "local" and digest(Path(model["value"])) != model["sha256"]:
            raise ValueError("Base checkpoint changed since profile creation")
        for field in ("refEmbed", "loraAdapter"):
            if data.get(field) and not Path(data[field]).exists():
                raise ValueError(f"Missing {field}: {data[field]}")
        if data.get("refEmbed") and digest(Path(data["refEmbed"])) != data.get("refEmbedSha256"):
            raise ValueError("Speaker embedding changed since training")
        if data.get("loraAdapter"):
            for name, sha in data.get("loraFiles", {}).items():
                if digest(Path(data["loraAdapter"]) / name) != sha:
                    raise ValueError(f"LoRA artifact changed: {name}")
    return data


def ingest(args) -> dict:
    sources: list[Path] = []
    for raw in args.source:
        source = Path(raw).expanduser().resolve()
        if source.is_dir():
            sources.extend(sorted(p for p in source.rglob("*") if p.is_file() and not p.is_symlink() and p.suffix.lower() in AUDIO_EXTENSIONS))
        elif source.is_file() and source.suffix.lower() in AUDIO_EXTENSIONS:
            sources.append(source)
        else:
            raise ValueError(f"Not a supported audio source: {source}")
    sources = list(dict.fromkeys(sources))
    if not sources:
        raise ValueError("No audio files found")
    name = safe_name(args.name)
    dest = Path(args.store).expanduser().resolve() / "voices" / name
    # Resolve the source list before creating the output; never re-ingest our own copies.
    if any(dest == p or dest in p.parents for p in sources):
        raise ValueError("Output directory contains source files")
    model = {"source": "hf", "value": args.hf_checkpoint or "Aratako/Irodori-TTS-v4.1-Small"}
    if args.checkpoint:
        checkpoint = checkpoint_path(args.checkpoint)
        model = {"source": "local", "value": str(checkpoint), "sha256": digest(checkpoint)}
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.mkdir()  # exclusive: even partial or failed prior output is retained
    assets = []
    for index, source in enumerate(sources, 1):
        output = dest / f"ref_{index:04d}.wav"
        source_sha = digest(source)
        try:
            seconds = wav_seconds(source)
            shutil.copyfile(source, output)
        except (wave.Error, EOFError):
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-n", "-i", str(source), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(output)], check=True, stdout=subprocess.DEVNULL)
            seconds = wav_seconds(output)
        sidecar = source.with_suffix(".txt")
        assets.append({"path": str(output), "source": str(source), "sourceSha256": source_sha, "sha256": digest(output), "seconds": seconds,
                       "text": sidecar.read_text(encoding="utf-8").strip() if sidecar.is_file() else None})
    profile = {"schemaVersion": 1, "engine": "irodori", "name": name, "kind": "reference",
               "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": model,
               "assets": assets, "caption": args.caption or "", "speed": 1.0,
               "totalSeconds": sum(item["seconds"] for item in assets)}
    file = dest / "profile.json"
    save_new(file, profile)
    return {"profilePath": str(file), "profile": profile, "weightsTrained": False,
            "warnings": ["References exceed 120s: select fewer clips for cloning, or train a speaker embedding."] if profile["totalSeconds"] > 120 else []}


def tune(args) -> dict:
    profile = read_profile(args.profile)
    if args.caption is None and args.tone is None and args.speed is None:
        raise ValueError("Specify --caption, --tone, or --speed")
    name = safe_name(args.name)
    if args.caption is not None:
        profile["caption"] = args.caption
    elif args.tone:
        # Retain any existing identity description; delivery follows it.
        profile["caption"] = f"{profile['caption']} {TONES[args.tone]}".strip()
    if args.speed is not None:
        if not math.isfinite(args.speed) or not 0.25 <= args.speed <= 4:
            raise ValueError("Speed must be between 0.25 and 4")
        profile["speed"] = args.speed
    profile.update(name=name, parentProfile=str(Path(args.profile).expanduser().resolve()),
                   createdAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    dest = Path(args.store).expanduser().resolve() / "voices" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.mkdir()
    file = dest / "profile.json"
    save_new(file, profile)
    return {"profilePath": str(file), "profile": profile, "weightsTrained": False, "listeningDecision": "pending"}


def reference_options(profile: dict) -> tuple[list[str], dict]:
    if profile.get("refEmbed"):
        return ["--ref-embed", profile["refEmbed"]], {"ref_embed": profile["refEmbed"]}
    if sum(asset["seconds"] for asset in profile["assets"]) > 120:
        raise ValueError("Reference audio exceeds 120s. Select clips explicitly or use a trained speaker embedding; no silent truncation.")
    files = [asset["path"] for asset in profile["assets"]]
    return ["--ref-wavs", *files], {"ref_wavs": files}


def inference_command(root: Path, python: str, profile: dict, text: str, output: Path, seed: int) -> list[str]:
    if not text.strip():
        raise ValueError("Synthesis text must not be empty")
    model = profile["model"]
    ref_args, _ = reference_options(profile)
    command = [python, str(root / "infer.py"), "--checkpoint" if model["source"] == "local" else "--hf-checkpoint", model["value"],
               "--text", text, "--output-wav", str(output), "--seed", str(seed), "--duration-scale", str(1.0 / profile["speed"]), *ref_args]
    if profile["caption"]:
        command.extend(["--caption", profile["caption"]])
    if profile.get("loraAdapter"):
        command.extend(["--lora-adapter", profile["loraAdapter"]])
    return command


def run_command(command: list[str], root: Path, log: Path) -> None:
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(command, ensure_ascii=False) + "\n")
        stream.flush()
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        with subprocess.Popen(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT, env=env) as child:
            try:
                code = child.wait()
            except BaseException:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                raise
        if code != 0:
            raise RuntimeError(f"Command exited {code}; see {log}")


def job_dir(args, prefix: str) -> Path:
    return Path(args.output_dir).expanduser().resolve() if args.output_dir else Path(args.store).expanduser().resolve() / "jobs" / f"{prefix}-{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"


def audition(args) -> dict:
    root, python = runtime(args)
    profiles = [("A", str(Path(args.profile).expanduser().resolve()), read_profile(args.profile))]
    if args.candidate:
        candidate = read_profile(args.candidate)
        if candidate["model"] != profiles[0][2]["model"] or candidate["assets"] != profiles[0][2]["assets"] or candidate.get("refEmbed") != profiles[0][2].get("refEmbed") or candidate.get("loraAdapter") != profiles[0][2].get("loraAdapter"):
            raise ValueError("Tone comparison must keep base model, references, embedding, and LoRA fixed")
        profiles.append(("B", str(Path(args.candidate).expanduser().resolve()), candidate))
    texts = [args.text] if args.text is not None else TEST_TEXTS
    if args.texts:
        texts = [s.strip() for s in Path(args.texts).expanduser().read_text(encoding="utf-8").splitlines() if s.strip()]
    if not texts:
        raise ValueError("No test texts")
    dest = job_dir(args, "audition")
    commands, samples = [], []
    for index, text in enumerate(texts, 1):
        for label, file, profile in profiles:
            name = f"{label}_{index:02d}.wav"
            output = dest / name
            commands.append(inference_command(root, python, profile, text, output, args.seed))
            samples.append({"id": name[:-4], "profilePath": file, "text": text, "seed": args.seed, "path": str(output), "decision": "pending"})
    plan = {"operation": "audition", "outputDir": str(dest), "commands": commands, "samples": samples}
    if args.plan:
        return plan
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.mkdir()
    receipt = {**plan, "state": "running"}
    save_new(dest / "plan.json", plan)
    try:
        for command, sample in zip(commands, samples):
            run_command(command, root, dest / "job.log")
            sample["seconds"] = wav_seconds(Path(sample["path"]))
            sample["sha256"] = digest(Path(sample["path"]))
        receipt["state"] = "succeeded"
    except BaseException as error:
        receipt.update(state="failed", firstError=str(error) or type(error).__name__)
        raise
    finally:
        save_new(dest / "audition.json", receipt)
    return {"manifestPath": str(dest / "audition.json"), **receipt}


def transcript_map(file: str | None) -> dict[str, str]:
    result = {}
    if file:
        with Path(file).expanduser().open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                audio, text = row.get("audio"), row.get("text")
                if not isinstance(audio, str) or not isinstance(text, str) or not text.strip():
                    raise ValueError("Transcript JSONL rows require audio (path) and non-empty text")
                key = str(Path(audio).expanduser().resolve())
                if key in result:
                    raise ValueError(f"Duplicate transcript path: {key}")
                result[key] = text.strip()
    return result


def transcribe_local(file: Path, url: str) -> str:
    base = urllib.parse.urlsplit(url)
    if base.scheme != "http" or base.hostname not in {"127.0.0.1", "localhost", "::1"} or base.username or base.password:
        raise ValueError("Automatic ASR accepts only a loopback HTTP server; never uploads source audio to a cloud service")
    boundary = "irodori-" + uuid.uuid4().hex
    audio = file.read_bytes()
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + audio + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--{boundary}--\r\n'.encode())
    request = urllib.request.Request(url.rstrip("/") + "/v1/audio/transcriptions", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise ValueError("ASR redirects are not followed")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    with opener.open(request, timeout=300) as response:
        text = json.load(response).get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("ASR returned no transcript")
    return text.strip()


def training(args) -> dict:
    root, python = runtime(args)
    profile = read_profile(args.profile)
    if args.steps < 1 or args.batch_size < 1:
        raise ValueError("Training steps and batch size must be positive")
    if profile.get("refEmbed") or profile.get("loraAdapter"):
        raise ValueError("Start a new training run from the reference profile; continuation of trained adapters is not implemented")
    checkpoint = checkpoint_path(args.checkpoint) if args.checkpoint else Path(profile["model"]["value"]) if profile["model"]["source"] == "local" else None
    if checkpoint is None or not checkpoint.is_file():
        raise ValueError("Training needs the local base checkpoint via --checkpoint (resolve the profile's Hugging Face base first)")
    if profile["model"]["source"] == "local" and digest(checkpoint) != profile["model"]["sha256"]:
        raise ValueError("Training checkpoint differs from the profile base model")
    config = root / "configs" / f"train_v4_small_{'speaker_inversion' if args.method == 'speaker-inversion' else 'lora'}.yaml"
    if not config.is_file():
        raise ValueError(f"Missing upstream training configuration: {config}")
    transcripts = transcript_map(args.transcripts)
    rows = []
    for asset in profile["assets"]:
        text = transcripts.get(asset["path"]) or transcripts.get(asset["source"]) or asset.get("text")
        rows.append({"audio": asset["path"], "text": text, "caption": profile["caption"], "speaker": profile["name"]})
    missing = [row["audio"] for row in rows if not row["text"]]
    # Short clips match upstream training limits; do not let prepare silently skip them.
    too_long = [asset["path"] for asset in profile["assets"] if asset["seconds"] > 30]
    dest = job_dir(args, "training")
    commands = [
        [python, str(root / "prepare_manifest.py"), "--dataset", "json", "--data-files", str(dest / "source.jsonl"), "--audio-column", "audio", "--text-column", "text", "--caption-column", "caption", "--speaker-column", "speaker", "--speaker-id-prefix", profile["name"], "--output-manifest", str(dest / "train.jsonl"), "--latent-dir", str(dest / "latents"), "--device", args.device],
        [python, str(root / "train.py"), "--config", str(config), "--manifest", str(dest / "train.jsonl"), "--init-checkpoint", str(checkpoint), "--output-dir", str(dest / "checkpoints"), "--device", args.device, "--max-steps", str(args.steps), "--batch-size", str(args.batch_size), "--num-workers", "0", "--gradient-checkpointing", "--lr-scheduler", "none", "--valid-ratio", "0", "--no-wandb"],
    ]
    plan = {"operation": "training", "method": args.method, "baseCheckpoint": str(checkpoint), "baseSha256": digest(checkpoint),
            "outputDir": str(dest), "commands": commands, "missingTranscripts": missing, "clipsOver30Seconds": too_long,
            "ready": (not missing or bool(args.asr_url)) and not too_long, "autoAdopt": False}
    if args.plan:
        return plan
    if too_long:
        raise ValueError("Split source clips over 30s before training; source audio is not modified automatically")
    if missing and not args.asr_url:
        raise ValueError("Missing transcripts: provide matching .txt sidecars, --transcripts JSONL, or --asr-url for local ASR")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.mkdir()
    receipt = {**plan, "state": "running"}
    save_new(dest / "plan.json", plan)
    try:
        for row in rows:
            if not row["text"]:
                row["text"] = transcribe_local(Path(row["audio"]), args.asr_url)
        with (dest / "source.jsonl").open("x", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        run_command(commands[0], root, dest / "job.log")
        with (dest / "train.jsonl").open(encoding="utf-8") as stream:
            prepared = [json.loads(line) for line in stream if line.strip()]
        if len(prepared) != len(rows) or not prepared:
            raise ValueError(f"Preparation retained {len(prepared)}/{len(rows)} clips; inspect job.log before training")
        for row in prepared:
            if not row.get("text") or not row.get("num_frames", 0) > 0 or not (dest / row["latent_path"]).is_file():
                raise ValueError("Upstream preparation returned an incomplete latent row")
        run_command(commands[1], root, dest / "job.log")
        trained = copy.deepcopy(profile)
        trained.update(kind=args.method, parentProfile=str(Path(args.profile).expanduser().resolve()),
                       createdAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       model={"source": "local", "value": str(checkpoint), "sha256": plan["baseSha256"]})
        if args.method == "speaker-inversion":
            artifact = dest / "checkpoints/checkpoint_final.speaker.safetensors"
            if not artifact.is_file() or artifact.stat().st_size == 0:
                raise ValueError("Training did not create the final speaker embedding")
            trained.update(refEmbed=str(artifact), refEmbedSha256=digest(artifact))
        else:
            artifact = dest / "checkpoints/checkpoint_final"
            required = ("adapter_config.json", "adapter_model.safetensors")
            if not all((artifact / name).is_file() and (artifact / name).stat().st_size for name in required):
                raise ValueError("Training did not create a complete final LoRA adapter")
            trained.update(loraAdapter=str(artifact), loraFiles={str(file.relative_to(artifact)): digest(file) for file in artifact.rglob("*") if file.is_file()})
        save_new(dest / "profile.json", trained)
        receipt.update(state="succeeded", profilePath=str(dest / "profile.json"), artifactPath=str(artifact))
    except BaseException as error:
        receipt.update(state="failed", firstError=str(error) or type(error).__name__)
        raise
    finally:
        save_new(dest / "job.json", receipt)
    return receipt


def export_config(args) -> dict:
    profile = read_profile(args.profile)
    _, options = reference_options(profile)
    options["caption"] = profile["caption"]
    if profile.get("loraAdapter"):
        options["lora_adapter"] = profile["loraAdapter"]
    return {"provider": "irodori", "config": {"baseUrl": args.base_url, "model": "irodori-tts", "voice": "none", "speed": profile["speed"], "irodori": options},
            "baseModel": profile["model"], "requiresSameBaseCheckpoint": True, "applied": False}


def note(args) -> dict:
    file = Path(args.manifest).expanduser().resolve()
    data = load_json(file)
    sample = next((item for item in data.get("samples", []) if item["id"] == args.sample), None)
    if sample is None:
        raise ValueError(f"Unknown audition sample: {args.sample}")
    sample.update(decision=args.decision, note=args.message)
    # Versioned annotation: never rewrite generation evidence or another listening note.
    dest = file.with_name(f"{file.stem}-note-{uuid.uuid4().hex[:8]}.json")
    data["parentManifest"] = str(file)
    save_new(dest, data)
    return {"manifestPath": str(dest), "sample": sample, "autoAdopt": False}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("status", "create", "tune", "inspect", "list", "audition", "train", "export", "note"):
        sub = commands.add_parser(command)
        sub.add_argument("--store", default=str(DEFAULT_STORE))
        sub.add_argument("--json", action="store_true", help="Output is always JSON; retained for CLI consistency")
        if command in {"status", "audition", "train"}:
            sub.add_argument("--irodori-root", default=os.environ.get("IRODORI_ROOT", str(Path.home() / "src/Irodori-TTS")))
            sub.add_argument("--python", help="Python from the Irodori environment; no dependency installation")
        if command in {"tune", "inspect", "audition", "train", "export"}:
            sub.add_argument("--profile", required=True)
        if command in {"create", "tune"}:
            sub.add_argument("--name", required=True)
            sub.add_argument("--caption")
        if command == "create":
            sub.add_argument("--source", action="append", required=True)
            model = sub.add_mutually_exclusive_group()
            model.add_argument("--checkpoint")
            model.add_argument("--hf-checkpoint")
        if command == "tune":
            sub.add_argument("--tone", choices=TONES)
            sub.add_argument("--speed", type=float)
        if command in {"audition", "train"}:
            sub.add_argument("--output-dir")
            sub.add_argument("--plan", action="store_true", help="Read-only execution plan")
        if command == "audition":
            sub.add_argument("--candidate", help="Compare delivery changes with identity held fixed")
            texts = sub.add_mutually_exclusive_group()
            texts.add_argument("--text")
            texts.add_argument("--texts", help="UTF-8, one sentence per line")
            sub.add_argument("--seed", type=int, default=42)
        if command == "train":
            sub.add_argument("--method", choices=("speaker-inversion", "lora"), default="speaker-inversion")
            sub.add_argument("--checkpoint", help="Local base checkpoint matching the profile")
            sub.add_argument("--transcripts", help="JSONL rows with absolute audio path and text")
            sub.add_argument("--asr-url", help="Local OpenAI-compatible transcription server; no cloud upload")
            sub.add_argument("--steps", type=int, default=300)
            sub.add_argument("--batch-size", type=int, default=1)
            sub.add_argument("--device", default="cuda")
        if command == "export":
            sub.add_argument("--base-url", default="http://127.0.0.1:8088")
        if command == "note":
            sub.add_argument("--manifest", required=True)
            sub.add_argument("--sample", required=True)
            sub.add_argument("--decision", required=True, choices=("adopt", "hold", "reject"))
            sub.add_argument("--message", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            root, python = runtime(args)
            result = {"irodoriRoot": str(root), "python": python, "sourceAvailable": True, "gpuTested": False,
                      "serverRequiredForProduction": False, "store": str(Path(args.store).expanduser())}
        elif args.command == "inspect":
            result = read_profile(args.profile)
        elif args.command == "list":
            result = {"profiles": [str(file) for file in sorted((Path(args.store).expanduser() / "voices").glob("*/profile.json"))]}
        else:
            result = {"create": ingest, "tune": tune, "audition": audition, "train": training, "export": export_config, "note": note}[args.command](args)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"ok": False, "error": str(error) or type(error).__name__}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"Interrupted by signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
