import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { bindUsageHeaders, decorateProvider, installObserver, leaseEffectiveProvider, STREAM_OBSERVER } from "../provider";
import { NativeCompactionValidationError, requestProviderCompaction } from "../protocol";

const model = { provider: "fixture", api: "openai-responses", id: "fixture" } as any;
const context = normalizeContext({ messages: [] });

test("complete provider decorator preserves receivers, optional capabilities and callback semantics", async () => {
	const sentinel = {} as any;
	const calls: string[] = [];
	let forwarded: any;
	const base = {
		id: "fixture", name: "Fixture", auth: {},
		getModels() { expect(this).toBe(base); return [model]; },
		async refreshModels() { expect(this).toBe(base); calls.push("refresh"); },
		filterModels(models: any) { expect(this).toBe(base); return models; },
		fetchDeferred() { expect(this).toBe(base); return sentinel; },
		async cancelDeferred() { expect(this).toBe(base); calls.push("cancel"); },
		stream(_model: any, _context: any, options: any) { expect(this).toBe(base); forwarded = options; calls.push("full"); return sentinel; },
		streamSimple(_model: any, _context: any, options: any) { expect(this).toBe(base); forwarded = options; calls.push("simple"); return sentinel; },
	} as unknown as Provider;
	const seen: unknown[] = [];
	const decorated = decorateProvider(base, () => (payload) => { seen.push(payload); return payload; });
	expect(decorated.auth).toBe(base.auth);
	expect(decorated.getModels()).toEqual([model]);
	await decorated.refreshModels!({} as any);
	expect(decorated.filterModels!([model], undefined as any)).toEqual([model]);
	expect(decorated.fetchDeferred!(model, {} as any)).toBe(sentinel);
	await decorated.cancelDeferred!(model, {} as any);
	const fetch = (() => {}) as any;
	const options = { headers: { authorization: null }, fetch, serviceTier: "priority", onPayload: async (payload: any) => { await Promise.resolve(); payload.mutated = true; } };
	expect(decorated.stream(model, context, options)).toBe(sentinel);
	expect(forwarded.fetch).toBe(fetch);
	expect(forwarded.headers).toBe(options.headers);
	expect(await forwarded.onPayload({}, model)).toEqual({ mutated: true });
	expect(decorated.streamSimple(model, context, { onPayload: async () => null })).toBe(sentinel);
	expect(await forwarded.onPayload({}, model)).toBeNull();
	expect(seen).toEqual([{ mutated: true }, null]);
	expect(calls).toEqual(["refresh", "cancel", "full", "simple"]);
});

test("optional observer setup and payload failures never block the provider", async () => {
	const expected = {} as any;
	let forwarded: any;
	const base = {
		stream(_model: any, _context: any, options: any) { forwarded = options; return expected; },
		streamSimple(_model: any, _context: any, options: any) { forwarded = options; return expected; },
	} as Provider;
	const options = { onPayload: async (payload: any) => ({ ...payload, caller: true }) };
	const expired = decorateProvider(base, () => { throw new Error("disposed observer context"); });
	for (const method of ["stream", "streamSimple"] as const) {
		expect(expired[method](model, context, options)).toBe(expected);
		expect(forwarded).toBe(options);
	}
	const failed = decorateProvider(base, () => async () => { throw new Error("observation failed"); });
	failed.streamSimple(model, context, options);
	expect(await forwarded.onPayload({}, model)).toEqual({ caller: true });
	failed.streamSimple(model, context, { onPayload: () => { throw new Error("caller failure"); } });
	await expect(forwarded.onPayload({}, model)).rejects.toThrow("caller failure");
});

function registryFixture(original?: any, native?: Provider) {
	let config = original;
	let registered = native;
	const pi: any = {
		registerProvider(provider: any, value?: any) {
			if (typeof provider === "string") { registered = undefined; config = { ...config, ...value }; }
			else { registered = provider; config = undefined; }
		},
		unregisterProvider() { config = undefined; registered = undefined; },
	};
	const registry: any = { getProvider: () => registered, getRegisteredProviderConfig: () => config, getRegisteredNativeProvider: () => registered,
		registerProvider: pi.registerProvider, unregisterProvider: pi.unregisterProvider };
	const ctx: any = { model, modelRegistry: registry };
	return { pi, ctx, registry };
}

