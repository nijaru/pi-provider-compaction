import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type CacheRetention, type Provider, type StreamOptions, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
interface UsageScope { sessionId?: string; }
const USAGE_OWNERS = Symbol.for("@nijaru/pi-provider-compaction/usage-owners");
const usageGlobal = globalThis as typeof globalThis & { [USAGE_OWNERS]?: WeakMap<object, string> };
const usageOwners = usageGlobal[USAGE_OWNERS] ??= new WeakMap<object, string>();

/** Associate the SDK-owned header record without reading or changing any headers. */
export function bindUsageHeaders(headers: object, sessionId: string): void {
	usageOwners.set(headers, sessionId);
}

export type PayloadObserver = ((payload: unknown) => unknown | Promise<unknown>) & {
	complete?: (message: AssistantMessage) => void;
	/** Adjust only usage before any completion observer or consumer sees it. */
	priceUsage?: (message: AssistantMessage) => void;
	cacheRetention?: CacheRetention;
};
export type ObserveRequest = (model: Model<any>, context: TranscriptContext, options: StreamOptions, scope: UsageScope) => PayloadObserver | undefined;

export interface InstalledObserver {
	provider: string;
	/** installObserver leases one dispatch API; lower-level leases can be unscoped. */
	api?: string;
	isInstalled(): boolean;
	remove(): void;
}

// Explicit cooperation with pi-fast-mode, not permission to replace arbitrary
// streams: this observer delegates unchanged and can release only its own slot.
export const STREAM_OBSERVER = Symbol.for("@nijaru/pi-provider-compaction/stream-observer");

function observedStream<T extends StreamOptions>(model: Model<any>, context: TranscriptContext, options: T | undefined, observe: ObserveRequest, dispatch: (options: T | undefined) => AssistantMessageEventStream): AssistantMessageEventStream {
	const headerOwner = options?.headers ? usageOwners.get(options.headers) : undefined;
	const scope: UsageScope = { sessionId: headerOwner ?? options?.sessionId };
	let handler: ReturnType<ObserveRequest>;
	try { handler = observe(model, context, options ?? {}, scope); }
	catch { return dispatch(options); } // An expired optional observer must not veto dispatch.
	if (!handler) return dispatch(options);
	const run = () => dispatch({
		...options,
		...(handler.cacheRetention === undefined ? {} : { cacheRetention: handler.cacheRetention }),
		onPayload: async (payload: unknown, requestModel: Model<any>) => {
			const replacement = await options?.onPayload?.(payload, requestModel);
			const prepared = replacement === undefined ? payload : replacement;
			// Observation failures must not suppress or alter the portable request.
			try { return await handler(prepared); } catch { return prepared; }
		},
	} as T);
	const stream = run();
	if (handler.priceUsage) return pricedStream(stream, model, handler);
	// Pure capture remains transparent, including the original stream identity.
	if (handler.complete) void stream.result().then(handler.complete).catch(() => {});
	return stream;
}

/** Pricing must precede both terminal-event delivery and result() resolution. */
function pricedStream(stream: AssistantMessageEventStream, model: Model<any>, handler: PayloadObserver): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		let final: AssistantMessage | undefined;
		let partial: AssistantMessage | undefined;
		try {
			for await (const event of stream) {
				if ("partial" in event) partial = event.partial;
				if (event.type === "done" || event.type === "error") {
					final = event.type === "done" ? event.message : event.error;
					try { handler.priceUsage?.(final); } catch { /* Optional estimates never veto completion. */ }
					try { handler.complete?.(final); } catch { /* Capture failure never vetoes completion. */ }
				}
				out.push(event);
			}
			if (final) { out.end(final); return; }
		} catch { /* Malformed plugin streams still need a terminal outcome. */ }
		const message: AssistantMessage = {
			...(partial ?? {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}),
			stopReason: "error", errorMessage: "Provider stream ended before a terminal event",
		};
		try { handler.priceUsage?.(message); } catch { /* Preserve the known usage on pricing failure. */ }
		out.push({ type: "error", reason: "error", error: message });
		out.end(message);
	})();
	return out;
}

