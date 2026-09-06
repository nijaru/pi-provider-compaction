# pi-provider-compaction

Provider-native context compaction for [Pi](https://github.com/earendil-works/pi).

This is a companion to [pi-compactor](https://github.com/nijaru/pi-compactor):

- **pi-compactor** owns when compaction should happen and how the agent resumes.
- **pi-provider-compaction** owns how a provider's native compaction protocol works.

Provider-native compaction is not just a cheaper summary-model call. It may require
provider-specific request formats, opaque compaction state, session persistence, and
replaying that state on later requests. Keeping those concerns here prevents them
from becoming policy and lifecycle logic in `pi-compactor`.

## Installation

```bash
pi install git:github.com/nijaru/pi-provider-compaction
```

Install [`pi-compactor`](https://github.com/nijaru/pi-compactor) separately if you
also want its model-driven `compact` tool and context-usage hints.

## OpenAI Responses

The initial adapter supports the official OpenAI provider's `openai-responses`
API. During Pi compaction it calls the provider's stateless `/responses/compact`
endpoint, persists the returned opaque compaction item in the session, and
replays the canonical compacted window on later requests.

The adapter leaves unsupported APIs on Pi's normal compaction path.

### Generic compaction-model precedence

[pi-compactor](https://github.com/nijaru/pi-compactor) can run a generic model of
your choice for compaction summaries. When one is configured, it takes
precedence over provider-native compaction — this extension makes no native
compaction request and replays no previously persisted native window. The same
resolution order as pi-compactor applies:

1. the `--compaction-model` flag (registered by both extensions so the shared
   value stays visible),
2. a trusted project's `.pi/compaction-policy.json` (`models` list), then
3. the agent directory's `compaction-policy.json`.

A policy file with an empty `models` list is an explicit choice to use no generic
model, so native compaction runs. Leave the flag unset and no policy file present
to use native compaction.

### Session and cost behavior

The provider's compacted output is opaque and is not shown as a human-readable
summary. Pi's normal session entries remain available for transcript navigation;
the native window is used only for subsequent provider requests.

The compaction pass's token usage and cost are recorded on the compaction entry
like any other compaction, so quota and cost extensions see them.

Pi estimates post-compaction context size from the kept session entries. A native
window is usually smaller than that estimate, so Pi's threshold may trigger the
next compaction slightly earlier than strictly necessary.

## Related extensions

This remains separate from:

- [`pi-compactor`](https://github.com/nijaru/pi-compactor), for model-driven compaction policy;
- [`pi-fast-mode`](https://github.com/nijaru/pi-fast-mode), for provider request service tiers; and
- [`pi-usage`](https://github.com/nijaru/pi-usage), for provider quota display.

Those extensions have useful independent responsibilities and remain
independently installable.

## License

MIT
