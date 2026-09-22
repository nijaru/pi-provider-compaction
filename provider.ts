import type { Provider, StreamOptions, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ObserveRequest = (model: Model<any>, context: TranscriptContext, options: StreamOptions) => ((payload: unknown) => unknown | Promise<unknown>) | undefined;

function optionsWithObserver<T extends StreamOptions>(model: Model<any>, context: TranscriptContext, options: T | undefined, observe: ObserveRequest): T | undefined {
	const handler = observe(model, context, options ?? {});
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
export function installObserver(pi: ExtensionAPI, ctx: ExtensionContext, observe: ObserveRequest): (() => void) | undefined {
	const model = ctx.model;
	if (!model) return;
	const registry = ctx.modelRegistry;
	const id = model.provider;
	const native = registry.getRegisteredNativeProvider(id);
	if (native) {
		const guarded: ObserveRequest = (...args) => {
			const handler = observe(...args);
			return handler ? (payload) => registry.getRegisteredNativeProvider(id) === wrapper ? handler(payload) : payload : undefined;
		};
		const wrapper = decorateProvider(native, guarded);
		pi.registerProvider(wrapper);
		return () => {
			if (registry.getRegisteredNativeProvider(id) === wrapper) pi.registerProvider(native);
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
	const guarded: ObserveRequest = (...args) => {
		const handler = observe(...args);
		return handler ? (payload) => registry.getRegisteredProviderConfig(id)?.streamSimple === wrapper ? handler(payload) : payload : undefined;
	};
	const wrapper: Provider["streamSimple"] = (requestModel, context, options) => delegate(requestModel, context, optionsWithObserver(requestModel, context, options, guarded));
	pi.registerProvider(id, { ...original, api: original?.api ?? model.api, streamSimple: wrapper });
	return () => {
		const current = registry.getRegisteredProviderConfig(id);
		if (current?.streamSimple !== wrapper || registry.getRegisteredNativeProvider(id)) return;
		// registerProvider merges undefined properties: remove our layer before restore.
		const restored = { ...current };
		if (original?.streamSimple) restored.streamSimple = original.streamSimple;
		else delete restored.streamSimple;
		if (!original?.api && restored.api === model.api) delete restored.api;
		pi.unregisterProvider(id);
		if (Object.keys(restored).length) pi.registerProvider(id, restored);
	};
}
