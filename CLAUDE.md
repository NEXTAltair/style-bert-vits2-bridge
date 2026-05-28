# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An OpenClaw plugin that bridges to a running Style-Bert-VITS2 API server for speech generation. It registers a speech provider via `api.registerSpeechProvider()` that calls SBV2's `POST /voice` endpoint and returns WAV audio. A bundled `skills/voice` skill guides the agent on model/style/speaker selection.

## Commands

```bash
pnpm install          # install dependencies
pnpm test             # run tests (vitest)
pnpm run check        # type-check (tsc --noEmit)
```

## Runtime gotchas

- **Packaged entry point is `dist/index.js`** — build with `pnpm run build` before link/install verification. Do not point `package.json#openclaw.extensions` at `src/index.ts`.
- **Root `index.ts` is only a source-checkout shim** — it re-exports from `./src/index` for loaders that inspect the checkout directly.
- **Runtime import paths use `.js` extensions** — packaged runtime loads `dist/index.js` as Node ESM, so relative imports in source must compile to `.js` specifiers such as `"./sbv2-client.js"`.
- **Silent failures** — the gateway swallows plugin load/register errors with no log output. Always add `api?.logger?.info?.(...)` in `register()` to confirm it runs.
- **SBV2 requires `encoding=utf-8`** query param for non-ASCII text in URL.

## Architecture

```
index.ts                  # Source-checkout re-export shim
openclaw.plugin.json      # Plugin manifest: id, configSchema, uiHints, skills
package.json              # openclaw metadata block points to dist/index.js
src/index.ts              # definePluginEntry → registerSpeechProvider
src/sbv2-client.ts        # Pure HTTP client for SBV2 /voice (no SDK deps)
src/sbv2-client.test.ts   # Unit tests (vitest, fetch mocked)
src/openclaw-types.d.ts   # SDK type stubs (replaced by real SDK at runtime)
skills/voice/SKILL.md     # Agent guidance skill (frontmatter: name, description)
```

- `sbv2-client.ts` is intentionally SDK-independent — pure `fetch` + `URL` only
- `src/index.ts` bridges the client to OpenClaw's `registerSpeechProvider` interface
- Speech provider config comes from `messages.tts.providers.style-bert-vits2` in `openclaw.json`

## SBV2 API

One-shot TTS via `POST /voice` with query params. Returns `audio/wav` (PCM 16bit mono 44100Hz). Key params:
- Required: `text` (1-100 chars, but `auto_split=true` handles longer text)
- Required for non-ASCII: `encoding=utf-8` (auto-added by client)
- Optional: `model_name`, `speaker_id`/`speaker_name`, `style`, `style_weight`, `language` (JP/EN/ZH), `length` (speed)
- Also: `GET /models/info` for loaded models, `GET /status` for health

## Skill format

`skills/voice/SKILL.md` requires YAML frontmatter with `name` and `description`. The `skills` array in `openclaw.plugin.json` points to skill directories relative to plugin root.

## Manifest rules

Per-request inference fields (`text`, `speaker_id`, `style`) must **not** appear in `configSchema`. Only durable operator config belongs there: `baseUrl`, `timeoutMs`, `defaultModelName`, `defaultSpeakerId`, `defaultSpeakerName`, `defaultStyle`.
