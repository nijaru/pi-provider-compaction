# pi-provider-compaction

Provider-native compaction adapters for Pi.

## Boundaries

- Keep provider protocol details here; do not move compaction policy or agent-resume lifecycle from `pi-compactor` into this repository.
- Keep provider adapters isolated from one another. An unsupported provider must continue through Pi's normal compaction path.
- Persist only provider state that Pi can safely serialize and restore. Treat opaque provider details as provider-owned data.
- Do not combine this repository with `pi-fast-mode` or `pi-usage`; those extensions have independent responsibilities.
- Verify provider behavior against the live Pi extension and provider APIs before claiming compatibility.

## Development

- Use Bun and TypeScript, matching the sibling Pi extension repositories.
- Keep the public package small and provider-specific behavior explicit.
- Add tests for request shaping, state persistence, unsupported-provider fallback, and compaction-hook ordering as adapters are implemented.