test("legacy /fast-style registration preserves callback/config and restores only its owned slot", async () => {
	let forwarded: any;
	const original = { api: model.api, headers: { "model-header": "kept" }, models: [{ ...model, headers: { special: "kept" } }], streamSimple(_model: any, _context: any, options: any) { expect(this).toBe(original); forwarded = options; return {} as any; } };
	const f = registryFixture(original);
	const installed = installObserver(f.pi, f.ctx, () => (payload) => ({ ...(payload as any), observed: true }))!;
	const wrapper = f.registry.getRegisteredProviderConfig().streamSimple;
	const lease = wrapper[STREAM_OBSERVER];
	expect(lease.delegate).toBe(original.streamSimple);
	expect(installed.isInstalled()).toBe(true);
	wrapper(model, context, { onPayload: (payload: any) => ({ ...payload, service_tier: "priority" }) });
	expect(await forwarded.onPayload({}, model)).toEqual({ service_tier: "priority", observed: true });
	expect(f.registry.getRegisteredProviderConfig().models).toBe(original.models);
	f.pi.registerProvider(model.provider, { name: "Updated independently" });
	lease.release();
	expect(installed.isInstalled()).toBe(false);
	expect(f.registry.getRegisteredProviderConfig()).toEqual({ ...original, name: "Updated independently" });
	const installed2 = installObserver(f.pi, f.ctx, () => undefined)!;
	const replacement = () => ({});
	f.pi.registerProvider(model.provider, { streamSimple: replacement });
	installed2.remove();
	expect(f.registry.getRegisteredProviderConfig().streamSimple).toBe(replacement);
});

test("a native base that cannot dispatch the active API is not falsely claimed", () => {
	const foreign = { ...model, api: "anthropic-messages" };
	const base = {
		id: "fixture", name: "Fixture", auth: {},
		getModels: () => [foreign], filterModels: (models: any) => models,
		stream() { return {} as any; }, streamSimple() { return {} as any; },
	} as unknown as Provider;
	const f = registryFixture(undefined, base);
	expect(installObserver(f.pi, f.ctx, () => undefined)).toBeUndefined();
	expect(f.registry.getRegisteredNativeProvider()).toBe(base);
});

test("plain builtins and stateful legacy composers are not replaced", () => {
	for (const config of [undefined, { api: model.api }, { api: model.api, streamSimple() {}, refreshModels() {} }, { api: model.api, streamSimple() {}, oauth: { modifyModels() {} } }]) {
		const f = registryFixture(config);
		expect(installObserver(f.pi, f.ctx, () => undefined)).toBeUndefined();
		expect(f.registry.getRegisteredProviderConfig()).toBe(config);
	}
});

const nativeUsage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
const nativeCheckpoint = { type: "compaction", encrypted_content: "opaque" };

function nativeProvider(onOptions: (options: any) => void): Provider {
	return {
		id: "fixture", name: "Fixture", auth: {}, getModels: () => [model],
		stream(_model: any, _context: any, options: any) {
			onOptions(options);
			void options.onPayload({ model: "fixture", input: [] });
			void options.fetch("https://fixture.invalid/v1/responses", { method: "POST", body: "{}", headers: {} });
			return (async function* () {
				yield { type: "done", message: { role: "assistant", api: "openai-responses", provider: "fixture", model: "fixture", content: [], usage: nativeUsage, stopReason: "stop", timestamp: Date.now() } };
			})();
		},
	} as unknown as Provider;
}

test("native transport forwards the captured service tier and keeps billed usage", async () => {
	let forwarded: any;
	const provider = nativeProvider((options) => { forwarded = options; });
	const result = await requestProviderCompaction({
		provider, model, context, input: [{ role: "user", content: "x" }], preparedPayload: { model: "fixture", input: [] },
		serviceTier: "priority", signal: new AbortController().signal, fetch: (async () => Response.json({ output: [nativeCheckpoint], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } })) as unknown as typeof fetch,
		protocol: "responses-compact",
	});
	expect(forwarded.serviceTier).toBe("priority");
	expect(result.output).toEqual([nativeCheckpoint]);
	expect(result.usage.cost.total).toBe(0.3);
});

