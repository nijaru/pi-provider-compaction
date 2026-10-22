# pi-provider-compaction

Experimental cached and provider-native compaction; the minimum runtime remains Pi 0.87.0. Keep global activation and publishing separate from development validation.

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

- Pi provider registration is replacement, not middleware. Decorate registered native **bases**, never effective composed providers; the latter loses legacy model headers and embeds stale configuration.
- Share each native, legacy or effective observer dispatcher across runtime sessions and separately loaded extension copies. Releasing a session removes only its listener; the final lease restores still-owned registration/method descriptors, including detached effective objects. `/fast` may release all leases over its legacy delegate.
- Preserve callback receivers and full/simple semantics. Lease effective objects in place; never re-register them. Released callbacks stay inert.
- Restore registration only while still owning the slot. Preserve intervening unrelated configuration changes. Never change full-stream semantics just to obtain a capture hook. A post-hook logical payload is not necessarily the final wire body (Codex cached WebSocket deltas).
- Cached summaries validate the captured prefix and current projected coverage; opaque native substitutions cannot establish readable cache eligibility. Keep unknown lifetimes unknown and apply retention per request. Pre-expiry transactions are cached-only and must cancel rather than enter ordinary fallback. Recheck the companion's live ownership/input guard before paid stages and native transport dispatch, regardless of hook order; `isIdle()` is admission-only because compaction itself makes it false.

## Development

Use Bun/TypeScript. Development dependencies pin the tested Pi host, not the minimum runtime floor. `index.ts` owns lifecycle and compaction; `provider.ts` owns capture-hook installation; `replay.ts` owns exact mapping and substitution; `protocol.ts` owns transport/validation; `policy.ts` mirrors generic-model precedence; `cached-summary.ts` owns cache evidence, summary validation and visible file-history carry-forward.

Run `bun run check`, `bun run build`, and `git diff --check`. `check` rebuilds ignored `dist/index.js` before testing the artifact against the host serializer. The manifest loads that artifact, so rebuild after source or dependency changes before local Pi testing. Exercise real Pi runner/adapters with fake transports. Report authenticated backend tests separately; fixtures alone do not establish production readiness.
