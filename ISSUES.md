# Issues

## 2026-05-27 - Gap audit: still a thin TTS provider, not a finished bridge

### Summary
The runtime path is alive: `openclaw plugins inspect style-bert-vits2-bridge --runtime --json` imports the plugin and reports speech provider `style-bert-vits2`. `pnpm run check`, `pnpm test`, and `pnpm run build` pass. The missing work is mostly productization and integration depth, not the first `/voice` call.

### Confirmed observations
- Runtime inspect reports `shape: plain-capability` and `speechProviderIds: ["style-bert-vits2"]`.
- Cold inspect/list can show no `speechProviderIds`; use `--runtime` to prove live capability registration.
- Initial audit found the local SBV2 API unreachable, but a follow-up after operator startup confirmed `http://127.0.0.1:5000` is healthy.
- Live SBV2 checks passed: `GET /status`, `GET /models/info`, default short `POST /voice`, and a Valentina-targeted `POST /voice` all returned successfully.
- `dist/index.js` cannot be imported directly outside the OpenClaw runtime because `openclaw/plugin-sdk/*` is resolved by OpenClaw, not this package's local dependencies.
- Bundled `voice` skill is eligible and model-visible.
- The bridge config schema uses `defaultModelName/defaultSpeakerId/defaultSpeakerName/defaultStyle`, but the runtime provider reads `modelName/speakerId/speakerName/style/language`. That mismatch means manifest/UI config defaults are not actually applied by `src/index.ts`.
- Current OpenClaw config only sets `messages.tts.providers.style-bert-vits2.baseUrl`, so bridge synthesis without explicit model fields will fall back to SBV2 model_id `0` (`amitaro` in the observed model list), not the preferred Valentina model.

### Live API snapshot
- `GET /status`: healthy; devices include `cpu` and `cuda:0`.
- Observed Valentina models in `/models/info`: `valentina`, `valentina01`, `valentina01_bright`, `valentina02`.
- Default `/voice` smoke: HTTP 200, WAV/RIFF, 140332 bytes.
- Valentina-targeted `/voice` smoke with `model_name=valentina01_bright`, `speaker_name=valentina01_bright`, `style=00_Neutral`: HTTP 200, WAV/RIFF, 177196 bytes.

### Highest priority gaps
1. Align config names and runtime reads.
   - Either change the manifest/README to `modelName/speakerId/speakerName/style/language`, or make the provider read both `default*` and legacy non-default keys.
   - Add tests that prove configured defaults reach `Sbv2Client.synthesize()`.
2. Add Talk-mode mapping.
   - Implement `resolveTalkConfig` and `resolveTalkOverrides` so Talk `voiceId`, `modelId`, and `speed/rateWpm` map predictably to SBV2 `speakerName/speakerId`, `modelName/modelId`, and `length`.
   - Current `talk` config only has `interruptOnSpeech`; there is no active Talk provider config for SBV2.
3. Add per-request directive support.
   - Implement `parseDirectiveToken` for safe keys such as `voice`, `speaker`, `model`, `style`, `style_weight`, `speed/length`, and maybe `assist_text`.
   - Respect OpenClaw override policy flags instead of accepting arbitrary query knobs.
4. Add voice/model discovery.
   - Implement `listVoices()` using SBV2 `GET /models/info`.
   - Expose speaker/style/model metadata in a compact way so UI/Talk surfaces can select the real installed voices instead of guessing.
5. Add live smoke coverage.
   - A guarded live test should hit `/status`, `/models/info`, and a short `/voice` call when `SBV2_BASE_URL` is set.
   - It should validate returned `audio/wav`, RIFF header, and useful error messages when model/speaker/style are invalid.

### Secondary gaps
- Add response/content validation: verify non-empty WAV output instead of blindly returning any successful body.
- Improve error handling for timeout, connection refusal, and SBV2 validation errors; current messages are developer-readable but not operator-friendly.
- Decide voice-note compatibility. The provider always returns WAV with `voiceCompatible: false`, so Discord delivery may work after channel conversion, but mobile/voice-note surfaces likely need Opus/OGG conversion or a documented non-goal.
- Add `defaultTimeoutMs`, `models`, and maybe `voices` metadata when static values are known.
- Document the exact runtime verification commands, especially `openclaw plugins inspect ... --runtime --json`.
- Decide distribution strategy: local linked plugin is fine, but published package/import behavior should be tested through `openclaw plugins install`, not direct Node import.

