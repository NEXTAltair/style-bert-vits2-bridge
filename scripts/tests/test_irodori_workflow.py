import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import wave
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("irodori_workflow", Path(__file__).parents[1] / "irodori-workflow.py")
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / "store"
        self.source = self.root / "source.wav"
        self.write_wav(self.source)
        self.source.with_suffix(".txt").write_text("こんにちは。", encoding="utf-8")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "configs").mkdir()
        for method in ("speaker_inversion", "lora"):
            (self.runtime / "configs" / f"train_v4_small_{method}.yaml").write_text("model: {}\n")
        (self.runtime / "infer.py").write_text('''import argparse, wave
p=argparse.ArgumentParser()
p.add_argument('--output-wav')
a, unknown=p.parse_known_args()
with wave.open(a.output_wav, 'wb') as w:
 w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000); w.writeframes(b'\\0\\1' * 4800)
''')
        (self.runtime / "prepare_manifest.py").write_text('''import argparse, json
from pathlib import Path
p=argparse.ArgumentParser()
for key in ['data-files','output-manifest','latent-dir']: p.add_argument('--'+key)
a,unknown=p.parse_known_args()
dest=Path(a.latent_dir); dest.mkdir()
rows=[json.loads(s) for s in Path(a.data_files).read_text().splitlines()]
with Path(a.output_manifest).open('w') as out:
 for i,row in enumerate(rows):
  latent=dest / (str(i)+'.pt'); latent.write_bytes(b'latent')
  out.write(json.dumps(dict(text=row['text'],latent_path=str(latent),num_frames=25))+'\\n')
''')
        (self.runtime / "train.py").write_text('''import argparse
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument('--output-dir'); p.add_argument('--config')
a,unknown=p.parse_known_args(); dest=Path(a.output_dir); dest.mkdir()
if 'speaker_inversion' in a.config:
 (dest / 'checkpoint_final.speaker.safetensors').write_bytes(b'embedding')
else:
 dest=dest / 'checkpoint_final'; dest.mkdir()
 (dest / 'adapter_config.json').write_text('{}')
 (dest / 'adapter_model.safetensors').write_bytes(b'adapter')
''')
        self.checkpoint = self.root / "model.safetensors"
        self.checkpoint.write_bytes(b"test-model")

    def write_wav(self, file, seconds=0.1):
        with wave.open(str(file), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(48000)
            stream.writeframes(b"\0\1" * int(seconds * 48000))

    def call(self, *args, ok=True):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = workflow.main([args[0], "--store", str(self.store), *map(str, args[1:])])
        self.assertEqual(code, 0 if ok else 1, err.getvalue())
        return json.loads(out.getvalue() if ok else err.getvalue())

    def create(self, **kwargs):
        args = ["create", "--name", kwargs.get("name", "base"), "--source", self.source]
        if kwargs.get("local"):
            args += ["--checkpoint", self.checkpoint]
        args += ["--caption", "近い距離感の声。"]
        return self.call(*args)["profilePath"]

    def runtime_args(self):
        return ["--irodori-root", self.runtime, "--python", sys.executable]

    def test_ingest_copies_and_snapshots_transcripts_without_overwriting(self):
        before = self.source.read_bytes()
        file = self.create()
        data = workflow.read_profile(file)
        self.assertEqual(data["assets"][0]["text"], "こんにちは。")
        self.assertNotEqual(data["assets"][0]["path"], str(self.source))
        self.assertEqual(self.source.read_bytes(), before)
        self.source.with_suffix(".txt").write_text("changed")
        self.assertEqual(workflow.read_profile(file)["assets"][0]["text"], "こんにちは。")
        self.call("create", "--name", "base", "--source", self.source, ok=False)
        self.assertEqual(workflow.read_profile(file), data)

    def test_tone_is_new_profile_with_same_identity_and_inverse_speed(self):
        file = self.create()
        original = Path(file).read_bytes()
        tuned = self.call("tune", "--profile", file, "--name", "bright", "--tone", "bright", "--speed", "1.2")
        candidate = tuned["profile"]
        self.assertEqual(candidate["assets"], workflow.read_profile(file)["assets"])
        self.assertEqual(candidate["model"], workflow.read_profile(file)["model"])
        self.assertIn("近い距離感", candidate["caption"])
        self.assertEqual(Path(file).read_bytes(), original)
        plan = self.call("audition", "--profile", file, "--candidate", tuned["profilePath"], "--plan", *self.runtime_args())
        self.assertEqual(len(plan["commands"]), 6)
        first, second = plan["commands"][:2]
        self.assertEqual(first[first.index("--text") + 1], second[second.index("--text") + 1])
        self.assertEqual(second[second.index("--duration-scale") + 1], str(1 / 1.2))
        self.assertFalse(Path(plan["outputDir"]).exists())

    def test_changed_references_and_changed_checkpoint_are_rejected(self):
        file = self.create(local=True)
        asset = Path(workflow.read_profile(file)["assets"][0]["path"])
        asset.write_bytes(b"changed")
        self.call("inspect", "--profile", file, ok=False)
        other = self.create(name="local", local=True)
        self.checkpoint.write_bytes(b"changed")
        self.call("inspect", "--profile", other, ok=False)

    def test_hf_snapshot_checkpoint_retains_suffix_and_tokenizer_location(self):
        blob = self.root / "blobs" / "opaque-hash"
        blob.parent.mkdir()
        blob.write_bytes(self.checkpoint.read_bytes())
        snapshot = self.root / "snapshots" / "revision" / "model.safetensors"
        snapshot.parent.mkdir(parents=True)
        snapshot.symlink_to(blob)
        created = self.call("create", "--name", "snapshot", "--source", self.source,
                            "--checkpoint", snapshot)
        self.assertEqual(created["profile"]["model"]["value"], str(snapshot))
        self.assertEqual(created["profile"]["model"]["sha256"], workflow.digest(blob))
        for args in ([], ["--checkpoint", snapshot]):
            plan = self.call("train", "--profile", created["profilePath"], "--plan",
                             *args, *self.runtime_args())
            self.assertEqual(plan["baseCheckpoint"], str(snapshot))
            command = plan["commands"][1]
            self.assertEqual(command[command.index("--init-checkpoint") + 1], str(snapshot))
        inference = self.call("audition", "--profile", created["profilePath"], "--plan",
                              *self.runtime_args())["commands"][0]
        self.assertEqual(inference[inference.index("--checkpoint") + 1], str(snapshot))

    def test_speed_nan_is_rejected_without_creating_variant(self):
        file = self.create()
        self.call("tune", "--profile", file, "--name", "bad", "--speed", "nan", ok=False)
        self.assertFalse((self.store / "voices/bad").exists())

    def test_audition_generates_sentence_files_and_versioned_feedback(self):
        file = self.create()
        result = self.call("audition", "--profile", file, "--text", "こんにちは。", *self.runtime_args())
        self.assertEqual(result["state"], "succeeded")
        self.assertGreater(result["samples"][0]["seconds"], 0)
        self.assertEqual(result["samples"][0]["decision"], "pending")
        manifest = Path(result["manifestPath"])
        before = manifest.read_bytes()
        note = self.call("note", "--manifest", manifest, "--sample", "A_01", "--decision", "hold", "--message", "少し暗い")
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual(note["sample"]["note"], "少し暗い")
        self.assertFalse(note["autoAdopt"])

    def test_training_plan_is_read_only_and_surfaces_missing_transcript(self):
        self.source.with_suffix(".txt").unlink()
        file = self.create(local=True)
        result = self.call("train", "--profile", file, "--plan", *self.runtime_args())
        self.assertFalse(result["ready"])
        self.assertEqual(len(result["missingTranscripts"]), 1)
        self.assertIn("json", result["commands"][0])
        self.assertIn("--gradient-checkpointing", result["commands"][1])
        self.assertFalse(Path(result["outputDir"]).exists())

    def test_embedding_training_keeps_base_model_and_creates_consumable_profile(self):
        file = self.create(local=True)
        result = self.call("train", "--profile", file, "--steps", "2", *self.runtime_args())
        self.assertEqual(result["state"], "succeeded")
        learned = workflow.read_profile(result["profilePath"])
        self.assertEqual(learned["kind"], "speaker-inversion")
        self.assertEqual(learned["model"], workflow.read_profile(file)["model"])
        plan = self.call("audition", "--profile", result["profilePath"], "--plan", *self.runtime_args())
        self.assertIn("--ref-embed", plan["commands"][0])
        self.assertNotIn("--ref-wavs", plan["commands"][0])
        exported = self.call("export", "--profile", result["profilePath"])
        self.assertEqual(exported["config"]["irodori"]["ref_embed"], learned["refEmbed"])
        self.assertNotIn("ref_wavs", exported["config"]["irodori"])
        self.assertFalse(exported["applied"])

    def test_lora_training_checks_artifact_and_exports_adapter(self):
        file = self.create(local=True)
        result = self.call("train", "--profile", file, "--method", "lora", *self.runtime_args())
        learned = workflow.read_profile(result["profilePath"])
        self.assertEqual(learned["kind"], "lora")
        exported = self.call("export", "--profile", result["profilePath"])
        self.assertEqual(exported["config"]["irodori"]["lora_adapter"], learned["loraAdapter"])
        self.assertIn("ref_wavs", exported["config"]["irodori"])

    def test_failure_retains_job_receipt_and_does_not_claim_model(self):
        file = self.create(local=True)
        (self.runtime / "train.py").write_text("raise SystemExit(7)")
        dest = self.root / "failed"
        self.call("train", "--profile", file, "--output-dir", dest, *self.runtime_args(), ok=False)
        job = workflow.load_json(dest / "job.json")
        self.assertEqual(job["state"], "failed")
        self.assertIn("7", job["firstError"])
        self.assertFalse((dest / "profile.json").exists())

    def test_prepare_skipping_rows_stops_before_training(self):
        file = self.create(local=True)
        (self.runtime / "prepare_manifest.py").write_text("import sys\nfrom pathlib import Path\nPath(sys.argv[sys.argv.index('--output-manifest')+1]).write_text('')")
        dest = self.root / "skipped"
        self.call("train", "--profile", file, "--output-dir", dest, *self.runtime_args(), ok=False)
        self.assertFalse((dest / "checkpoints").exists())
        self.assertIn("0/1", workflow.load_json(dest / "job.json")["firstError"])

    def test_long_references_are_not_silently_truncated(self):
        self.write_wav(self.source, 121)
        file = self.create(local=True)
        self.call("audition", "--profile", file, "--plan", *self.runtime_args(), ok=False)
        result = self.call("train", "--profile", file, "--plan", *self.runtime_args())
        self.assertFalse(result["ready"])
        self.assertTrue(result["clipsOver30Seconds"])

    def test_asr_never_sends_to_remote_host(self):
        with patch.object(workflow.urllib.request, "build_opener") as opener:
            with self.assertRaises(ValueError):
                workflow.transcribe_local(self.source, "https://example.com")
            opener.assert_not_called()

    def test_local_asr_uses_multipart_audio_and_returns_transcript(self):
        with patch.object(workflow.urllib.request, "build_opener") as builder:
            builder.return_value.open.return_value = io.BytesIO('{"text":"実際の発話。"}'.encode())
            self.assertEqual(workflow.transcribe_local(self.source, "http://127.0.0.1:8080"), "実際の発話。")
            request = builder.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:8080/v1/audio/transcriptions")
            self.assertIn(self.source.read_bytes(), request.data)
            self.assertIn(b'name="response_format"', request.data)

    def test_missing_transcripts_can_be_prepared_with_local_asr(self):
        self.source.with_suffix(".txt").unlink()
        file = self.create(local=True)
        with patch.object(workflow, "transcribe_local", return_value="実際の発話。") as asr:
            result = self.call("train", "--profile", file, "--asr-url", "http://127.0.0.1:8080", *self.runtime_args())
            asr.assert_called_once()
        source = Path(result["outputDir"]) / "source.jsonl"
        self.assertEqual(json.loads(source.read_text())["text"], "実際の発話。")

    def test_tone_comparison_rejects_different_identity(self):
        file = self.create()
        self.source.write_bytes(self.source.read_bytes() + b"trailer")
        other = self.create(name="other")
        self.call("audition", "--profile", file, "--candidate", other, "--plan", *self.runtime_args(), ok=False)

    def test_subprocess_records_only_allowlisted_effective_environment(self):
        script = self.root / "environment_child.py"
        script.write_text(
            "import json, os\n"
            "print(json.dumps({'offline': os.environ.get('HF_HUB_OFFLINE'), "
            "'unbuffered': os.environ.get('PYTHONUNBUFFERED'), "
            "'secretInherited': bool(os.environ.get('TEST_SECRET_TOKEN'))}))\n",
            encoding="utf-8",
        )
        progress_file = self.root / "environment-progress.json"
        with patch.dict(workflow.os.environ, {
            "HF_HUB_OFFLINE": "1", "OMP_NUM_THREADS": "4",
            "PYTHONUNBUFFERED": "0", "TEST_SECRET_TOKEN": "synthetic-not-for-receipt",
        }):
            workflow.os.environ.pop("HF_DATASETS_OFFLINE", None)
            result = workflow.run_command(
                [sys.executable, str(script)], self.root, self.root / "environment.log",
                progress_file=progress_file,
            )
        env = result["executionEnvironment"]
        self.assertEqual(env["HF_HUB_OFFLINE"], "1")
        self.assertEqual(env["OMP_NUM_THREADS"], "4")
        self.assertEqual(env["PYTHONUNBUFFERED"], "1")
        self.assertIsNone(env["HF_DATASETS_OFFLINE"])
        self.assertNotIn("TEST_SECRET_TOKEN", env)
        self.assertNotIn("synthetic-not-for-receipt", json.dumps(result))
        self.assertEqual(workflow.load_json(progress_file)["executionEnvironment"], env)
        actual = json.loads((self.root / "environment.log").read_text().splitlines()[-1])
        self.assertEqual(actual, {"offline": "1", "unbuffered": "1", "secretInherited": True})

    def test_subprocess_progress_records_output_and_saved_step(self):
        script = self.root / "progress_child.py"
        script.write_text(
            "import sys, time\n"
            "from pathlib import Path\n"
            "out = Path(sys.argv[1]); out.mkdir(parents=True)\n"
            "print('Train RF: 50/100', flush=True)\n"
            "(out / 'checkpoint_50.speaker.safetensors').write_bytes(b'embedding')\n"
            "time.sleep(0.35)\n",
            encoding="utf-8",
        )
        progress_file = self.root / "progress.json"
        result = workflow.run_command(
            [sys.executable, str(script), str(self.root / "checkpoints")],
            self.root,
            self.root / "job.log",
            progress_file=progress_file,
            evidence_paths=[self.root / "checkpoints"],
        )
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["observedProgress"]["step"], 50)
        self.assertEqual(result["savedSteps"], [50])
        self.assertEqual(workflow.load_json(progress_file)["savedArtifacts"][0]["size"], 9)

    def test_stall_timeout_interrupts_owned_child_and_keeps_checkpoint_evidence(self):
        script = self.root / "stalled_child.py"
        script.write_text(
            "import sys, time\n"
            "from pathlib import Path\n"
            "out = Path(sys.argv[1]); out.mkdir(parents=True)\n"
            "print('Train RF: 25/100', flush=True)\n"
            "(out / 'checkpoint_25.speaker.safetensors').write_bytes(b'embedding')\n"
            "time.sleep(10)\n",
            encoding="utf-8",
        )
        progress_file = self.root / "stalled-progress.json"
        started = time.monotonic()
        with self.assertRaises(workflow.CommandStalled) as raised:
            workflow.run_command(
                [sys.executable, str(script), str(self.root / "checkpoints")],
                self.root,
                self.root / "stalled.log",
                progress_file=progress_file,
                evidence_paths=[self.root / "checkpoints"],
                stall_timeout=0.35,
            )
        self.assertLess(time.monotonic() - started, 4)
        progress = raised.exception.progress
        self.assertEqual(progress["state"], "stalled")
        self.assertEqual(progress["observedProgress"]["step"], 25)
        self.assertEqual(progress["savedSteps"], [25])
        self.assertTrue((self.root / "checkpoints/checkpoint_25.speaker.safetensors").is_file())
        self.assertEqual(workflow.load_json(progress_file)["state"], "stalled")

    @unittest.skipIf(sys.platform == "win32", "POSIX owned process groups")
    def test_owned_group_is_killed_even_when_leader_exits_on_term(self):
        child = Mock(pid=12345)
        child.poll.return_value = None
        child.wait.return_value = 0
        # Signal 0 keeps reporting a remaining owned descendant.
        with patch.object(workflow.os, "killpg") as killpg:
            workflow._terminate_owned_process(child, grace_seconds=0.01)
        self.assertIn(((12345, workflow.signal.SIGTERM),), killpg.call_args_list)
        self.assertIn(((12345, workflow.signal.SIGKILL),), killpg.call_args_list)

    def test_byte_counts_and_dates_are_not_step_counts(self):
        for line in ["Index Manifest: 0.00/1.43k [00:00<?, ?B/s]", "Started on 2026/10/17"]:
            self.assertEqual(workflow.STEP_RATIO.findall(line), [])

    def test_tqdm_primary_step_is_not_replaced_by_epoch_step(self):
        result = workflow.run_command(
            [sys.executable, "-c", "print('Train RF: 92%|bar| 276/300 [01:39<00:52, epoch_step=1/7, loss=0.8385]')"],
            self.root, self.root / "tqdm.log",
        )
        self.assertEqual(result["observedProgress"]["step"], 276)
        self.assertEqual(result["observedProgress"]["total"], 300)

    def test_lora_step_is_read_from_checkpoint_directory(self):
        checkpoint = self.root / "checkpoints" / "checkpoint_50"
        checkpoint.mkdir(parents=True)
        (checkpoint / "adapter_model.safetensors").write_bytes(b"adapter")
        evidence, steps = workflow._checkpoint_evidence([self.root / "checkpoints"])
        self.assertEqual(steps, [50])
        self.assertEqual(evidence[0]["step"], 50)

    def test_partial_final_progress_line_is_observed(self):
        result = workflow.run_command(
            [sys.executable, "-c", "import sys; sys.stdout.write('Train RF: 7/10')"],
            self.root, self.root / "partial.log",
        )
        self.assertEqual(result["observedProgress"]["step"], 7)

    def test_zero_stall_timeout_does_not_kill_quiet_synthetic_child(self):
        script = self.root / "quiet_child.py"
        script.write_text("import time; time.sleep(0.45)\n", encoding="utf-8")
        result = workflow.run_command(
            [sys.executable, str(script)], self.root, self.root / "quiet.log", stall_timeout=0
        )
        self.assertEqual(result["state"], "succeeded")

    def test_training_stall_receipt_keeps_saved_step_and_no_profile(self):
        file = self.create(local=True)
        (self.runtime / "train.py").write_text(
            "import argparse, time\n"
            "from pathlib import Path\n"
            "p = argparse.ArgumentParser(); p.add_argument('--output-dir')\n"
            "a, _ = p.parse_known_args(); out = Path(a.output_dir); out.mkdir(parents=True)\n"
            "print('Train RF: 5/10', flush=True)\n"
            "(out / 'checkpoint_5.speaker.safetensors').write_bytes(b'embedding')\n"
            "time.sleep(10)\n",
            encoding="utf-8",
        )
        dest = self.root / "training-stalled"
        self.call("train", "--profile", file, "--output-dir", dest,
                  "--stall-timeout", "0.35", *self.runtime_args(), ok=False)
        receipt = workflow.load_json(dest / "job.json")
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["savedSteps"], [5])
        self.assertTrue((dest / "checkpoints/checkpoint_5.speaker.safetensors").is_file())
        self.assertFalse((dest / "profile.json").exists())


if __name__ == "__main__":
    unittest.main()
