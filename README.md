# pi-provider-compaction

Provider-native context compaction for [Pi](https://github.com/earendil-works/pi), with a portable Pi summary saved alongside the native checkpoint.

[pi-compactor](https://github.com/nijaru/pi-compactor) owns **when** to compact and post-compaction continuation. This extension owns automatic provider protocol selection, native checkpoint persistence, and replay. `pi-fast-mode` and `pi-usage` remain independent.

## Behavior

No native compaction mode normally needs to be selected. The extension resolves it from the active Pi API adapter:

| Pi API | Automatic native path |
| --- | --- |
| `openai-responses` | Standalone Responses `POST .../responses/compact` |
| `azure-openai-responses` | Standalone Responses `POST .../responses/compact`, preserving the Azure request URL/query/auth produced by Pi |
| `openai-codex-responses` | Codex Remote V2 via the normal Codex Responses transport plus `compaction_trigger` |
| other APIs | Not claimed; Pi's normal compaction remains available |

A custom provider using the `openai-responses` API is eligible automatically, but eligibility is not proof that its backend implements `/responses/compact`. A failed native attempt falls back to Pi rather than trying unrelated protocols or providers.

The implementation deliberately uses Pi's active provider transport to construct request URLs, headers, OAuth/account state, deployment names, API versions, tools, and other provider-specific fields. It does not reconstruct Codex or Azure authentication from a provider label.

## Native + portable state

A successful compaction has two representations committed at one boundary:

1. the provider-native opaque/canonical replay window; and
2. the meaningful text summary Pi would normally save.

The native representation is used when the current provider/API/model and route identity still match. If the model/provider changes, the extension is removed, or a later generic compaction supersedes the native checkpoint, Pi still has the text summary and retained recent messages.

Producing both representations costs more than native-only compaction: the native request and the portable summarization request are both accounted in the saved compaction usage. `details.nativeUsage` and `details.portableUsage` keep the two components inspectable.

Version-1 sessions containing the old opaque placeholder remain readable and replayable on their original compatible route. New compactions use version 2 and no longer write that placeholder. Historical v1 state is not rewritten in bulk.

## Optional generic compaction-model override

Native compaction is the default on supported routes. An explicitly configured generic compaction model still takes precedence, matching `pi-compactor`:

1. `--compaction-model ...`;
2. trusted `.pi/compaction-policy.json`; then
3. agent `compaction-policy.json`.

This is an override, not a required mode selector. An empty `models` list means no generic override, so automatic native routing can run.

## Replay identity

Native state is scoped to the producing provider, API, model, endpoint and relevant stable account/deployment metadata. Raw API keys, OAuth access tokens, and headers are never persisted. OAuth refresh for the same Codex account therefore does not invalidate a checkpoint merely because the access token changed.

Azure checkpoints additionally record the effective API version and selected deployment when those values can be resolved from Pi's provider environment.

## In-stream compaction

OpenAI and Azure Responses can emit compaction items during an ordinary request through `context_management`. This extension does **not** enable that path yet.

Pi 0.85.1 exposes a pre-request rewrite hook but no extension hook that receives the provider response body/stream. Adding `context_management` alone would let the server compact without giving the extension a reliable way to validate, persist, and replay the emitted checkpoint. Standalone compaction and Codex Remote V2 are therefore implemented now; in-stream compaction requires a Pi host response/checkpoint hook or equivalent persisted provider metadata.

## Installation

```bash
pi install git:github.com/nijaru/pi-provider-compaction
```

Install [pi-compactor](https://github.com/nijaru/pi-compactor) separately for model-directed timing/context hints.

## Development

```bash
bun install
bun run check
```

Tests cover automatic route selection, standalone request bridging, Azure query preservation, Codex Remote V2 SSE capture, checkpoint validation, legacy parsing, identity-scoped replay, and direct request fixtures. Authenticated smoke tests are still required to claim a particular account/backend as live-verified.

### Protocol references

The transport/validation design was checked against Pi 0.85.1, OpenAI Codex's Remote V2 implementation, and `@narumitw/pi-codex-compact` from `narumiruna/pi-extensions` at tree `1c1ac2c0f371b38957719dc197afb54bc13bda43` (MIT). The owned implementation keeps its own product boundaries and portable-summary contract rather than installing that bundle.

## Related extensions

- [pi-compactor](https://github.com/nijaru/pi-compactor): when to compact and continuation lifecycle.
- [pi-fast-mode](https://github.com/nijaru/pi-fast-mode): `/fast` and request service-tier policy.
- [pi-usage](https://github.com/nijaru/pi-usage): read-only balances and quota reporting.

## License

MIT