/** One dispatch layer, with session-local selection and no released lease history. */
function observerLeases(provider: string, owned: () => boolean, restore: () => void) {
	const leases = new Map<symbol, { observe: ObserveRequest; current: () => boolean }>();
	let closed = false;
	const live = (token: symbol) => !closed && leases.has(token);
	const active = (token: symbol) => live(token) && leases.get(token)?.current() === true && owned();
	const release = () => {
		if (closed) return;
		closed = true;
		leases.clear();
		restore();
	};
	const observe: ObserveRequest = (...args) => {
		const handlers: PayloadObserver[] = [];
		for (const [token, lease] of leases) {
			try {
				if (!active(token)) continue;
				const handler = lease.observe(...args);
				if (!handler) continue;
				handlers.push(Object.assign((payload: unknown) => active(token) ? handler(payload) : payload, {
					cacheRetention: handler.cacheRetention,
					// A catalog/API recomposition may detach a provider after dispatch.
					// Its in-flight bill still uses the sampled policy; explicit lease
					// removal/disposal, unlike recomposition, revokes that callback.
					priceUsage: handler.priceUsage ? (message: AssistantMessage) => { if (live(token)) handler.priceUsage!(message); } : undefined,
					complete: handler.complete ? (message: AssistantMessage) => { if (active(token)) handler.complete!(message); } : undefined,
				}));
			} catch { /* A failed optional observer must not disable the other sessions. */ }
		}
		if (!handlers.length) return;
		return Object.assign(async (payload: unknown) => {
			for (const handler of handlers) {
				try {
					const replacement = await handler(payload);
					if (replacement !== undefined) payload = replacement;
				} catch { /* Keep the last valid request on optional observation failure. */ }
			}
			return payload;
		}, {
			cacheRetention: [...handlers].reverse().find((handler) => handler.cacheRetention !== undefined)?.cacheRetention,
			priceUsage: handlers.some((handler) => handler.priceUsage) ? (message: AssistantMessage) => {
				for (const handler of handlers) {
					try { handler.priceUsage?.(message); } catch { /* Isolate independent pricing owners. */ }
				}
			} : undefined,
			complete: handlers.some((handler) => handler.complete) ? (message: AssistantMessage) => {
				for (const handler of handlers) {
					try { handler.complete?.(message); } catch { /* Isolate optional completion observers too. */ }
				}
			} : undefined,
		});
	};
	return {
		observe, release, isOpen: () => !closed,
		add(observe: ObserveRequest, current: () => boolean = () => true): InstalledObserver {
			const token = Symbol();
			leases.set(token, { observe, current });
			return { provider, isInstalled: () => active(token), remove() {
				leases.delete(token);
				if (!leases.size) release();
			} };
		},
	};
}

type ObserverLeases = ReturnType<typeof observerLeases>;
// Pi's uncached module loader can instantiate this extension separately for
// sessions sharing one model runtime. Weak ownership must span those instances.
const LEASE_TABLES = Symbol.for("@nijaru/pi-provider-compaction/observer-leases-v2");
interface LeaseTables {
	effectiveLeases: WeakMap<Provider, { owned(): boolean; leases: ObserverLeases }>;
	effectiveRestores: WeakMap<Function, { base: Provider; restore(): void }>;
	nativeLeases: WeakMap<Provider, ObserverLeases>;
	legacyLeases: WeakMap<Provider["streamSimple"], ObserverLeases>;
}
const shared = globalThis as typeof globalThis & { [LEASE_TABLES]?: LeaseTables };
const { effectiveLeases, effectiveRestores, nativeLeases, legacyLeases } = shared[LEASE_TABLES] ??= {
	effectiveLeases: new WeakMap(), effectiveRestores: new WeakMap(),
	nativeLeases: new WeakMap(), legacyLeases: new WeakMap(),
};

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
	const existing = effectiveLeases.get(base);
	if (existing?.leases.isOpen() && existing.owned()) return existing.leases.add(observe, () => current() === base);
	// External replacement invalidated the old pair. Restore its still-owned
	// method before capturing delegates, rather than burying a released wrapper.
	existing?.leases.release();
	// A third party may have restored saved method values after their release.
	// They remain inert, but must not become delegates of another observation layer.
	const keys = ["stream", "streamSimple"] as const;
	for (const key of keys) {
		const saved = effectiveRestores.get(base[key]);
		if (saved?.base === base) saved.restore();
	}
	const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(base, key));
	if (descriptors.some((descriptor) => descriptor && (!("value" in descriptor) || !descriptor.configurable && !descriptor.writable)) || !Object.isExtensible(base) && descriptors.some((descriptor) => !descriptor)) return;
	const originalStream = base.stream, originalSimple = base.streamSimple;
	const owned = () => base.stream === stream && base.streamSimple === streamSimple;
	const restore = () => {
		for (const [index, key] of keys.entries()) if (base[key] === (key === "stream" ? stream : streamSimple)) {
			const descriptor = descriptors[index];
			if (descriptor) Object.defineProperty(base, key, descriptor);
			else Reflect.deleteProperty(base, key);
		}
	};
	const leases = observerLeases(base.id, owned, restore);
	const stream: Provider["stream"] = (model, context, options) => observedStream(model, context, options, leases.observe, (next) => originalStream.call(base, model, context, next));
	const streamSimple: Provider["streamSimple"] = (model, context, options) => observedStream(model, context, options, leases.observe, (next) => originalSimple.call(base, model, context, next));
	try {
		for (const [index, key] of keys.entries()) Object.defineProperty(base, key, { ...descriptors[index], value: key === "stream" ? stream : streamSimple, ...(descriptors[index] ? {} : { configurable: true, writable: true, enumerable: true }) });
	} catch { leases.release(); return; }
	for (const method of [stream, streamSimple]) effectiveRestores.set(method, { base, restore });
	effectiveLeases.set(base, { owned, leases });
	return leases.add(observe, () => current() === base);
}