test("an unusable native window reports the billed usage for the fallback", async () => {
	const provider = nativeProvider(() => {});
	const error = await requestProviderCompaction({
		provider, model, context, input: [{ role: "user", content: "x" }], preparedPayload: { model: "fixture", input: [] },
		signal: new AbortController().signal, fetch: (async () => Response.json({ output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } })) as unknown as typeof fetch,
		protocol: "responses-compact",
	}).catch((caught) => caught);
	expect(error).toBeInstanceOf(NativeCompactionValidationError);
	expect(error.usage.cost.total).toBe(0.3);
});

test("effective-provider leases preserve dispatch and cleanup without registry replacement", async () => {
	const complete = { role: "assistant" } as any;
	const stream = { result: async () => complete } as any;
	const calls: string[] = [], completions: unknown[] = [];
	let options: any;
	const base = { id: "builtin", auth: {}, getModels() { expect(this).toBe(base); return [model]; },
		stream(_model: any, _context: any, next: any) { expect(this).toBe(base); calls.push("full"); options = next; return stream; },
		streamSimple(_model: any, _context: any, next: any) { expect(this).toBe(base); calls.push("simple"); options = next; return stream; },
	} as unknown as Provider;
	const descriptors = Object.getOwnPropertyDescriptors(base);
	let current: Provider | undefined = base;
	const lease = leaseEffectiveProvider(base, () => current, () => Object.assign((payload: any) => ({ ...payload, observed: true }), { complete: (message: unknown) => { completions.push(message); }, cacheRetention: "long" as const }))!;
	expect(base.getModels()).toEqual([model]);
	const auth = base.auth;
	base.stream(model, context, { onPayload: async (payload: any) => ({ ...payload, lateHook: true }) });
	expect(await options.onPayload({}, model)).toEqual({ lateHook: true, observed: true });
	expect(options.cacheRetention).toBe("long");
	base.streamSimple(model, context, {});
	await Promise.resolve();
	expect(completions).toEqual([complete, complete]);
	expect(calls).toEqual(["full", "simple"]);
	expect(base.auth).toBe(auth);
	current = undefined; // Recomposition detached this provider; still restore owned methods.
	lease.remove();
	expect(Object.getOwnPropertyDescriptors(base)).toEqual(descriptors);
	expect(lease.isInstalled()).toBe(false);
});

test("pricing precedes terminal consumers and captured usage in both stream entrypoints", async () => {
	const captured: number[] = [];
	const dispatch = (_model: any, _context: any, options: any) => {
		const source = createAssistantMessageEventStream();
		void (async () => {
			await options.onPayload?.({}, model);
			const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop", usage: { ...nativeUsage, cost: { ...nativeUsage.cost, total: 1 } } };
			source.push({ type: "done", reason: "stop", message });
			source.end(message);
		})();
		return source;
	};
	const base = { id: "fixture", name: "Fixture", auth: {}, getModels: () => [model], stream: dispatch, streamSimple: dispatch } as Provider;
	const capture = leaseEffectiveProvider(base, () => base, () => Object.assign((payload: unknown) => payload, { complete: (message: any) => captured.push(message.usage.cost.total) }))!;
	const price = leaseEffectiveProvider(base, () => base, () => Object.assign((payload: unknown) => payload, { priceUsage: (message: any) => { message.usage.cost.total *= 2; } }))!;
	try {
		expect((await base.stream(model, context, {}).result()).usage.cost.total).toBe(2);
		const stream = base.streamSimple(model, context, {});
		for await (const event of stream) if (event.type === "done") expect(event.message.usage.cost.total).toBe(2);
		expect(captured).toEqual([2, 2]);
	} finally { price.remove(); capture.remove(); }
});

