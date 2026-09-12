# pi-provider-compaction

Provider-native context compaction for [Pi](https://github.com/earendil-works/pi).

[pi-compactor](https://github.com/nijaru/pi-compactor) owns when to compact and
how the agent resumes. This extension owns provider protocols, persisted native
state, and replay. It does not own Fast mode or quota display.

## Installation

```bash
pi install git:github.com/nijaru/pi-provider-compaction
```

Install `pi-compactor` separately for its model-directed `compact` tool and
context-usage hints.

## Current route support

Selection uses the Pi provider ID and API adapter, not the model's display name
or whether Pi is running in a terminal or an editor.

| Pi provider | Model API | This extension's behavior |
| --- | --- | --- |
| `openai` | `openai-responses` | Attempts standalone `/responses/compact`; failures leave compaction to Pi. |
| `openai-codex` | `openai-codex-responses` | No native adapter here; leaves compaction to Pi or another explicitly configured handler. |
| DeepSeek, OpenRouter, Azure, or another provider | Any | No native adapter here. |

The current eligibility check is exactly
`model.provider === "openai" && model.api === "openai-responses"`.
A GPT model accessed through `openai-codex` is therefore different from the
same model accessed through direct `openai`. Pi can run either route; using Pi
does not select one automatically. Backend support and valid authentication
are still required for an eligible request to succeed.

For direct OpenAI, the extension sends a compact request using the registry's
resolved credentials and base URL, persists the complete returned window, and
replays it on later compatible requests. OpenAI documents that the returned
window is canonical and must not be pruned; it can contain retained items as
well as the opaque compaction item. See the
[compaction guide](https://developers.openai.com/api/docs/guides/compaction).

## Generic compaction-model precedence

A generic summary model configured for `pi-compactor` takes precedence. This
extension makes no native request and replays no saved native window while
that policy is selected. Resolution order:

1. `--compaction-model`, registered by `pi-compactor`;
2. a trusted project's `.pi/compaction-policy.json` `models` list;
3. the agent directory's `compaction-policy.json` `models` list.

An empty `models` list explicitly selects no generic model. Leave the flag
unset and no policy file present to use native compaction on an eligible route.

## Session portability limitation

**Successful native compaction currently saves a placeholder as Pi's visible
summary, not a portable text summary.** The useful compacted state lives in
extension-owned details. Replay requires the same provider, API, and model ID.

Switching to DeepSeek, Codex, another model, disabling this extension, or
selecting a generic compaction policy can therefore leave only that placeholder
and Pi's retained recent messages in the active context. The original session
history remains on disk; it is not automatically restored or summarized for the
new route. A fallback after a failed compact request does not solve portability
after a successful native compact.

Before switching an important native-compacted session, preserve the needed
state while the compatible route is still active, or branch from the original
history before the compaction boundary. Do not assume an export or a model
switch makes the encrypted checkpoint usable by another provider.

Portable continuation and a separate Codex adapter are the next integration
priorities. They require runtime and authenticated-provider tests; this support
table does not claim they are implemented.

## Cost and lifecycle

Compaction usage and cost are recorded on the compaction entry when returned by
the provider. Pi's context estimate can differ from the actual replayed window;
validate thresholds against the installed runtime rather than assuming that a
native checkpoint is always smaller or higher quality.

This implementation uses the standalone compact endpoint. OpenAI also offers
in-stream compaction, including stateless operation. Adopting it requires Pi to
capture, persist, and replay the returned items through its session lifecycle;
adding a request field alone is insufficient. Do not change `store` behavior or
replace the provider transport merely to add compaction support.

## Development

```bash
bun install
bun run check
```

Offline tests are not evidence of live endpoint compatibility. Test compaction,
resume, model switching, and coexistence with `pi-compactor` on the installed Pi
runtime before changing a working session.

## Related extensions

Keep these responsibilities independently installable:

- [pi-compactor](https://github.com/nijaru/pi-compactor): timing and resumption.
- [pi-fast-mode](https://github.com/nijaru/pi-fast-mode): request service tiers.
- [pi-usage](https://github.com/nijaru/pi-usage): quota display, not request policy.

## License

MIT
