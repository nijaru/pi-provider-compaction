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

The initial adapter supports models using Pi's `openai-responses` or
`openai-codex-responses` APIs. During Pi compaction it calls the provider's
stateless `/responses/compact` endpoint, persists the returned opaque compaction
item in the session, and replays the canonical compacted window on later requests.

The adapter leaves unsupported APIs on Pi's normal compaction path. If
`--compaction-model` is set, the explicit generic compaction model takes
precedence. Leave that flag unset to use native compaction.

The provider's compacted output is opaque and is not shown as a human-readable
summary. Pi's normal session entries remain available for transcript navigation;
the native window is used only for subsequent provider requests.

## Related extensions

This remains separate from:

- [`pi-compactor`](https://github.com/nijaru/pi-compactor), for model-driven compaction policy;
- [`pi-fast-mode`](https://github.com/nijaru/pi-fast-mode), for provider request service tiers; and
- [`pi-usage`](https://github.com/nijaru/pi-usage), for provider quota display.

Those extensions have useful independent responsibilities and remain
independently installable.

## License

MIT
