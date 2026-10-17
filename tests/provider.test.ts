import { expect, test } from "bun:test";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { decorateProvider, installObserver, STREAM_OBSERVER } from "../provider";
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
	const registry: any = { getRegisteredProviderConfig: () => config, getRegisteredNativeProvider: () => registered,
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