### Suggested next implementation order
1. Fix config-name mismatch and add provider-level unit tests.
2. Add `/models/info` client + `listVoices()`.
3. Add Talk config/override mapping.
4. Add directive parsing.
5. Add live smoke tests and README runbook.

## 2026-04-05 - TTS provider works; surface behavior differs by channel

### Summary
The Style-Bert-VITS2 bridge appears to work as a `messages.tts` provider. Audio generation succeeds, and Discord receives/playbacks the generated audio correctly. The remaining confusion is primarily surface-specific UX/attachment visibility, not core provider synthesis.

### Confirmed observations
- `messages.tts` can select `style-bert-vits2`
- `/tts audio` triggers successful SBV2 generation
- SBV2 server logs show successful audio generation and response delivery
- Discord receives the audio correctly
- Control UI / webchat does not clearly expose where the generated audio went
- Switching to OpenAI shows the same visibility problem in control UI, which suggests a surface/output-path issue rather than a SBV2-specific provider failure

### Implications
- Core bridge/provider path is viable
- SBV2 is not the current bottleneck for `/tts audio`
- Control UI / webchat audio visibility should be treated as a separate OpenClaw surface issue

### Bridge-side follow-up
- Keep hardening `Sbv2Client`
- Confirm final request shape against SBV2 `/docs`
- Stabilize provider metadata (output format, file extension, voice compatibility)
- Continue with bridge tools and bundled skill work

## 2026-04-05 - OpenClaw control UI / webchat does not clearly surface `/tts audio` output

### Summary
`/tts audio` appears to generate audio successfully for multiple providers, but control UI / webchat does not make the resulting audio artifact visible or obvious to the user. Discord does deliver the audio correctly, so this looks like a surface-specific output/rendering issue rather than a provider problem.

### Evidence
- Style-Bert-VITS2 provider: generated audio successfully
- OpenAI provider: same control UI invisibility behavior
- Discord: generated audio is delivered correctly
- Therefore the issue is likely in control UI / webchat media exposure or playback handling

### Impact
- Makes TTS debugging in control UI confusing
- Hides successful generation behind unclear UX
- Can mislead provider/plugin development by making working providers look broken

### Suggested investigation
- Trace where `/tts audio` writes or stores `audioPath`
- Confirm how webchat/control UI handles audio attachments/tool media
- Check whether audio-only tool results are intentionally hidden on this surface
- Decide whether control UI should show an attachment, a player, or an explicit download link

## 2026-04-05 - MVP scope and architecture for Style-Bert-VITS2 Bridge

### Summary
Need a minimal plugin that lets OpenClaw speak through the existing Style-Bert-VITS2 API, plus a thin operator-facing guidance skill for voice/style selection.

### Agreed direction
- Create a new standalone repo: `style-bert-vits2-bridge`
- Treat the plugin as the primary deliverable
- Treat the skill as a supplemental usage/selection guide
- Start with TTS/Talk-style one-shot speech generation, not realtime voice

### MVP
1. Minimal SBV2 client against the existing `/voice` API
2. OpenClaw Talk provider that sends text to SBV2 and returns audio
3. Optional minimal test tool for direct speech preview
4. Thin skill for model/style/speaker selection guidance

### Manifest notes
- Manifest should contain plugin identity and durable config only
- Do not place per-request inference payload fields like `text`, `speaker_id`, or `style` in plugin config
- Durable config candidates:
  - `baseUrl`
  - `timeoutMs`
  - `defaultModelName`
  - `defaultSpeakerId` / `defaultSpeakerName`
  - `defaultStyle`
- `skills` may still be valid depending on current SDK/manifest expectations and should be rechecked against migration docs before finalizing manifest shape

### Initial directory shape
- `openclaw.plugin.json`
- `package.json`
- `src/index.ts`
- `src/sbv2-client.ts`
- `src/sbv2-talk-provider.ts`
- `skills/voice/SKILL.md`
- later: list/test/train tools

### Open questions
- Exact current manifest shape after SDK migration
- Whether `skills` belongs in the plugin manifest for bundled skill discovery
- Whether MVP should implement Talk provider only, or Talk + TTS provider together
- Preferred audio output format from SBV2 for OpenClaw compatibility

### Next steps
- Reconcile manifest against current OpenClaw plugin docs
- Implement minimal plugin entrypoint and SBV2 client
- Implement minimal Talk provider
- Add bundled guidance skill if manifest still supports/needs it
