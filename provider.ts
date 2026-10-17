import type { Provider, StreamOptions, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ObserveRequest = (model: Model<any>, context: TranscriptContext, options: StreamOptions) => ((payload: unknown) => unknown | Promise<unknown>) | undefined;

export interface InstalledObserver {
	provider: string;
	isInstalled(): boolean;
	remove(): void;
}

// Explicit cooperation with pi-fast-mode, not permission to replace arbitrary
// streams: this observer delegates unchanged and can release only its own slot.
export const STREAM_OBSERVER = Symbol.for("@nijaru/pi-provider-compaction/stream-observer");

function optionsWithObserver<T extends StreamOptions>(model: Model<any>, context: TranscriptContext, options: T | undefined, observe: ObserveRequest): T | undefined {
	let handler: ReturnType<ObserveRequest>;
	try { handler = observe(model, context, options ?? {}); }
	catch { return options; } // An expired or failing optional observer must not veto dispatch.
	if (!handler) return options;
	return {
		...options,
		onPayload: async (payload: unknown, requestModel: Model<any>) => {
			const replacement = await options?.onPayload?.(payload, requestModel);
			const prepared = replacement === undefined ? payload : replacement;
			// Observation failures must not suppress or alter the portable request.
			try { return await handler(prepared); } catch { return prepared; }
		},
	} as T;
}

/** Preserve method receivers, getters, optional members and dynamic catalogs. */
export function decorateProvider(base: Provider, observe: ObserveRequest): Provider {
	const stream: Provider["stream"] = (model, context, options) => base.stream(model, context, optionsWithObserver(model, context, options, observe));
	const streamSimple: Provider["streamSimple"] = (model, context, options) => base.streamSimple(model, context, optionsWithObserver(model, context, options, observe));
	const bound = new Map<PropertyKey, unknown>();
	return new Proxy(base, {
		get(target, key) {
			if (key === "stream") return stream;
			if (key === "streamSimple") return streamSimple;
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			if (!bound.has(key)) bound.set(key, value.bind(target));
			return bound.get(key);
		},
	});
}

/**
	* Pi 0.87 has replacement registration, not middleware. Native BASE providers can
	* be decorated directly. Legacy stream overlays retain their configuration and
	* delegate their original callback (including /fast). Never register an effective
	* composed provider as a native base: that loses model headers and freezes config.
	*/
export function installObserver(pi: ExtensionAPI, ctx: ExtensionContext, observe: ObserveRequest): InstalledObserver | undefined {
	const model = ctx.model;
	if (!model) return;
	const registry = ctx.modelRegistry;
	const id = model.provider;
	const native = registry.getRegisteredNativeProvider(id);
	if (native) {
		// Pi composes a native base only when its catalog serves the active API.
		// Otherwise the request goes to the global API provider and bypasses this
		// wrapper; claiming an observer there would report native compaction as
		// installed while never capturing anything.
		if (typeof native.getModels !== "function" || !native.getModels().some((entry) => entry.api === model.api)) return;
		const isInstalled = () => registry.getRegisteredNativeProvider(id) === wrapper;
		const guarded: ObserveRequest = (...args) => {
			if (!isInstalled()) return;
			const handler = observe(...args);
			return handler ? (payload) => isInstalled() ? handler(payload) : payload : undefined;
		};
		const wrapper = decorateProvider(native, guarded);
		pi.registerProvider(wrapper);
		return {
			provider: id, isInstalled,
			remove() {
				// Keep cleanup usable after bare SDK disposal invalidates the extension API.
				if (isInstalled()) registry.registerProvider(native);
			},
		};
	}
	const original = registry.getRegisteredProviderConfig(id);
	// Refresh callbacks own mutable catalog state inside the composer. Replacing
	// that composer cannot promise preservation, so leave it alone.
	if (!original?.streamSimple || original.refreshModels || original.oauth?.modifyModels) return;
	if (original.api !== model.api) return;
	// An injected legacy streamSimple overlay would also intercept full stream()
	// calls and change reasoning semantics. Only decorate an existing stream owner.
	const delegate = original.streamSimple.bind(original);
	const isInstalled = () => registry.getRegisteredProviderConfig(id)?.streamSimple === wrapper && !registry.getRegisteredNativeProvider(id);
	const guarded: ObserveRequest = (...args) => {
		if (!isInstalled()) return;
		const handler = observe(...args);
		return handler ? (payload) => isInstalled() ? handler(payload) : payload : undefined;
	};
	const wrapper: Provider["streamSimple"] = (requestModel, context, options) => delegate(requestModel, context, optionsWithObserver(requestModel, context, options, guarded));
	const remove = () => {
		if (!isInstalled()) return;
		// registerProvider merges undefined properties: remove our layer before restore.
		const restored = { ...registry.getRegisteredProviderConfig(id)!, streamSimple: original.streamSimple };
		registry.unregisterProvider(id);
		registry.registerProvider(id, restored);
	};
	Object.defineProperty(wrapper, STREAM_OBSERVER, { value: { delegate: original.streamSimple, release: remove } });
	pi.registerProvider(id, { ...original, streamSimple: wrapper });
	return { provider: id, isInstalled, remove };
}
