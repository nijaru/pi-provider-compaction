# pi-provider-compaction

Experimental provider-native compaction for Pi 0.87.0. Keep global activation and publishing separate from development validation.

## Product boundaries

- Select native protocols from the active API; do not add a provider mode selector or probe paid alternatives.
- `pi-compactor` owns timing and continuation. Its explicit generic-model selection takes precedence.
- Commit a meaningful portable summary and validated native state together. If native acquisition fails after portable generation, return that portable result without another summary request.
- `pi-fast-mode` owns `/fast`; `pi-usage` owns account reporting.

## Safety contracts

- Native coverage ends **before `firstKeptEntryId`**, not at the compaction entry ID. Replay replaces only the portable-summary contribution and preserves the actual request's suffix and other fields.
- Capture after the entire incoming `onPayload` callback. Persisted projection and serializer output are validators/provenance only, never sources for native request content or a reconstructed live suffix.
- Use `buildSessionProjection()` for context-edit-aware provenance. Reject stale, incomplete or ambiguous mappings and open tool exchanges. Never recover redacted text from raw entries.
- V3 is prefix-aligned; v1/v2 are not. Legacy v1 lacks meaningful portable fallback. Do not silently replay or reinterpret legacy state.
- Native eligibility is runtime-local. Invalidate on lifecycle, history, policy and route changes; hidden state cannot be certified by matching visible summary text. See README for the dynamic-privacy exclusion.
- Persist no raw keys, tokens, complete headers or request snapshots. Pass resolved headers, including `null` deletions, unchanged to provider transports.
- Codex uses top-level `instructions`; direct OpenAI/Azure serialize the prompt into `input`. The validator must mirror grammar-tool properties and API-specific strict defaults, and reject drift.
- Preserve complete validated native output windows. Bound both transport output and persisted-state parsing. Do not enable in-stream `context_management` without checkpoint capture.

## Provider ownership

- Pi 0.87.0 registration is replacement, not middleware. Decorate registered native **bases**, never effective composed providers; the latter loses legacy model headers and embeds stale configuration.
- Only decorate existing static legacy `streamSimple` owners. Preserve their callback receiver and all configuration. Exclude dynamic legacy catalogs/OAuth model projections and unregistered builtin overlays.
- Restore registration only while still owning the slot. Preserve intervening unrelated configuration changes. Never change full-stream semantics just to obtain a capture hook.

## Development

Use Bun/TypeScript. Dependencies pin the verified Pi 0.87.0 floor. `index.ts` owns lifecycle and compaction; `provider.ts` owns capture-hook installation; `replay.ts` owns exact mapping and substitution; `protocol.ts` owns transport/validation; `policy.ts` mirrors generic-model precedence.

Run `bun run check`, `bun run build`, and `git diff --check`. The manifest loads ignored `dist/index.js`, so rebuild before local Pi testing. Exercise real Pi runner/adapters with fake transports. Report authenticated backend tests separately; fixtures alone do not establish production readiness.
