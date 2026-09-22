import { expect, test } from "bun:test";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { decorateProvider, installObserver } from "../provider";

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
	const registry: any = { getRegisteredProviderConfig: () => config, getRegisteredNativeProvider: () => registered };
	const ctx: any = { model, modelRegistry: registry };
	return { pi, ctx, registry };
}

test("legacy /fast-style registration preserves callback/config and restores only its owned slot", async () => {
	let forwarded: any;
	const original = { api: model.api, headers: { "model-header": "kept" }, models: [{ ...model, headers: { special: "kept" } }], streamSimple(_model: any, _context: any, options: any) { expect(this).toBe(original); forwarded = options; return {} as any; } };
	const f = registryFixture(original);
	const remove = installObserver(f.pi, f.ctx, () => (payload) => ({ ...(payload as any), observed: true }))!;
	f.registry.getRegisteredProviderConfig().streamSimple(model, context, { onPayload: (payload: any) => ({ ...payload, service_tier: "priority" }) });
	expect(await forwarded.onPayload({}, model)).toEqual({ service_tier: "priority", observed: true });
	expect(f.registry.getRegisteredProviderConfig().models).toBe(original.models);
	f.pi.registerProvider(model.provider, { name: "Updated independently" });
	remove();
	expect(f.registry.getRegisteredProviderConfig()).toEqual({ ...original, name: "Updated independently" });
	const remove2 = installObserver(f.pi, f.ctx, () => undefined)!;
	const replacement = () => ({});
	f.pi.registerProvider(model.provider, { streamSimple: replacement });
	remove2();
	expect(f.registry.getRegisteredProviderConfig().streamSimple).toBe(replacement);
});

test("plain builtins and stateful legacy composers are not replaced", () => {
	for (const config of [undefined, { api: model.api }, { api: model.api, streamSimple() {}, refreshModels() {} }, { api: model.api, streamSimple() {}, oauth: { modifyModels() {} } }]) {
		const f = registryFixture(config);
		expect(installObserver(f.pi, f.ctx, () => undefined)).toBeUndefined();
		expect(f.registry.getRegisteredProviderConfig()).toBe(config);
	}
});
