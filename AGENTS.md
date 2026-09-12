# pi-provider-compaction

Provider-native compaction adapters for Pi.

## Product boundaries

- Native protocol selection is automatic from the active Pi API adapter. Do not require a user-facing provider-compaction mode selector.
- `pi-compactor` owns when to compact and continuation. A deliberately configured generic compaction model may override native compaction; otherwise supported native routes are automatic.
- Persist a meaningful portable Pi summary and validated native state at the same committed boundary. Never replace the portable summary with an opaque placeholder in new sessions.
- Keep provider/API/model plus stable endpoint/account/deployment identity with native state. Never persist raw API keys, OAuth access tokens, management credentials, or complete auth headers.
- `pi-fast-mode` owns `/fast`; `pi-usage` owns read-only account reporting. Do not merge those responsibilities here.
- Unsupported or failed native routes fall back to Pi. Do not probe paid protocols in sequence or silently change providers.

## Protocol rules

- Use Pi's active provider transport to obtain the real request URL, authentication, deployment/version semantics, and provider request shape.
- Standalone Responses compaction preserves the full canonical returned output window. Validate size and checkpoint structure; do not prune it.
- Codex Remote V2 appends `compaction_trigger` through the provider payload hook and inspects the actual SSE response while letting Pi's provider consume the same response.
- In-stream `context_management` is unsupported until Pi exposes enough response/checkpoint state to validate and persist emitted compaction items. Setting the request field alone is not support.
- Keep legacy v1 checkpoints readable without bulk-rewriting session history.

## Development

Use Bun/TypeScript and Pi 0.85.1-compatible public APIs. `index.ts` owns session integration/replay, `protocol.ts` owns provider transport and validation, and `policy.ts` mirrors `pi-compactor`'s optional generic-model precedence. Run `bun run check` and `git diff --check`; authenticated endpoint checks must be reported separately from fixture coverage.
