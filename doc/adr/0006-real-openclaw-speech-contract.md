# ADR 0006: Validate the real OpenClaw speech contract

- Status: Accepted
- Date: 2026-10-16

## Context

Version 0.3.0 loaded successfully but compiled against handwritten ambient SDK
types. Those types hid removed speech fields and an incorrect directive result.
Registration, contract checking, and actual host execution are separate checks.

## Decision

- Pin the published OpenClaw SDK as a development dependency and import the
  public speech contract from its typed `plugin-entry` facade. Reject local
  `declare module "openclaw/..."` replacements before TypeScript checking.
- Validate descriptors with `satisfies SpeechProviderPlugin`; let the SDK type
  the registration API and test request contexts.
- Do not advertise unsupported speech capability fields. Preserve SBV2's
  OpenAPI-derived input guard immediately before sending audio requests.
- Supply the current-main asynchronous configuration hook and the synchronous
  hook still required by the published SDK, sharing its actual context type.
- Use top-level `tts.providers` configuration. Keep the compatibility floor a
  practical SDK-change baseline, not a full historical-version matrix.
- Check the release archive in an isolated published host, including actual
  Gateway-to-provider requests against loopback fixtures. Keep production
  configuration, voice selection, and Gateway restarts outside that check.

## Consequences

SDK changes now fail ordinary type checking instead of being hidden by local
interfaces. Development installs are larger; release archives do not contain
the development SDK or private voice assets. Update the SDK pin and this
boundary when its public contract changes.