test("header identity scopes summary pricing without reading headers or crossing sessions", async () => {
	const dispatch = () => {
		const stream = createAssistantMessageEventStream();
		const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop", usage: { ...nativeUsage, cost: { ...nativeUsage.cost, total: 1 } } };
		queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
		return stream;
	};
	const base = { id: "fixture", name: "Fixture", auth: {}, getModels: () => [model], stream: dispatch, streamSimple: dispatch } as Provider;
	const acquire = (owner: string, multiplier: number) => leaseEffectiveProvider(base, () => base, (_model, _context, _options, scope) => Object.assign((payload: unknown) => payload, {
		priceUsage: (message: any) => { if (scope.sessionId === owner) message.usage.cost.total *= multiplier; },
	}))!;
	const leases = [acquire("A", 2), acquire("B", 3)];
	try {
		const headers = new Proxy({}, { ownKeys() { throw new Error("Pricing must not inspect header content"); }, get() { throw new Error("Pricing must not inspect header content"); } });
		bindUsageHeaders(headers, "A");
		expect((await base.streamSimple(model, context, { sessionId: "B", headers }).result()).usage.cost.total).toBe(2);
		expect((await base.streamSimple(model, context, { sessionId: "B" }).result()).usage.cost.total).toBe(3);
		expect((await base.streamSimple(model, context, { sessionId: "unowned" }).result()).usage.cost.total).toBe(1);
	} finally { for (const lease of leases) lease.remove(); }
});

for (const revoked of [false, true]) test(`in-flight pricing survives recomposition but not lease revocation (revoked=${revoked})`, async () => {
	const source = createAssistantMessageEventStream();
	const base = { id: "fixture", name: "Fixture", auth: {}, getModels: () => [model], stream: () => source, streamSimple: () => source } as Provider;
	let current: Provider = base;
	const lease = leaseEffectiveProvider(base, () => current, () => Object.assign((payload: unknown) => payload, { priceUsage: (message: any) => { message.usage.cost.total *= 2; } }))!;
	const output = base.streamSimple(model, context, {});
	if (revoked) lease.remove();
	else current = { ...base };
	const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop", usage: { ...nativeUsage, cost: { ...nativeUsage.cost, total: 1 } } };
	source.push({ type: "done", reason: "stop", message }); source.end(message);
	try { expect((await output.result()).usage.cost.total).toBe(revoked ? 1 : 2); }
	finally { lease.remove(); }
});

test("a priced source ending without a terminal event resolves as an error", async () => {
	const raw = { async *[Symbol.asyncIterator]() {}, result: () => new Promise(() => {}) } as any;
	const base = { id: "fixture", name: "Fixture", auth: {}, getModels: () => [model], stream: () => raw, streamSimple: () => raw } as Provider;
	const lease = leaseEffectiveProvider(base, () => base, () => Object.assign((payload: unknown) => payload, { priceUsage() {} }))!;
	try { expect((await base.streamSimple(model, context, {}).result()).stopReason).toBe("error"); }
	finally { lease.remove(); }
});

test("alternating shared-runtime leases stay bounded under Node", async () => {
	const built = await Bun.build({ entrypoints: [join(import.meta.dir, "provider-leases.node.ts")], target: "node" });
	expect(built.success).toBe(true);
	const other = await Bun.build({ entrypoints: [join(import.meta.dir, "../provider.ts")], target: "node" });
	expect(other.success).toBe(true);
	const result = spawnSync("node", ["--input-type=module", "-", Buffer.from(await other.outputs[0]!.text()).toString("base64")], { input: await built.outputs[0]!.text(), encoding: "utf8", timeout: 20_000 });
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});

