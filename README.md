# pi-provider-compaction

Experimental provider-native compaction for [Pi](https://github.com/earendil-works/pi), with a meaningful portable summary saved alongside each native checkpoint. Requires Pi 0.87.0.

**The unpublished redesign is not production-validated. Do not enable it globally yet.** Real runner/adapter fixtures and a Codex live smoke test pass; broader backend and deployment validation remains incomplete.

[pi-compactor](https://github.com/nijaru/pi-compactor) owns compaction timing and continuation. This extension owns native request capture, prefix coverage, persistence and replay. It does not change `/fast` or account reporting.

## Supported integration

Pi 0.87.0 has replacement provider registration, not composable middleware. This extension only installs request observation where it can preserve the existing provider contract:

- **Registered native base providers:** both streaming methods are decorated; authentication, catalogs, filtering, refresh and deferred methods stay with the original provider. `models.json` remains above that base.
- **Existing static legacy `streamSimple` registrations:** the original callback and configuration are retained. This includes `pi-fast-mode`'s Codex registration. Legacy dynamic catalogs and OAuth model-projection callbacks are excluded.
- **Plain built-in providers and other unsupported registrations:** portable Pi compaction only. Injecting a legacy wrapper here would silently change full-stream calls into simple-stream calls.

For an eligible request, protocol selection is automatic:

| Pi API | Native protocol |
| --- | --- |
| `openai-responses` | `POST .../responses/compact` |
| `azure-openai-responses` | The same endpoint, preserving Pi's Azure URL/query/auth |
| `openai-codex-responses` | Codex Remote V2 using `compaction_trigger` |

An API name does not prove its backend supports that protocol. Failed attempts return the already-produced portable summary; no other provider or protocol is probed. In-stream `context_management` remains unsupported.

## Coverage and replay

Native state covers **only the prefix summarized by Pi**, ending before `firstKeptEntryId`. It does not cover retained recent messages.

The extension captures a bounded, fully prepared request after Pi's payload hooks finish. An exact serializer validator proves the covered prefix and a closed tool-exchange boundary. Native input comes from that captured request—not reconstructed persisted history. A recent capture may omit the latest assistant response if that response is retained rather than summarized. Captures expire after five minutes and are limited to 8 MiB of context plus payload.

Replay replaces exactly one validated portable-summary contribution with the native output window. Retained and new messages, instructions, tools and other request fields remain from the actual request. No live suffix is rebuilt.

Request-only suffix additions, deletions, redactions and reordering can survive replay. Authentication must match the actual request; unmatched header/environment transformations disable native eligibility. Unmapped changes to the covered prefix or summary, payload-input rewrites, ambiguous summary matches, serializer drift and unsafe tool boundaries instead leave the portable request untouched. Codex top-level `instructions` and OpenAI/Azure input prompt items are handled separately.

## Safety and persistence

Version 3 stores the portable summary, native output, usage, route identity and validated prefix metadata in one compaction entry. Both generation requests contribute to usage accounting. Raw credentials, complete auth headers and request snapshots are never persisted.

Native eligibility is deliberately **session-local and short-lived**. Restart, reload, resume, fork, tree navigation, model changes, covered-history edits, and relevant prompt/tool/route changes revoke it. A credential refresh may conservatively revoke it too. Persisted native metadata alone is not authority to replay hidden content under a new runtime's privacy policy.

Dynamic privacy policies that can change what previously covered history is allowed to reveal are **not transparently supported**. A cooperating policy owner must emit `pi-provider-compaction:invalidate` before such a change; otherwise keep this extension disabled. Matching visible summary text cannot establish that hidden native state obeys a new policy.

Portable fallback means Pi's ordinary behavior, **not universal redaction protection**: Pi's built-in summarizer does not inherit request-time context/payload hooks.

Legacy v1/v2 whole-history checkpoints remain inspectable but are never reinterpreted as prefix-only state. Version 2 has a portable summary. Version 1's opaque placeholder does not; the extension warns rather than pretending that missing history is recoverable from the placeholder. Recover from earlier session history or begin a new session.

## Diagnose portable fallback

Run `/provider-compaction-status` to see whether the observer is installed, the latest capture status, and the last compaction attempt in this runtime. Portable fallback also appends a `pi-provider-compaction:diagnostic` session entry containing only a fixed reason string. It is not included in model context. Diagnostics never include request content, credentials, or backend error text.

These diagnostics require the extension to be loaded when the attempt happens; they cannot explain earlier compactions retroactively. A committed native checkpoint does not by itself prove that a later request replayed it.

## Generic compaction-model override

An explicit generic model takes precedence, matching `pi-compactor`:

1. `--compaction-model ...`;
2. trusted `.pi/compaction-policy.json`;
3. agent `compaction-policy.json`.

An empty `models` list is not an override.

## Local development

```bash
bun install
bun run check
bun run build
pi --extension ./dist/index.js
```

The manifest loads the built `dist/index.js`; source edits alone do not update it. Keep global installation disabled while testing. Publishing and global activation are separate approval steps.

Tests include real Pi 0.87.0 runner/adapter fixtures for all three protocols, repeated prefix compaction, transformed suffix preservation, unchanged fallback, grammar tools, strict defaults, tool IDs, images and prompt updates. The optional installed-fast-mode fixture (`PI_FAST_MODE_FIXTURE_PATH`) also checks actual `pi-fast-mode` composition across `/reload`; run it with an isolated `PI_CODING_AGENT_DIR` containing an active, persistent fast-mode configuration.

Authenticated protocol smoke tests are separate and send three small requests:

```bash
bun run tests/live-smoke.ts openai-codex gpt-5.5
```

Validation on 2026-09-22:

- **Codex `gpt-5.5`:** prefix-only Remote V2 compaction and continuation accepted; an exact code held only in the summarized assistant message was recalled.
- **Direct OpenAI `gpt-5.5`:** initial request failed; compact/continuation remain unverified.
- **Azure:** no configured credentials; fixtures only.

The installed `pi-fast-mode` 0.0.2 composition/reload fixture passed separately. These checks do not establish transparent arbitrary-hook support or production readiness.

## Related extensions

- [pi-compactor](https://github.com/nijaru/pi-compactor): timing and continuation.
- [pi-fast-mode](https://github.com/nijaru/pi-fast-mode): `/fast` and service-tier policy.
- [pi-usage](https://github.com/nijaru/pi-usage): read-only balances and quota reporting.

## License

MIT
