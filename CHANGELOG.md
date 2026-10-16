# Changelog

## 0.3.0 - 2026-10-16

### Added

- Irodori-TTS and speech.cpp speech providers using their OpenAI-compatible WAV APIs.
- `sbv2-bridge irodori` commands for local audio ingestion, versioned delivery adjustments, audition, Speaker Inversion and LoRA training, listening notes, and provider configuration export.
- Bundled `irodori-production` skill, retaining the distinction between reference profiles, speaker embeddings, LoRA adapters, and base-model weights.
- Optional emotion-state-to-SBV2-profile selection with explicit per-request overrides taking precedence.

### Fixed

- Preserve Hugging Face snapshot paths when selecting local checkpoints, retaining the `.safetensors` suffix and adjacent tokenizer discovery rather than resolving to extensionless cache blobs.
- Resolve Talk configuration from the nested SBV2 provider configuration.
- Keep production sources immutable, retain failed-job receipts, and reject incomplete preparation or missing training artifacts.

### Distribution and verification

- Include compiled providers, the Python workflow, bundled skills, and architecture documentation. Exclude Python caches, local voice assets, profiles, and training output.
- Declare peer-install behavior in `pnpm-workspace.yaml` so current pnpm can install the committed lockfile with `--frozen-lockfile`.
- Speaker Inversion and LoRA were each exercised on an RTX 3080 10 GiB with batch size 1, BF16 computation, FP32 weights, and gradient checkpointing: three-step short-clip runs plus ten-step runs with a 27.8-second clip. Both short-run artifacts were reloaded for successful WAV synthesis.
- These are pipeline smoke tests, not evidence of completed voice-quality training. Full-model training, automatic production voice switching, streaming playback, and conversion between Python embeddings/LoRA and speech.cpp `voice.gguf` are not implemented by this workflow.

Existing SBV2 provider IDs, configuration, and production commands remain available. Release publication does not change a running Gateway or its selected voice.