for (const releaseFirst of [0, 1]) test(`effective shared leases select sessions and release independently (first=${releaseFirst})`, async () => {
	let forwarded: any;
	const sentinel = {} as any; // No result(): completion observation is optional.
	const base = { id: "fixture", stream(_m: any, _c: any, options: any) { forwarded = options; return sentinel; }, streamSimple(_m: any, _c: any, options: any) { forwarded = options; return sentinel; } } as Provider;
	const descriptors = Object.getOwnPropertyDescriptors(base);
	const seen: string[] = [];
	const acquire = (session: string) => leaseEffectiveProvider(base, () => base, (_m, _c, options) => options.sessionId === session ? Object.assign((payload: any) => {
		seen.push(session);
		return { ...payload, session };
	}, { cacheRetention: session === "A" ? "long" as const : "short" as const }) : undefined)!;
	const failures = [
		leaseEffectiveProvider(base, () => base, () => { throw new Error("expired session"); })!,
		leaseEffectiveProvider(base, () => base, () => () => { throw new Error("optional payload failure"); })!,
	];
	const leases = [acquire("A"), acquire("B")];
	const dispatch = async (sessionId: string) => {
		expect(base.streamSimple(model, context, { sessionId, onPayload: async () => { await Promise.resolve(); return { caller: true }; } })).toBe(sentinel);
		return forwarded.onPayload ? forwarded.onPayload({}, model) : undefined;
	};
	expect(leases.map((lease) => lease.isInstalled())).toEqual([true, true]);
	expect(await dispatch("A")).toEqual({ caller: true, session: "A" });
	expect(forwarded.cacheRetention).toBe("long");
	expect(await dispatch("B")).toEqual({ caller: true, session: "B" });
	expect(forwarded.cacheRetention).toBe("short");
	const removed = releaseFirst === 0 ? "A" : "B", kept = releaseFirst === 0 ? "B" : "A";
	leases[releaseFirst]!.remove();
	expect(leases[1 - releaseFirst]!.isInstalled()).toBe(true);
	expect(await dispatch(removed)).toEqual({ caller: true });
	expect(await dispatch(kept)).toEqual({ caller: true, session: kept });
	leases[releaseFirst] = acquire(removed);
	expect(await dispatch(removed)).toEqual({ caller: true, session: removed });
	leases.forEach((lease) => lease.remove());
	failures.forEach((lease) => lease.remove());
	expect(seen).toEqual(["A", "B", kept, removed]);
	expect(Object.getOwnPropertyDescriptors(base)).toEqual(descriptors);
});

test("release and reacquire cannot revive an in-flight payload or completion observer", async () => {
	let forwarded: any, finish: (message: any) => void;
	const stream = { result: () => new Promise<any>((resolve) => { finish = resolve; }) } as any;
	const base = { id: "fixture", streamSimple(_m: any, _c: any, options: any) { forwarded = options; return stream; }, stream() { return stream; } } as unknown as Provider;
	const seen: string[] = [];
	const acquire = (session: string) => leaseEffectiveProvider(base, () => base, (_m, _c, options) => options.sessionId === session ? Object.assign((payload: unknown) => { seen.push(session); return payload; }, { complete: () => { seen.push(`${session} complete`); } }) : undefined)!;
	const first = acquire("A"), second = acquire("B");
	let finishHook!: (payload: unknown) => void;
	base.streamSimple(model, context, { sessionId: "A", onPayload: () => new Promise((resolve) => { finishHook = resolve; }) });
	const payload = forwarded.onPayload({}, model);
	first.remove();
	const replacement = acquire("A");
	finishHook({ caller: true });
	expect(await payload).toEqual({ caller: true });
	finish!({});
	await Promise.resolve();
	expect(seen).toEqual([]);
	expect(replacement.isInstalled()).toBe(true);
	expect(second.isInstalled()).toBe(true);
	second.remove(); replacement.remove();
});

test("effective reacquisition preserves external replacements and restores detached descriptors", () => {
	const original = (() => ({})) as any;
	const prototype = { streamSimple: original };
	const base = Object.assign(Object.create(prototype), { id: "fixture" }) as Provider;
	Object.defineProperty(base, "stream", { value: original, configurable: false, writable: true, enumerable: false });
	const descriptors = Object.getOwnPropertyDescriptors(base);
	let current: Provider | undefined = base;
	const acquire = () => leaseEffectiveProvider(base, () => current, () => undefined)!;
	const first = acquire(), second = acquire();
	const saved = { stream: base.stream, streamSimple: base.streamSimple };
	const replacement = (() => ({})) as any;
	base.stream = replacement;
	expect(first.isInstalled()).toBe(false);
	const third = acquire(); // Prune the still-owned simple method before reacquiring.
	first.remove(); second.remove();
	expect(third.isInstalled()).toBe(true);
	current = undefined;
	third.remove();
	expect(Object.getOwnPropertyDescriptors(base)).toEqual({ ...descriptors, stream: { ...descriptors.stream, value: replacement } });
	expect(Object.hasOwn(base, "streamSimple")).toBe(false);
	// Even an explicitly reinstated, released pair cannot revive its leases or
	// become a new dispatch history on the next acquisition.
	Object.assign(base, saved);
	current = base;
	const fourth = acquire();
	expect(first.isInstalled()).toBe(false);
	expect(fourth.isInstalled()).toBe(true);
	fourth.remove();
	expect(Object.getOwnPropertyDescriptors(base)).toEqual(descriptors);
});