/**
	* Pi 0.87 has replacement registration, not middleware. Native BASE providers can
	* be decorated directly. Legacy stream overlays retain their configuration and
	* delegate their original callback (including /fast). Never register an effective
	* composed provider as a native base: that loses model headers and freezes config.
	*/
export function installObserver(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "model" | "modelRegistry">, observe: ObserveRequest): InstalledObserver | undefined {
	const model = ctx.model;
	if (!model) return;
	const registry = ctx.modelRegistry;
	const id = model.provider;
	const observeApi: ObserveRequest = (requestModel, ...args) => requestModel.api === model.api ? observe(requestModel, ...args) : undefined;
	const tagged = (lease: InstalledObserver | undefined) => lease ? Object.assign(lease, { api: model.api }) : undefined;
	const effective = () => {
		const base = registry.getProvider(id);
		if (!base?.getModels().some((entry) => entry.api === model.api)) return;
		return tagged(leaseEffectiveProvider(base, () => registry.getProvider(id), observeApi));
	};
	const native = registry.getRegisteredNativeProvider(id);
	if (native) {
		// Pi composes a native base only when its catalog serves the active API.
		// Otherwise the request goes to the global API provider and bypasses this
		// wrapper; claiming an observer there would report native compaction as
		// installed while never capturing anything.
		if (typeof native.getModels !== "function" || !native.getModels().some((entry) => entry.api === model.api)) return effective();
		const existing = nativeLeases.get(native);
		if (existing) return tagged(existing.add(observeApi));
		const leases = observerLeases(id, () => registry.getRegisteredNativeProvider(id) === wrapper, () => {
			// Keep cleanup usable after bare SDK disposal invalidates the extension API.
			if (registry.getRegisteredNativeProvider(id) === wrapper) registry.registerProvider(native);
			nativeLeases.delete(wrapper);
		});
		const wrapper = decorateProvider(native, leases.observe);
		nativeLeases.set(wrapper, leases);
		pi.registerProvider(wrapper);
		return tagged(leases.add(observeApi));
	}
	const original = registry.getRegisteredProviderConfig(id);
	// Refresh callbacks own mutable catalog state inside the composer. Replacing
	// that composer cannot promise preservation, so leave it alone.
	if (!original?.streamSimple || original.refreshModels || original.oauth?.modifyModels || original.api !== model.api) {
		// Lease the effective object's methods, NOT its registry slot. Re-registering
		// a composed provider freezes catalogs and loses overlay/header semantics.
		return effective();
	}
	// An injected legacy streamSimple overlay would also intercept full stream()
	// calls and change reasoning semantics. Only decorate an existing stream owner.
	const existing = legacyLeases.get(original.streamSimple);
	if (existing) return tagged(existing.add(observeApi));
	const delegate = original.streamSimple.bind(original);
	const owned = () => registry.getRegisteredProviderConfig(id)?.streamSimple === wrapper && !registry.getRegisteredNativeProvider(id);
	const leases = observerLeases(id, owned, () => {
		legacyLeases.delete(wrapper);
		if (!owned()) return;
		// registerProvider merges undefined properties: remove our layer before restore.
		const restored = { ...registry.getRegisteredProviderConfig(id)!, streamSimple: original.streamSimple };
		registry.unregisterProvider(id);
		registry.registerProvider(id, restored);
	});
	const wrapper: Provider["streamSimple"] = (requestModel, context, options) => observedStream(requestModel, context, options, leases.observe, (next) => delegate(requestModel, context, next));
	// /fast owns the delegate: its cleanup must release all observing sessions.
	Object.defineProperty(wrapper, STREAM_OBSERVER, { value: { delegate: original.streamSimple, release: leases.release } });
	legacyLeases.set(wrapper, leases);
	pi.registerProvider(id, { ...original, streamSimple: wrapper });
	return tagged(leases.add(observeApi));
}
