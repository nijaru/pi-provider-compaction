import type { AssistantMessage, AssistantMessageEventStream, CacheRetention, Provider, StreamOptions, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PayloadObserver = ((payload: unknown) => unknown | Promise<unknown>) & {
	complete?: (message: AssistantMessage) => void;
	cacheRetention?: CacheRetention;
};
export type ObserveRequest = (model: Model<any>, context: TranscriptContext, options: StreamOptions) => PayloadObserver | undefined;

export interface InstalledObserver {
	provider: string;
	isInstalled(): boolean;
	remove(): void;
}

// Explicit cooperation with pi-fast-mode, not permission to replace arbitrary
// streams: this observer delegates unchanged and can release only its own slot.
export const STREAM_OBSERVER = Symbol.for("@nijaru/pi-provider-compaction/stream-observer");

function observedStream<T extends StreamOptions>(model: Model<any>, context: TranscriptContext, options: T | undefined, observe: ObserveRequest, dispatch: (options: T | undefined) => AssistantMessageEventStream): AssistantMessageEventStream {
	let handler: ReturnType<ObserveRequest>;
	try { handler = observe(model, context, options ?? {}); }
	catch { return dispatch(options); } // An expired optional observer must not veto dispatch.
	if (!handler) return dispatch(options);
	const stream = dispatch({
		...options,
		...(handler.cacheRetention === undefined ? {} : { cacheRetention: handler.cacheRetention }),
		onPayload: async (payload: unknown, requestModel: Model<any>) => {
			const replacement = await options?.onPayload?.(payload, requestModel);
			const prepared = replacement === undefined ? payload : replacement;
			// Observation failures must not suppress or alter the portable request.
			try { return await handler(prepared); } catch { return prepared; }
		},
	} as T);
	// result() observes completion without consuming the public event iterator.
	if (handler.complete) void stream.result().then(handler.complete).catch(() => {});
	return stream;
}

function guardedObserver(handler: PayloadObserver, current: () => boolean): PayloadObserver {
	return Object.assign((payload: unknown) => current() ? handler(payload) : payload, {
		cacheRetention: handler.cacheRetention,
		complete: handler.complete ? (message: AssistantMessage) => { if (current()) handler.complete!(message); } : undefined,
	});
}

/** Preserve method receivers, getters, optional members and dynamic catalogs. */
export function decorateProvider(base: Provider, observe: ObserveRequest): Provider {
	const stream: Provider["stream"] = (model, context, options) => observedStream(model, context, options, observe, (next) => base.stream(model, context, next));
	const streamSimple: Provider["streamSimple"] = (model, context, options) => observedStream(model, context, options, observe, (next) => base.streamSimple(model, context, next));
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

/** Observe a builtin/composer in place, preserving its auth, catalogs and dispatch closure. */
export function leaseEffectiveProvider(base: Provider | undefined, current: () => Provider | undefined, observe: ObserveRequest): InstalledObserver | undefined {
	if (!base) return;
	const keys = ["stream", "streamSimple"] as const;
	const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(base, key));
	if (descriptors.some((descriptor) => descriptor && (!("value" in descriptor) || !descriptor.configurable && !descriptor.writable)) || !Object.isExtensible(base) && descriptors.some((descriptor) => !descriptor)) return;
	const originalStream = base.stream, originalSimple = base.streamSimple;
	let released = false;
	const isInstalled = () => !released && current() === base && base.stream === stream && base.streamSimple === streamSimple;
	const guarded: ObserveRequest = (...args) => {
		if (!isInstalled()) return;
		const handler = observe(...args);
		return handler ? guardedObserver(handler, isInstalled) : undefined;
	};
	const stream: Provider["stream"] = (model, context, options) => observedStream(model, context, options, guarded, (next) => originalStream.call(base, model, context, next));
	const streamSimple: Provider["streamSimple"] = (model, context, options) => observedStream(model, context, options, guarded, (next) => originalSimple.call(base, model, context, next));
	const remove = () => {
		released = true;
		for (const [index, key] of keys.entries()) if (base[key] === (key === "stream" ? stream : streamSimple)) {
			const descriptor = descriptors[index];
			if (descriptor) Object.defineProperty(base, key, descriptor);
			else Reflect.deleteProperty(base, key);
		}
	};
	try {
		for (const [index, key] of keys.entries()) Object.defineProperty(base, key, { ...descriptors[index], value: key === "stream" ? stream : streamSimple, ...(descriptors[index] ? {} : { configurable: true, writable: true, enumerable: true }) });
	} catch { remove(); return; }
	return { provider: base.id, isInstalled, remove };
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
		let released = false;
		const isInstalled = () => !released && registry.getRegisteredNativeProvider(id) === wrapper;
		const guarded: ObserveRequest = (...args) => {
			if (!isInstalled()) return;
			const handler = observe(...args);
			return handler ? guardedObserver(handler, isInstalled) : undefined;
		};
		const wrapper = decorateProvider(native, guarded);
		pi.registerProvider(wrapper);
		return {
			provider: id, isInstalled,
			remove() {
				// Keep cleanup usable after bare SDK disposal invalidates the extension API.
				if (isInstalled()) registry.registerProvider(native);
				released = true;
			},
		};
	}
	const original = registry.getRegisteredProviderConfig(id);
	// Refresh callbacks own mutable catalog state inside the composer. Replacing
	// that composer cannot promise preservation, so leave it alone.
	if (!original?.streamSimple || original.refreshModels || original.oauth?.modifyModels || original.api !== model.api) {
		// Lease the effective object's methods, NOT its registry slot. Re-registering
		// a composed provider freezes catalogs and loses overlay/header semantics.
		return leaseEffectiveProvider(registry.getProvider(id), () => registry.getProvider(id), observe);
	}
	// An injected legacy streamSimple overlay would also intercept full stream()
	// calls and change reasoning semantics. Only decorate an existing stream owner.
	const delegate = original.streamSimple.bind(original);
	let released = false;
	const isInstalled = () => !released && registry.getRegisteredProviderConfig(id)?.streamSimple === wrapper && !registry.getRegisteredNativeProvider(id);
	const guarded: ObserveRequest = (...args) => {
		if (!isInstalled()) return;
		const handler = observe(...args);
		return handler ? guardedObserver(handler, isInstalled) : undefined;
	};
	const wrapper: Provider["streamSimple"] = (requestModel, context, options) => observedStream(requestModel, context, options, guarded, (next) => delegate(requestModel, context, next));
	const remove = () => {
		const owned = isInstalled();
		released = true;
		if (!owned) return;
		// registerProvider merges undefined properties: remove our layer before restore.
		const restored = { ...registry.getRegisteredProviderConfig(id)!, streamSimple: original.streamSimple };
		registry.unregisterProvider(id);
		registry.registerProvider(id, restored);
	};
	Object.defineProperty(wrapper, STREAM_OBSERVER, { value: { delegate: original.streamSimple, release: remove } });
	pi.registerProvider(id, { ...original, streamSimple: wrapper });
	return { provider: id, isInstalled, remove };
}