test("mixed native and models.json APIs each receive one pricing lease", async () => {
	const directory = await mkdtemp(join(tmpdir(), "provider-mixed-api-"));
	const rates = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
	const nativeModel: any = { ...model, id: "native", api: "openai-completions", name: "Native", baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: false, contextWindow: 10000, maxTokens: 100, cost: rates };
	const dispatch = () => {
		const stream = createAssistantMessageEventStream();
		const message: any = { role: "assistant", api: nativeModel.api, provider: model.provider, model: nativeModel.id, timestamp: Date.now(), content: [], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1e-6, output: 0, cacheRead: 0, cacheWrite: 0, total: 1e-6 } } };
		queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
		return stream;
	};
	const base = { id: model.provider, name: "Fixture", auth: { apiKey: { name: "Fixture", login: async () => ({ type: "api_key", key: "fixture" }), resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }) } },
		getModels: () => [nativeModel], stream: dispatch, streamSimple: dispatch } as Provider;
	const leases: ReturnType<typeof installObserver>[] = [];
	try {
		const modelsPath = join(directory, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { models: [{ id: "response-only", api: "openai-responses", contextWindow: 10000, maxTokens: 100, cost: rates }] } } }));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, modelsStorePath: join(directory, "catalog.json"), refreshOnCreate: false });
		runtime.registerNativeProvider(base);
		const registry = new ModelRegistry(runtime);
		const pi = { registerProvider: registry.registerProvider.bind(registry) } as any;
		for (const id of ["native", "response-only"]) {
			const target = registry.find(model.provider, id)!;
			const lease = installObserver(pi, { model: target, modelRegistry: registry }, () => Object.assign((payload: unknown) => payload, { priceUsage: (message: any) => { message.usage.cost.total *= 0.5; } }));
			leases.push(lease);
			expect(lease?.api).toBe(target.api);
		}
		const fetch = (async () => {
			const response = { id: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
			return new Response(`data: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
		}) as unknown as typeof globalThis.fetch;
		for (const id of ["native", "response-only"]) {
			const reply = await runtime.streamSimple(registry.find(model.provider, id)!, context, { fetch }).result();
			expect(reply.stopReason).toBe("stop");
			expect(reply.usage.cost.total).toBeCloseTo(0.5e-6, 12);
		}
	} finally { for (const lease of leases) lease?.remove(); await rm(directory, { recursive: true, force: true }); }
});

for (const kind of ["native", "legacy"] as const) for (const releaseFirst of [0, 1]) test(`real Pi ${kind} registration shares one dispatcher (release first=${releaseFirst})`, async () => {
	const directory = await mkdtemp(join(tmpdir(), "provider-leases-"));
	try {
		const modelsPath = join(directory, "models.json");
		await writeFile(modelsPath, JSON.stringify({ providers: { fixture: { headers: { "x-fixture": "kept" } } } }));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, modelsStorePath: join(directory, "catalog.json"), refreshOnCreate: false });
		const registries = [new ModelRegistry(runtime), new ModelRegistry(runtime)];
		const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../provider.ts")], target: "bun" });
		expect(built.success).toBe(true);
		const other: typeof import("../provider") = await import(`data:text/javascript;base64,${Buffer.from(await built.outputs[0]!.text()).toString("base64")}`);
		const captures: string[] = [], completions: string[] = [], calls: string[] = [];
		const payloads: any[] = [];
		const fixtureModel = { ...model, name: "Fixture", baseUrl: "https://fixture.invalid", input: ["text"], reasoning: false, contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		const dispatch = (method: string, options: any) => {
			calls.push(method);
			const stream = createAssistantMessageEventStream();
			void (async () => {
				payloads.push(await options.onPayload({}, fixtureModel));
				const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: nativeUsage, timestamp: 0 } as any;
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			})();
			return stream;
		};
		const base = { id: model.provider, name: "Fixture", auth: { apiKey: { name: "Fixture", login: async () => ({ type: "api_key", key: "fixture" }), resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }) } }, getModels: () => [fixtureModel],
			stream(_m: any, _c: any, options: any) { expect(this).toBe(base); return dispatch("full", options); },
			streamSimple(_m: any, _c: any, options: any) { if (kind === "native") expect(this).toBe(base); return dispatch("simple", options); },
		} as Provider;
		if (kind === "native") runtime.registerNativeProvider(base);
		else runtime.registerProvider(model.provider, { api: model.api, apiKey: "fixture", models: [fixtureModel], streamSimple: base.streamSimple });
		const originalConfig = runtime.getRegisteredProviderConfig(model.provider);
		const acquire = (index: number) => {
			const registry = registries[index]!;
			return (index === 0 ? installObserver : other.installObserver)({ registerProvider: registry.registerProvider.bind(registry) } as any, { model: fixtureModel, modelRegistry: registry } as any, (_m, _c, options) => {
				if (options.sessionId !== String(index)) return;
				return Object.assign((payload: any) => { captures.push(String(index)); return { ...payload, session: index }; }, { complete: () => { completions.push(String(index)); } });
			})!;
		};
		const leases = [acquire(0), acquire(1)];
		expect(leases.map((lease) => lease.isInstalled())).toEqual([true, true]);
		const send = async (index: number, method: "stream" | "streamSimple" = "streamSimple") => {
			const stream = runtime.getProvider(model.provider)![method](fixtureModel, context, { sessionId: String(index), onPayload: async () => { await Promise.resolve(); return { caller: true }; } });
			const events = [];
			for await (const event of stream) events.push(event);
			expect(events.map((event) => event.type)).toEqual(["done"]);
			expect((await stream.result()).stopReason).toBe("stop");
			return payloads.at(-1);
		};
		expect(await send(0, "stream")).toEqual({ caller: true, session: 0 });
		expect(await send(1)).toEqual({ caller: true, session: 1 });
		expect(calls).toEqual([kind === "native" ? "full" : "simple", "simple"]);
		expect(completions).toEqual(["0", "1"]);
		leases[releaseFirst]!.remove();
		expect(await send(releaseFirst)).toEqual({ caller: true });
		expect(await send(1 - releaseFirst)).toEqual({ caller: true, session: 1 - releaseFirst });
		// Recomposition changes the effective object, not the shared registered owner.
		const effective = runtime.getProvider(model.provider);
		if (kind === "native") registries[0]!.registerProvider(runtime.getRegisteredNativeProvider(model.provider)!);
		else registries[0]!.registerProvider(model.provider, { name: "Independent update" });
		expect(runtime.getProvider(model.provider)).not.toBe(effective);
		expect(leases[1 - releaseFirst]!.isInstalled()).toBe(true);
		leases[releaseFirst] = acquire(releaseFirst);
		expect(await send(releaseFirst)).toEqual({ caller: true, session: releaseFirst });
		expect(captures).toEqual(["0", "1", String(1 - releaseFirst), String(releaseFirst)]);
		expect(completions).toEqual(captures);
		if (kind === "legacy") {
			const marker = Reflect.get(runtime.getRegisteredProviderConfig(model.provider)!.streamSimple!, STREAM_OBSERVER);
			expect(marker.delegate).toBe(base.streamSimple);
			marker.release(); // /fast must be able to retire every lease over its delegate.
			expect(leases.map((lease) => lease.isInstalled())).toEqual([false, false]);
		}
		leases.forEach((lease) => lease.remove());
		if (kind === "native") expect(runtime.getRegisteredNativeProvider(model.provider)).toBe(base);
		else expect(runtime.getRegisteredProviderConfig(model.provider)).toEqual({ ...originalConfig, name: "Independent update" });
		const last = acquire(0);
		if (kind === "native") {
			const replacement = { ...base, name: "Unrelated owner" };
			registries[1]!.registerProvider(replacement);
			last.remove();
			expect(runtime.getRegisteredNativeProvider(model.provider)).toBe(replacement);
		} else {
			const replacement = (() => ({})) as any;
			registries[1]!.registerProvider(model.provider, { api: model.api, streamSimple: replacement });
			last.remove();
			expect(runtime.getRegisteredProviderConfig(model.provider)!.streamSimple).toBe(replacement);
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});
