# pi-provider-compaction

Experimental cache-aware compaction for [Pi](https://github.com/earendil-works/pi), with portable summaries and optional provider-native checkpoints. Minimum runtime: Pi 0.87.0. Development checks target Pi 1.4.0.

**This experimental design is not production-validated. Do not enable it globally yet.** Real runner/adapter fixtures and a Codex live smoke test pass; broader backend and deployment validation remains incomplete.

[pi-compactor](https://github.com/nijaru/pi-compactor) owns compaction timing and continuation. This extension owns cached summary generation, native request capture, prefix coverage, persistence and replay. It does not change `/fast` or account reporting.

## Supported integration

Pi has replacement provider registration, not composable middleware. This extension only installs request observation where it can preserve the existing provider contract:

- **Registered native base providers:** both streaming methods are decorated; authentication, catalogs, filtering, refresh and deferred methods stay with the original provider. `models.json` remains above that base.
- **Existing static legacy `streamSimple` registrations:** the original callback and configuration are retained. This includes `pi-fast-mode`'s Codex registration.
- **Built-in and composed providers:** the existing provider object's full and simple streaming methods are leased separately, without re-registering the provider or rebuilding auth/catalog configuration. Each original method retains its receiver. Cleanup restores only still-owned methods; replacing the provider revokes observation until it is reacquired.

Sessions sharing a model runtime share observation dispatchers, not their captured histories. Releasing one session's lease leaves the others active; the final lease restores the original provider.

For an eligible request, protocol selection is automatic:

| Pi API | Native protocol |
| --- | --- |
| `openai-responses` | `POST .../responses/compact` |
| `azure-openai-responses` | The same endpoint, preserving Pi's Azure URL/query/auth |
| `openai-codex-responses` | Codex Remote V2 using `compaction_trigger` |

An API name does not prove its backend supports that protocol. Failed attempts return the already-produced portable summary; no other provider or protocol is probed. In-stream `context_management` remains unsupported.

## Cached portable summaries

On a successful request with reported cache reads or writes, the extension can reuse the same model, prompt, tools, reasoning settings and cache routing for a summary. This works independently of native checkpoints, including DeepSeek and Xiaomi's OpenAI-compatible APIs and Anthropic Messages.

The summary request extends the captured logical prompt, rather than serializing tool results into Pi's 2,000-character excerpts. A final payload check preserves the existing prefix and request policy. The instruction quotes the retained boundary, separates verified progress from plans, and asks for user constraints in their original wording. The latest assistant response can remain outside the request when it is in the retained suffix. Coverage that cannot be mapped safely uses ordinary Pi compaction. Summary output uses the adapter's model limit and context clamp; `compaction.reserveTokens` controls when compaction starts, not how long its summary may be.

`settings.json` preferences:

```json
{
  "providerCompaction": {
    "cachedSummaries": true,
    "outcomeNotifications": false
  }
}
```

These are the defaults on hosts exposing Pi's `getSettings` API; older hosts retain native compaction with cached summaries disabled. Optional `cacheRetention` accepts `"short"`, `"long"`, or `"none"`; omission inherits Pi/provider behavior. Retention is applied per request, not through process-wide environment changes. A longer tier can increase cache-write charges and only works where the adapter/backend supports it.

A cache hit is best effort, not a promised saving. Countdown estimates use the model's declared `promptCache` lifetime for the active tier, measured conservatively from request dispatch. Missing lifetimes remain unknown: DeepSeek, for example, [documents best-effort eviction over hours to days](https://api-docs.deepseek.com/guides/kv_cache/), not a predictable expiry. Pi's successful warmer requests refresh the observed cycle and countdown.

With [pi-compactor's opt-in idle expiry policy](https://github.com/nijaru/pi-compactor#cache-aware-idle-compaction), compaction can run before an estimated expiry. Both extensions share a live ownership/input guard, checked before paid summary and native-checkpoint stages regardless of extension order. A failed or revoked cached-only attempt cancels instead of starting an ordinary summary. It does not start a continuation.

Cached generation and native acquisition share one portable result. If cached output is empty, truncated or requests tools, ordinary/manual compaction can use one standard fallback; any reported failed-attempt usage is included in the resulting checkpoint. Tools requested by a summarizer are never executed. Native replay requests contain opaque state, so their readable transcript alone does not qualify as a cached portable-summary snapshot.

## Coverage and replay

Native state covers **only the prefix summarized by Pi**, ending before `firstKeptEntryId`. It does not cover retained recent messages.

The extension captures a bounded logical request after Pi's payload hooks finish. Adapters can still optimize transport afterward—for example, Codex cached WebSockets can send a server-state delta—so this is not a claim of final HTTP/WebSocket byte identity. An exact serializer validator proves the covered prefix and a closed tool-exchange boundary. Native input comes from that captured request—not reconstructed persisted history. A recent capture may omit the latest assistant response if that response is retained rather than summarized. Native coverage snapshots expire after five minutes. Both snapshot types are limited to 8 MiB of context plus payload; cached-summary eligibility follows the observed cache lifetime when one is declared.

Replay replaces exactly one validated portable-summary contribution with the native output window. Retained and new messages, instructions, tools and other request fields remain from the actual request. No live suffix is rebuilt.

Request-only suffix additions, deletions, redactions and reordering can survive replay. Authentication must match the actual request; unmatched header/environment transformations disable native eligibility. Unmapped changes to the covered prefix or summary, payload-input rewrites, ambiguous summary matches, serializer drift and unsafe tool boundaries instead leave the portable request untouched. Codex top-level `instructions` and OpenAI/Azure input prompt items are handled separately.

## Safety and persistence

Version 3 stores the portable summary, native output, usage, route identity and validated prefix metadata in one compaction entry. Both generation requests contribute to usage accounting. Raw credentials, complete auth headers and request snapshots are never persisted.

Native eligibility is deliberately **session-local and short-lived**. Restart, reload, SDK disposal, resume, fork, tree navigation, model changes, covered-history edits, and relevant prompt/tool/route changes revoke it. A credential refresh may conservatively revoke it too. Persisted native metadata alone is not authority to replay hidden content under a new runtime's privacy policy.

Dynamic privacy policies that can change what previously covered history is allowed to reveal are **not transparently supported**. A cooperating policy owner must emit `pi-provider-compaction:invalidate` before such a change; otherwise keep this extension disabled. Matching visible summary text cannot establish that hidden native state obeys a new policy.

Portable fallback means Pi's ordinary behavior, **not universal redaction protection**: Pi's built-in summarizer does not inherit request-time context/payload hooks.

Legacy v1/v2 whole-history checkpoints remain inspectable but are never reinterpreted as prefix-only state. Version 2 has a portable summary. Version 1's opaque placeholder does not; the extension warns rather than pretending that missing history is recoverable from the placeholder. Recover from earlier session history or begin a new session.

## Diagnose portable fallback

Run `/provider-compaction-status` to see observer/capture eligibility, estimated cache lifetime, the last selected path, elapsed time, reported input/cache/output tokens, and catalog-priced cost. Optional outcome notifications show measured usage after a committed compaction; hypothetical savings are not presented as measured. Failed/cancelled expiry attempts remain visible in runtime status; if no checkpoint is saved, their usage cannot be attached to compaction totals through Pi's extension API. Portable fallback also appends a `pi-provider-compaction:diagnostic` session entry containing only a fixed reason string. It is not included in model context. Diagnostics never include request content, credentials, or backend error text.

These diagnostics require the extension to be loaded when the attempt happens; they cannot explain earlier compactions retroactively. A committed native checkpoint does not by itself prove that a later request replayed it.

## Generic compaction-model override

An explicit generic model takes precedence, matching `pi-compactor`:

1. `--compaction-model ...`;
2. trusted `.pi/compaction-policy.json`;
3. agent `compaction-policy.json`.

An empty `models` list is not an override. When `pi-compactor` is loaded, its effective selection takes precedence, including flags injected by an SDK host rather than passed on the command line.

## Local development

```bash
bun install
bun run check
bun run build
pi --extension ./dist/index.js
```

The manifest loads the built `dist/index.js`, including a bundled stateless Responses serializer validator; source or host dependency changes require a rebuild. `bun run check` rebuilds first and tests the artifact against Pi's actual host serializer, including function-call history replayed as grammar tools. Keep global installation disabled while testing. Publishing and global activation are separate approval steps.

Tests include real Pi 1.4.0 runner/adapter fixtures for all three protocols, repeated prefix compaction, transformed suffix preservation, unchanged fallback, grammar tools, strict defaults, tool IDs, images, prompt updates, cross-model thinking and mid-conversation effort changes. Set `PI_COMPACTOR_FIXTURE_PATH` to a `pi-compactor` entrypoint to check SDK flag precedence and real idle-expiry transactions in both extension orders. Cached-summary fixtures also exercise built-in DeepSeek/Xiaomi dispatch, Anthropic Messages, late tool output, truncated-output fallback and measured usage. The optional installed-fast-mode fixture (`PI_FAST_MODE_FIXTURE_PATH`) checks actual `pi-fast-mode` composition across `/reload`; it creates an isolated fast-mode configuration.

Authenticated cached-summary smoke tests use synthetic history, including a value beyond the ordinary tool-result excerpt, and check continuation:

```bash
bun run tests/cached-live-smoke.ts deepseek deepseek-flash
```

They send four requests, plus a native-checkpoint request when eligible, and can incur API charges. A successful smoke is not a summary-quality guarantee.

Authenticated native-protocol smoke tests are separate and send three small requests:

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
