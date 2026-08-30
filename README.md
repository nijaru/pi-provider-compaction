# pi-provider-compaction

Provider-native context compaction for [Pi](https://github.com/earendil-works/pi).

This is a companion to [pi-compactor](https://github.com/nijaru/pi-compactor):

- **pi-compactor** owns when compaction should happen and how the agent resumes.
- **pi-provider-compaction** owns how a provider's native compaction protocol works.

Provider-native compaction is not just a cheaper summary-model call. It may require
provider-specific request formats, opaque compaction state, session persistence, and
replaying that state on later requests. Keeping those concerns here prevents them from
becoming policy and lifecycle logic in `pi-compactor`.

## Scope

The package will provide provider-specific adapters that:

- participate in Pi's compaction hooks without replacing Pi's scheduling policy;
- call a provider's native compaction mechanism when the active API supports one;
- persist and restore provider-specific compaction details safely; and
- leave unsupported providers on Pi's normal compaction path.

The initial implementation is not included yet.

## Related extensions

This remains separate from:

- [`pi-compactor`](https://github.com/nijaru/pi-compactor), for model-driven compaction policy;
- [`pi-fast-mode`](https://github.com/nijaru/pi-fast-mode), for provider request service tiers; and
- [`pi-usage`](https://github.com/nijaru/pi-usage), for provider quota display.

Those extensions have useful provider-independent responsibilities and should remain
independently installable.

## License

MIT
