# Changelog

## 0.3.1 - 2026-10-16

### Fixed

- Type-check production code and tests against the real published OpenClaw 2026.10.4 SDK instead of plugin-owned ambient stubs. Use its typed `plugin-entry` facade and a typed registration API.
- Remove unsupported speech `capabilities` / `resolveCapabilities` fields. Preserve the SBV2 OpenAPI-based input guard immediately before synthesis; the current host does not consume provider-specific input-limit advertisements.
- Return `{ handled: false }` for unknown or policy-blocked directives.
- Honor the SDK's direct voice-list URL/key overrides and resolved request timeout.
- Resolve Irodori/speech.cpp configuration from the host's whole TTS envelope instead of treating that envelope as one provider's settings.
- Use current top-level `tts.providers` configuration in examples and `OPENCLAW_CONFIG_PATH` in runtime diagnostics.
- Provide the current-main async configuration hook alongside the synchronous hook still required by the published SDK.

### Compatibility

- Use 2026.9.9 as the modern speech-contract compatibility floor and 2026.10.4 as the pinned development SDK, not an exhaustively tested historical cutoff. Existing names and provider IDs are unchanged.
- Pin the real SDK as a development dependency; it is not bundled into the release archive. Production code and fixture contexts derive their types from that SDK.

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
