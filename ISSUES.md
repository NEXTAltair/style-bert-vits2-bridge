# Issues

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
