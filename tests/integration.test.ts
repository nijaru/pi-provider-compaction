import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createProvider, InMemoryCredentialStore, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, convertToLlm, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { STREAM_OBSERVER } from "../provider";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const checkpoint = { type: "compaction", encrypted_content: "native-prefix" };
const usage = { input_tokens: 20, output_tokens: 4, total_tokens: 24 };
function completion(text: string, cached = false, truncated = false): Response {
	const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const response = { id: "resp_fixture", status: truncated ? "incomplete" : "completed", ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}), output: [item], usage: cached ? { ...usage, input_tokens_details: { cached_tokens: 15 } } : usage };
	const events = [
		{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_text.done", output_index: 0, content_index: 0, text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function loadExternalExtension(path: string): Promise<(pi: ExtensionAPI) => void> {
	// Extracted packages need the same host bindings Pi supplies at runtime.
	const built = await Bun.build({ entrypoints: [path], target: "bun", packages: "external", plugins: [{ name: "pi-host-bindings", setup(build) { build.onResolve({ filter: /^@earendil-works\// }, ({ path }) => ({ path: import.meta.resolve(path), external: true })); } }] });
	if (!built.success) throw new Error(`Could not load extension fixture: ${path}`);
	return (await import(`data:text/javascript;base64,${Buffer.from(await built.outputs[0]!.text()).toString("base64")}`)).default;
}

async function fixture(options: { hooks?: (pi: ExtensionAPI) => void; hooksFirst?: boolean; firstHooks?: (pi: ExtensionAPI) => void; flagValues?: Map<string, string | boolean>; nativeFailure?: boolean; api?: string; thinking?: boolean; fastFactory?: (pi: ExtensionAPI) => void; legacy?: boolean; cached?: boolean; cacheTtl?: number; settings?: Record<string, unknown>; beforeReply?: (body: any) => void; builtin?: string; summaryLength?: boolean; minimumSummaryTokens?: number; seed?: (manager: SessionManager, model: Model<any>) => void } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "provider-compaction-fixture-"));
	const requests: { url: string; body: any; headers: Headers }[] = [];
	const authControl: { key: string; beforeResolve?: () => void; beforeNative?: () => void } = { key: "fixture" };
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith("https://fixture.invalid/")) throw new Error(`Unexpected fixture network: ${url}`);
		const headers = new Headers(init?.headers);
		const body = JSON.parse(headers.get("content-encoding") === "zstd" ? zstdDecompressSync(init!.body as Uint8Array).toString() : String(init?.body));
		requests.push({ url, body, headers: new Headers(init?.headers) });
		if (new URL(url).pathname.endsWith("/compact")) authControl.beforeNative?.();
		if (new URL(url).pathname.endsWith("/compact")) return options.nativeFailure ? Response.json({ error: { message: "fixture failure" } }, { status: 400 }) : Response.json({ output: [checkpoint], usage });
		if (body.input?.some((item: any) => item.type === "compaction_trigger")) {
			const response = { id: "resp_native", status: "completed", output: [checkpoint], usage };
			return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
		}
		await options.beforeReply?.(body);
		if (options.api === "openai-completions") {
			const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content: "Portable summary fixture" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: options.cached ? 15 : 0 } } }];
			return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl_fixture", model: "fixture", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		}
		if (options.api === "anthropic-messages") {
			const events = [{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: options.cached ? 15 : 0 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Portable summary fixture" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }, { type: "message_stop" }];
			return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		}
		const summary = JSON.stringify(body).includes("Write a portable context checkpoint");
		const cap = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
		const truncated = options.summaryLength && JSON.stringify(body).includes("retained-boundary") || summary && options.minimumSummaryTokens !== undefined && typeof cap === "number" && cap < options.minimumSummaryTokens;
		return completion("Portable summary fixture", options.cached, truncated);
	}) as typeof fetch;
	const model: Model<any> = { provider: options.builtin ?? (options.fastFactory ? "openai-codex" : "fixture"), api: options.api ?? "openai-responses", id: options.fastFactory ? "gpt-5.5" : "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", reasoning: options.thinking ?? false, ...(options.cacheTtl ? { promptCache: { short: options.cacheTtl, long: options.cacheTtl * 2 } } : {}), compat: { supportsMidConvoEffort: options.thinking ?? false }, input: ["text", "image"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const credentials = new InMemoryCredentialStore();
	if (options.builtin) await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fixture" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
	const provider = createProvider({ id: model.provider, name: "Fixture", baseUrl: model.baseUrl, models: [model], api: options.api === "openai-completions" ? openAICompletionsApi() : options.api === "anthropic-messages" ? anthropicMessagesApi() : options.api === "azure-openai-responses" ? azureOpenAIResponsesApi() : options.api === "openai-codex-responses" ? openAICodexResponsesApi() : openAIResponsesApi(), auth: { apiKey: { name: "Fixture", login: async () => ({ type: "api_key", key: "fixture" }), resolve: async () => { authControl.beforeResolve?.(); return ({ auth: { apiKey: options.api === "openai-codex-responses" ? `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c` : authControl.key, headers: { "x-deleted": null } }, source: "fixture" }); } } } });
	const legacyStream = provider.streamSimple.bind(provider);
	if (options.fastFactory) runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c`, models: [model] });
	else if (options.legacy) runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "fixture", models: [model], streamSimple: legacyStream });
	else if (!options.builtin) runtime.registerNativeProvider(provider);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 40, reserveTokens: 1000 }, cacheWarming: "off", ...options.settings });
	const manager = SessionManager.inMemory(directory);
	options.seed?.(manager, model);
	const hooks = options.hooks ? [options.hooks] : [];
	const services = await createAgentSessionServices({
		cwd: directory, agentDir: directory, settingsManager: settings, modelRuntime: runtime, extensionFlagValues: options.flagValues,
		resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Fixture policy",
			extensionFactories: [...(options.firstHooks ? [options.firstHooks] : []), ...(options.fastFactory ? [options.fastFactory] : []), ...(options.hooksFirst ? hooks : []), extension, ...(!options.hooksFirst ? hooks : [])],
		},
	});
	const { session } = await createAgentSessionFromServices({ services, model, thinkingLevel: options.thinking ? "low" : undefined, sessionManager: manager, tools: [] });
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	return { session, manager, requests, errors, runtime, provider, legacyStream, authControl, async close() { session.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

describe("Pi runner + real Responses adapter", () => {
	test.each([false, true])("SDK-scoped generic policy suppresses native requests in either extension order (companion first=%s)", async (hooksFirst) => {
		let genericCompactions = 0;
		const f = await fixture({
			hooksFirst, flagValues: new Map([["compaction-model", "fixture/summary"]]),
			hooks(pi) {
				pi.registerFlag("compaction-model", { description: "Fixture generic model", type: "string" });
				pi.events.on("pi-compactor:resolve-model-policy", (request: any) => {
					request.respond(pi.getFlag("compaction-model") === "fixture/summary");
				});
				pi.on("session_before_compact", (event) => {
					expect(pi.getFlag("compaction-model")).toBe("fixture/summary");
					genericCompactions++;
					return { compaction: { summary: "Selected generic model", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
				});
			},
		});
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const requestsBefore = f.requests.length;
			const result = await f.session.compact();
			expect(result.summary).toBe("Selected generic model");
			expect(genericCompactions).toBe(1);
			expect(f.requests).toHaveLength(requestsBefore);
			expect(result.details).toBeUndefined();
		} finally { await f.close(); }
	});

	test.each([false, true])("bare SDK disposal retires the observer before another session uses the runtime (legacy=%s)", async (legacy) => {
		const f = await fixture({ legacy });
		try {
			await f.session.prompt("Capture the owning session");
			if (legacy) expect(f.runtime.getRegisteredProviderConfig("fixture")!.streamSimple).not.toBe(f.legacyStream);
			else expect(f.runtime.getRegisteredNativeProvider("fixture")).not.toBe(f.provider);
			f.session.dispose();
			if (legacy) expect(f.runtime.getRegisteredProviderConfig("fixture")!.streamSimple).toBe(f.legacyStream);
			else expect(f.runtime.getRegisteredNativeProvider("fixture")).toBe(f.provider);
			let callerPayload = false;
			const result = await f.runtime.streamSimple(f.runtime.getModel("fixture", "fixture")!, normalizeContext({
				messages: [{ role: "user", content: "A different session still works", timestamp: Date.now() }],
			}), {
				sessionId: "another-session",
				onPayload: (payload) => { callerPayload = true; return payload; },
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(callerPayload).toBe(true);
			if (legacy) expect(f.runtime.getRegisteredProviderConfig("fixture")!.streamSimple).toBe(f.legacyStream);
			else expect(f.runtime.getRegisteredNativeProvider("fixture")).toBe(f.provider);
			expect(f.requests.at(-1)!.body.input).not.toContainEqual(checkpoint);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	for (const hooksFirst of [false, true]) test.skipIf(!process.env.PI_COMPACTOR_FIXTURE_PATH)(`pi-compactor SDK flag prevents duplicate native work (companion first=${hooksFirst})`, async () => {
		const f = await fixture({
			hooks: await loadExternalExtension(process.env.PI_COMPACTOR_FIXTURE_PATH!), hooksFirst,
			flagValues: new Map([["compaction-model", "fixture/fixture"]]),
		});
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const requestsBefore = f.requests.length;
			const result = await f.session.compact();
			expect(result.summary).toBe("Portable summary fixture");
			expect(f.requests).toHaveLength(requestsBefore + 1);
			expect(f.requests.some((request) => new URL(request.url).pathname.endsWith("/compact"))).toBe(false);
			expect((result.details as any)?.type).not.toBe("pi-provider-compaction/openai-responses");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});

	test("an explicitly released observer is reinstalled before the next request", async () => {
		const f = await fixture({ legacy: true });
		try {
			await f.session.prompt("A ".repeat(1000));
			const wrapper = f.runtime.getRegisteredProviderConfig("fixture")!.streamSimple!;
			Reflect.get(wrapper, STREAM_OBSERVER).release();
			expect(f.runtime.getRegisteredProviderConfig("fixture")!.streamSimple).toBe(f.legacyStream);
			await f.session.prompt("B ".repeat(100));
			expect(f.runtime.getRegisteredProviderConfig("fixture")!.streamSimple).not.toBe(f.legacyStream);
			const result = await f.session.compact();
			expect((result.details as any)?.version).toBe(3);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});

	test.skipIf(!process.env.PI_FAST_MODE_FIXTURE_PATH)("installed pi-fast-mode composes with native compaction and survives reload", async () => {
		const fastFactory = await loadExternalExtension(process.env.PI_FAST_MODE_FIXTURE_PATH!);
		const agentDir = await mkdtemp(join(tmpdir(), "provider-compaction-fast-config-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		let f: Awaited<ReturnType<typeof fixture>> | undefined;
		try {
			await mkdir(join(agentDir, "extensions"));
			await writeFile(join(agentDir, "extensions", "pi-fast-mode.json"), JSON.stringify({ active: true }));
			process.env.PI_CODING_AGENT_DIR = agentDir;
			f = await fixture({ api: "openai-codex-responses", fastFactory });
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect((result.details as any).version).toBe(3);
			await f.session.prompt("C new");
			expect(f.requests.at(-1)!.body.input).toContainEqual(checkpoint);
			expect(f.requests.at(-1)!.body.service_tier).toBe("priority");
			await f.session.reload();
			await f.session.prompt("D after reload");
			expect(f.requests.at(-1)!.body.service_tier).toBe("priority");
			expect(f.requests.at(-1)!.body.input).not.toContainEqual(checkpoint);
			expect(f.errors).toEqual([]);
		} finally {
			try { await f?.close(); }
			finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				await rm(agentDir, { recursive: true, force: true });
			}
		}
	});
	test("a companion entry appended after compaction does not disable native replay", async () => {
		const f = await fixture({
			hooksFirst: true,
			hooks: (pi) => { pi.on("session_compact", () => { pi.appendEntry("companion-state", { captured: true }); }); },
		});
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect((result.details as any)?.version).toBe(3);
			await f.session.prompt("C after companion state");
			expect(f.requests.at(-1)!.body.input).toContainEqual(checkpoint);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});

	test("an unrelated entry appended during compaction does not cancel it", async () => {
		let compacting = false;
		const f = await fixture({
			hooksFirst: true,
			hooks: (pi) => {
				pi.on("session_before_compact", () => { compacting = true; });
				pi.on("before_provider_request", () => {
					if (!compacting) return;
					compacting = false;
					pi.appendEntry("companion-state", { during: true });
				});
			},
		});
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect((result.details as any)?.version).toBe(3);
			await f.session.prompt("C after concurrent state");
			expect(f.requests.at(-1)!.body.input).toContainEqual(checkpoint);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});

	test("a payload-level model rewrite prevents native replay", async () => {
		let rewrite = false;
		const f = await fixture({
			hooks: (pi) => {
				pi.on("before_provider_request", (event) => rewrite ? { ...(event.payload as object), model: "other-model" } : undefined);
			},
		});
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect((result.details as any)?.version).toBe(3);
			rewrite = true;
			await f.session.prompt("C with rewritten model");
			expect(f.requests.at(-1)!.body.model).toBe("other-model");
			expect(f.requests.at(-1)!.body.input).not.toContainEqual(checkpoint);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});

	for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) test(`${api}: prefix-only acquisition and summary-only replay preserve retained and new messages`, async () => {
		const f = await fixture({ api });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect(f.errors).toEqual([]);
			const native = f.requests.find((request) => new URL(request.url).pathname.endsWith("/compact") || request.body.input?.some((item: any) => item.type === "compaction_trigger"));
			expect(native).toBeDefined();
			expect(JSON.stringify(native!.body.input)).toContain("A A A");
			expect(JSON.stringify(native!.body.input)).not.toContain("B B B");
			expect((result.details as any).version).toBe(3);
			await f.session.prompt("C new");
			const last = f.requests.at(-1)!.body;
			expect(last.input).toContainEqual(checkpoint);
			expect(JSON.stringify(last.input)).toContain("B B B");
			expect(JSON.stringify(last.input)).toContain("C new");
			expect(last.input.filter((item: any) => JSON.stringify(item).includes("B B B"))).toHaveLength(1);
			expect(JSON.stringify(last.input)).not.toContain("<summary>");
		} finally { await f.close(); }
	});
	test("thinking-level changes retain native replay and the next reply's effort", async () => {
		const f = await fixture({ thinking: true });
		try {
			await f.session.prompt("A ".repeat(1000));
			f.session.setThinkingLevel("high");
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect((result.details as any)?.version).toBe(3);
			const native = f.requests.find((request) => new URL(request.url).pathname.endsWith("/compact"))!;
			expect(native.body.input).toContainEqual({ type: "configuration_update", reasoning: { effort: "low" } });
			expect(JSON.stringify(native.body.input)).not.toContain("B B B");
			f.session.setThinkingLevel("medium");
			await f.session.prompt("C new");
			const last = f.requests.at(-1)!.body;
			expect(last.input).toContainEqual(checkpoint);
			expect(last.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "medium" } });
			expect(JSON.stringify(last.input)).toContain("B B B");
			expect(JSON.stringify(last.input)).toContain("C new");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("repeated compaction covers previous native prefix plus newly summarized retained history", async () => {
		const f = await fixture();
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			await f.session.compact();
			await f.session.prompt("C ".repeat(100));
			await f.session.compact();
			const native = f.requests.filter((request) => new URL(request.url).pathname.endsWith("/compact"));
			expect(native).toHaveLength(2);
			expect(native[1]!.body.input).toContainEqual(checkpoint);
			expect(JSON.stringify(native[1]!.body.input)).toContain("B B B");
			expect(JSON.stringify(native[1]!.body.input)).not.toContain("C C C");
			await f.session.prompt("D new");
			const last = JSON.stringify(f.requests.at(-1)!.body.input);
			expect(last).toContain("C C C");
			expect(last).not.toContain("B B B");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("actual context-hook redactions and insertions in the retained suffix survive native replay", async () => {
		let transform = false;
		const f = await fixture({ hooks(pi) {
			pi.on("context", (event) => {
				if (!transform) return;
				return { messages: [...event.messages.map((message) => message.role === "user" && JSON.stringify(message.content).includes("B B B") ? { ...message, content: "REDACTED B" } : message), { role: "user", content: "REQUEST ONLY", timestamp: 1 }] };
			});
			pi.on("before_provider_request", async (event) => { await Promise.resolve(); return { ...(event.payload as any), service_tier: "priority", fixture_unknown: { preserved: true } }; });
		} });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			await f.session.compact();
			transform = true;
			await f.session.prompt("C new");
			const last = f.requests.at(-1)!.body;
			expect(last.input).toContainEqual(checkpoint);
			expect(JSON.stringify(last.input)).toContain("REDACTED B");
			expect(JSON.stringify(last.input)).not.toContain("B B B");
			expect(JSON.stringify(last.input)).toContain("REQUEST ONLY");
			expect(last.fixture_unknown).toEqual({ preserved: true });
			expect(last.service_tier).toBe("priority");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("covered-prefix request-time redaction prevents native transmission", async () => {
		const f = await fixture({ hooks(pi) {
			pi.on("context", (event) => ({ messages: event.messages.map((message) => message.role === "user" && JSON.stringify(message.content).includes("A A A") ? { ...message, content: "REDACTED A" } : message) }));
		} });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect(f.requests.some((request) => new URL(request.url).pathname.endsWith("/compact"))).toBe(false);
			expect((result.details as any).type).toBeUndefined();
			expect(f.manager.getBranch().reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-provider-compaction:diagnostic")).toMatchObject({ data: { status: "portable: projected prefix differs from request context" } });
		} finally { await f.close(); }
	});
	for (const change of ["payload", "policy", "history", "invalidate"] as const) test(`${change} change returns the untouched portable request`, async () => {
		let transform = false;
		let api: ExtensionAPI;
		const f = await fixture({ hooks(pi) {
			api = pi;
			pi.on("before_provider_request", (event) => {
				if (!transform) return;
				const payload = event.payload as any;
				if (change === "payload") return { ...payload, input: [...payload.input, { role: "user", content: "PAYLOAD ONLY" }] };
				if (change === "policy") return { ...payload, instructions: "new privacy policy" };
			});
		} });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			await f.session.compact();
			transform = true;
			if (change === "invalidate") api!.events.emit("pi-provider-compaction:invalidate", {});
			if (change === "history") {
				const entry = f.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
				f.manager.appendContextEdit(entry.id, null);
			}
			await f.session.prompt("C new");
			const last = f.requests.at(-1)!.body;
			expect(last.input.some((item: any) => item.type === "compaction")).toBe(false);
			expect(JSON.stringify(last.input)).toContain("<summary>");
			if (change === "payload") expect(JSON.stringify(last.input)).toContain("PAYLOAD ONLY");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("auth rotation inside a payload hook cannot associate B credentials with A's capture", async () => {
		let rotate: (() => void) | undefined;
		const f = await fixture({ hooks(pi) { pi.on("before_provider_request", () => { rotate?.(); }); } });
		try {
			await f.session.prompt("A ".repeat(1000));
			rotate = () => { f.authControl.key = "new-account"; };
			await f.session.prompt("B ".repeat(100));
			await f.session.compact();
			expect(f.requests.some((request) => new URL(request.url).pathname.endsWith("/compact"))).toBe(false);
		} finally { await f.close(); }
	});
	for (const phase of ["fresh-auth", "native-abort", "late-hook-edit"] as const) test(`${phase}: stale asynchronous work never commits native state`, async () => {
		let editLate = false;
		let mutate: (() => void) | undefined;
		const f = await fixture({ hooks(pi) { pi.on("session_before_compact", () => { if (editLate) mutate?.(); }); } });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const target = f.manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
			mutate = () => { f.manager.appendContextEdit(target.id, null); };
			const before = f.requests.length;
			if (phase === "fresh-auth") f.authControl.beforeResolve = () => {
				if (f.requests.length === before + 1) { f.authControl.beforeResolve = undefined; mutate!(); }
			};
			if (phase === "native-abort") f.authControl.beforeNative = () => { f.session.abortCompaction(); };
			editLate = phase === "late-hook-edit";
			if (editLate) {
				await f.session.compact();
				await f.session.prompt("C new");
				expect(f.requests.at(-1)!.body.input.some((item: any) => item.type === "compaction")).toBe(false);
			} else {
				await expect(f.session.compact()).rejects.toThrow();
				expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			}
		} finally { await f.close(); }
	});
	for (const lifecycle of ["reload", "resume", "fork", "tree"] as const) test(`${lifecycle} invalidates runtime-local native eligibility`, async () => {
		const f = await fixture();
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			await f.session.compact();
			if (lifecycle === "tree") await f.session.extensionRunner.emit({ type: "session_tree", newLeafId: f.manager.getLeafId(), oldLeafId: null, fromExtension: false } as any);
			else {
				await f.session.extensionRunner.emit({ type: "session_shutdown", reason: lifecycle });
				await f.session.extensionRunner.emit({ type: "session_start", reason: lifecycle });
			}
			await f.session.prompt("C new");
			expect(f.requests.at(-1)!.body.input.some((item: any) => item.type === "compaction")).toBe(false);
			expect(JSON.stringify(f.requests.at(-1)!.body.input)).toContain("<summary>");
		} finally { await f.close(); }
	});
	test("companion-extension custom entries neither block native compaction nor leak into requests", async () => {
		const f = await fixture();
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			// pi-tps/herdr style state entries appear after capture and are message-less.
			f.manager.appendCustomEntry("companion:metric", { tokens: 42 });
			const result = await f.session.compact();
			expect((result.details as any).version).toBe(3);
			await f.session.prompt("C new");
			const last = f.requests.at(-1)!.body.input;
			expect(last).toContainEqual(checkpoint);
			expect(JSON.stringify(last)).toContain("C new");
			expect(JSON.stringify(last)).not.toContain("companion:metric");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("custom-message triggerTurn runs capture and replay native state like user runs", async () => {
		const f = await fixture();
		try {
			await f.session.prompt("A ".repeat(1000));
			// Pi 1.2.0 fires before_agent_start for sendMessage({ triggerTurn: true }) runs.
			await f.session.sendCustomMessage({ customType: "test", content: [{ type: "text", text: "CUSTOM RUN" }], display: false }, { triggerTurn: true });
			await f.session.waitForIdle();
			await f.session.prompt("B ".repeat(100));
			const result = await f.session.compact();
			expect(f.errors).toEqual([]);
			expect((result.details as any).version).toBe(3);
			const native = f.requests.find((request) => new URL(request.url).pathname.endsWith("/compact"))!;
			const covered = JSON.stringify(native.body.input);
			expect(covered).toContain("CUSTOM RUN");
			expect(covered).toContain("A A A");
			expect(covered).not.toContain("B B B");
			await f.session.prompt("C new");
			const last = f.requests.at(-1)!.body.input;
			expect(last).toContainEqual(checkpoint);
			const replayed = JSON.stringify(last);
			expect(replayed).toContain("B B B");
			expect(replayed).toContain("C new");
			expect(replayed).not.toContain("CUSTOM RUN");
			expect(replayed).not.toContain("<summary>");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test.each(["rejected", "auth changed"])("native fallback preserves portable work and billed usage: %s", async mode => {
		const f = await fixture({ nativeFailure: mode === "rejected" });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const before = f.requests.length;
			if (mode === "auth changed") f.authControl.beforeNative = () => { f.authControl.key = "new-account"; };
			const result = await f.session.compact();
			expect(result.summary).toContain("Portable summary fixture");
			expect(f.requests.length - before).toBe(2);
			expect((result.details as any).type).toBeUndefined();
			expect(result.usage?.input).toBe(mode === "rejected" ? 20 : 40);
			expect(result.usage?.output).toBe(mode === "rejected" ? 4 : 8);
			const reason = mode === "rejected" ? "native acquisition or validation failed" : "auth changed after native generation";
			expect(f.manager.getBranch().reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-provider-compaction:diagnostic")).toMatchObject({ data: { status: `portable: ${reason}` } });
			const notices: string[] = [];
			const command = f.session.extensionRunner.getCommand("provider-compaction-status")!;
			const context = f.session.extensionRunner.createCommandContext();
			await command.handler("", { ...context, ui: { ...context.ui, notify: (message) => { notices.push(message); } } });
			expect(notices[0]).toContain(`Last attempt: portable: ${reason}`);
			expect(notices[0]).not.toContain("fixture failure");
			await f.session.prompt("C after portable fallback");
			expect(JSON.stringify(f.requests.at(-1)!.body)).not.toContain("pi-provider-compaction:diagnostic");
		} finally { await f.close(); }
	});
});

describe("cached portable summaries", () => {
	test.each([0, 100, 16384])("summary output is independent of reserveTokens=%s", async (reserveTokens) => {
		const f = await fixture({ cached: true, minimumSummaryTokens: 128, settings: { compaction: { enabled: false, keepRecentTokens: 40, reserveTokens } } });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const before = f.requests.length;
			const result = await f.session.compact();
			expect((result.details as any).providerCompaction.path).toBe("cached + native");
			expect(f.requests).toHaveLength(before + 2);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});

	test.each([false, true])("reuses final prompt prefix and keeps native acquisition single (thinking=%s)", async (thinking) => {
		const f = await fixture({ cached: true, cacheTtl: 300, thinking });
		try {
			await f.session.prompt("User constraint: do not deploy. " + "A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const prefix = f.requests.at(-1)!.body;
			const before = f.requests.length;
			const result = await f.session.compact();
			const summary = f.requests.slice(before).find((request) => !request.url.endsWith("/compact"))!;
			expect(summary.body.input.slice(0, prefix.input.length)).toEqual(prefix.input);
			expect(summary.body.tools).toEqual(prefix.tools);
			expect(summary.body.input.some((item: any) => JSON.stringify(item).includes("retained-boundary"))).toBe(true);
			expect((result.details as any).providerCompaction.path).toBe("cached + native");
			expect(f.requests).toHaveLength(before + 2);
			expect(result.usage?.cacheRead).toBe(15);
			await f.session.prompt("Continue unfinished work");
			expect(f.requests.at(-1)!.body.input).toContainEqual(checkpoint);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test.each([
		{ api: "openai-completions", builtin: "deepseek" },
		{ api: "openai-completions", builtin: "xiaomi" },
		{ api: "anthropic-messages" },
	])("portable-only cached compaction uses the real $api adapter ($builtin)", async (options) => {
		const f = await fixture({ ...options, cached: true });
		try {
			await f.session.prompt("User constraint: do not deploy. " + "A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const previous = f.requests.at(-1)!.body;
			const before = f.requests.length;
			const result = await f.session.compact();
			const summary = f.requests.at(-1)!.body;
			expect((result.details as any).providerCompaction.path).toBe("cached");
			expect(f.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-provider-compaction:diagnostic")).toHaveLength(0);
			expect(f.requests).toHaveLength(before + 1);
			expect(summary.messages[0]).toEqual(previous.messages[0]);
			expect(JSON.stringify(summary)).toContain("retained-boundary");
			expect(result.usage?.cacheRead).toBe(15);
			await f.session.prompt("Continue unfinished work");
			expect(f.errors).toEqual([]);
			if (options.builtin) expect(f.runtime.getRegisteredNativeProvider(options.builtin)).toBeUndefined();
		} finally { await f.close(); }
	});
	test("a retained assistant outside the capture is not pulled into the summary", async () => {
		const f = await fixture({ cached: true, builtin: "deepseek", api: "openai-completions", settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } } });
		try {
			await f.session.prompt("Preserve this task history. " + "A ".repeat(1000));
			const result = await f.session.compact();
			expect((result.details as any).providerCompaction.path).toBe("cached");
			expect(JSON.stringify(f.requests.at(-1)!.body)).toContain("first retained message is outside this request");
			const kept = f.manager.getBranch().find((entry) => entry.id === result.firstKeptEntryId);
			expect(kept?.type === "message" && kept.message.role).toBe("assistant");
		} finally { await f.close(); }
	});
	test("cached summaries see late tool output that ordinary serialization clips", async () => {
		const marker = "LATE_CALIBRATION_Z92Q";
		const f = await fixture({ cached: true, builtin: "deepseek", api: "openai-completions", seed(manager, model) {
			manager.appendMessage({ role: "user", content: "Read fixture.txt; preserve its final calibration value. Do not deploy.", timestamp: 1 });
			manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "read-fixture", name: "read", arguments: { path: "fixture.txt" } }], stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 });
			manager.appendMessage({ role: "toolResult", toolCallId: "read-fixture", toolName: "read", content: [{ type: "text", text: "padding ".repeat(1000) + marker }], isError: false, timestamp: 3 });
			manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "File loaded." }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 4 });
		} });
		try {
			await f.session.prompt("Retain this new work verbatim: " + "B ".repeat(100));
			const result = await f.session.compact();
			expect((result.details as any).providerCompaction.path).toBe("cached");
			expect(JSON.stringify(f.requests.at(-1)!.body)).toContain(marker);
			expect((result.details as any).readFiles).toEqual(["fixture.txt"]);
		} finally { await f.close(); }
	});
	test.each([false, true])("incomplete cached output has one accounted fallback, or cancels expiry (expiry=%s)", async (expiry) => {
		let context: any, bus: any;
		const f = await fixture({ cached: true, summaryLength: true, cacheTtl: 300, hooks(pi) { bus = pi.events; pi.on("agent_settled", (_event, ctx) => { context = ctx; }); } });
		try {
			await f.session.prompt("A ".repeat(1000)); await f.session.prompt("B ".repeat(100));
			const before = f.requests.length;
			if (expiry) {
				let state: any, promise: Promise<boolean> | undefined;
				bus.emit("pi-provider-compaction:cache-state", { context, respond: (value: any) => { state = value; } });
				bus.emit("pi-provider-compaction:compact-before-expiry", { context, cycle: state.cycle, isCurrent: () => true, run: async () => { await f.session.compact(); return true; }, respond: (value: Promise<boolean>) => { promise = value; } });
				await expect(promise).rejects.toThrow();
				expect(f.requests).toHaveLength(before + 1);
				expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			} else {
				const result = await f.session.compact();
				expect(f.requests).toHaveLength(before + 3);
				expect((result.details as any).providerCompaction.path).toBe("standard + native");
				expect(result.usage?.cacheRead).toBe(30);
			}
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("a successful one-token warmer refreshes cache evidence and keeps summary coverage", async () => {
		let context: any, sent: any, bus: any;
		const f = await fixture({ cached: true, cacheTtl: 300, builtin: "deepseek", api: "openai-completions", hooks(pi) {
			bus = pi.events;
			pi.on("context_with_system", (event) => { sent = normalizeContext({ messages: convertToLlm(event.messages) }); });
			pi.on("agent_settled", (_event, ctx) => { context = ctx; });
		} });
		const query = () => { let state: any; bus.emit("pi-provider-compaction:cache-state", { context, respond: (value: any) => { state = value; } }); return state; };
		try {
			await f.session.prompt("A ".repeat(1000)); await f.session.prompt("B ".repeat(100));
			const before = query();
			await new Promise((resolve) => setTimeout(resolve, 5));
			await f.runtime.streamSimple(f.session.model!, sent, { sessionId: f.manager.getSessionId(), maxTokens: 1, onPayload: () => undefined }).result();
			const after = query();
			expect(after.available).toBe(true);
			expect(after.cycle).not.toBe(before.cycle);
			expect(after.expiresAt).toBeGreaterThan(before.expiresAt);
			const result = await f.session.compact();
			expect((result.details as any).providerCompaction.path).toBe("cached");
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
	test("unknown cache lifetime remains unknown but manual cached summarization is available", async () => {
		let query: (() => any) | undefined;
		const f = await fixture({ cached: true, hooks(pi) { pi.on("agent_settled", (_event, ctx) => {
			query = () => { let state: any; pi.events.emit("pi-provider-compaction:cache-state", { context: ctx, respond: (value: any) => { state = value; } }); return state; };
		}); } });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			expect(query!()).toMatchObject({ available: true, expiresAt: undefined });
			const result = await f.session.compact();
			expect((result.details as any).providerCompaction.path).toBe("cached + native");
		} finally { await f.close(); }
	});
	test("expiry requests require the current cache cycle", async () => {
		let context: any, bus: any;
		const f = await fixture({ cached: true, cacheTtl: 300, hooks(pi) { bus = pi.events; pi.on("agent_settled", (_event, ctx) => { context = ctx; }); } });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			let state: any; bus.emit("pi-provider-compaction:cache-state", { context, respond: (value: any) => { state = value; } });
			let promise: Promise<boolean> | undefined, invoked = false;
			bus.emit("pi-provider-compaction:compact-before-expiry", { context, cycle: "stale", isCurrent: () => true, run: async () => { invoked = true; return true; }, respond: (value: Promise<boolean>) => { promise = value; } });
			expect(await promise).toBe(false); expect(invoked).toBe(false);
			const before = f.requests.length;
			bus.emit("pi-provider-compaction:compact-before-expiry", { context, cycle: state.cycle, isCurrent: () => true, run: async () => { await f.session.compact(); return true; }, respond: (value: Promise<boolean>) => { promise = value; } });
			expect(await promise).toBe(true);
			expect(f.requests).toHaveLength(before + 2);
			expect(f.errors).toEqual([]);
		} finally { await f.close(); }
	});
});

for (const hooksFirst of [false, true]) test.skipIf(!process.env.PI_COMPACTOR_FIXTURE_PATH)(`real companion schedules one cached expiry transaction (compactor first=${hooksFirst})`, async () => {
	const f = await fixture({
		cached: true, cacheTtl: 2, minimumSummaryTokens: 128, hooksFirst,
		hooks: await loadExternalExtension(process.env.PI_COMPACTOR_FIXTURE_PATH!),
		settings: { compactor: { compactBeforeExpiry: true, minContextTokens: 0, leadTimeSeconds: 1 }, compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 40 } },
	});
	try {
		await f.session.prompt("A ".repeat(1000));
		await f.session.prompt("B ".repeat(100));
		const before = f.requests.length;
		const deadline = Date.now() + 3000;
		while (!f.manager.getBranch().some((entry) => entry.type === "compaction") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		const saved = f.manager.getBranch().find((entry) => entry.type === "compaction")!;
		expect(saved.type === "compaction" && (saved.details as any).providerCompaction.path).toBe("cached + native");
		expect(f.requests).toHaveLength(before + 2);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(f.requests).toHaveLength(before + 2);
		expect(f.manager.getBranch().some((entry) => entry.type === "custom_message")).toBe(false);
		expect(f.errors).toEqual([]);
	} finally { await f.close(); }
});

for (const hooksFirst of [false, true]) test.skipIf(!process.env.PI_COMPACTOR_FIXTURE_PATH)("queued input cancels expiry before paid work, compactor first=" + hooksFirst, async () => {
	let gate = false;
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const released = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture({
		cached: true, cacheTtl: 2, hooksFirst,
		hooks: await loadExternalExtension(process.env.PI_COMPACTOR_FIXTURE_PATH!),
		firstHooks(pi) { pi.on("session_before_compact", async () => { if (gate) { entered(); await released; } }); },
		settings: { compactor: { compactBeforeExpiry: true, minContextTokens: 0, leadTimeSeconds: 1 }, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 40 } },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await f.session.prompt("A ".repeat(1000));
		await f.session.prompt("B ".repeat(100));
		const before = f.requests.length;
		const ended = new Promise<any>((resolve) => { f.session.subscribe((event) => { if (event.type === "compaction_end") resolve(event); }); });
		gate = true;
		await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Expiry did not start")), 3000); })]);
		await f.session.followUp("Queued input must take priority over idle maintenance.");
		release();
		const outcome = await ended;
		expect(outcome.aborted).toBe(true);
		expect(f.requests).toHaveLength(before);
		expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(f.session.getFollowUpMessages()).toHaveLength(1);
		expect(f.errors).toEqual([]);
	} finally { clearTimeout(timer); release(); await f.close(); }
});

for (const hooksFirst of [false, true]) test.skipIf(!process.env.PI_COMPACTOR_FIXTURE_PATH)("queued input during summary prevents native work, compactor first=" + hooksFirst, async () => {
	const f = await fixture({
		cached: true, cacheTtl: 2, hooksFirst,
		hooks: await loadExternalExtension(process.env.PI_COMPACTOR_FIXTURE_PATH!),
		async beforeReply(body) {
			if (JSON.stringify(body).includes("Write a portable context checkpoint")) await f.session.followUp("New user work arrived while the summary was in flight.");
		},
		settings: { compactor: { compactBeforeExpiry: true, minContextTokens: 0, leadTimeSeconds: 1 }, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 40 } },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await f.session.prompt("A ".repeat(1000));
		await f.session.prompt("B ".repeat(100));
		const before = f.requests.length;
		const outcome = await Promise.race([
			new Promise<any>((resolve) => { f.session.subscribe((event) => { if (event.type === "compaction_end") resolve(event); }); }),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Expiry did not finish")), 3000); }),
		]);
		expect(outcome.aborted).toBe(true);
		expect(f.requests).toHaveLength(before + 1);
		const notices: string[] = [];
		const context = f.session.extensionRunner.createCommandContext();
		await f.session.extensionRunner.getCommand("provider-compaction-status")!.handler("", { ...context, ui: { ...context.ui, notify: (message) => { notices.push(message); } } });
		expect(notices[0]).toContain("Outcome: expiry cancelled");
		expect(notices[0]).toContain("cache read 15");
		expect(f.requests.slice(before).some((request) => request.url.endsWith("/compact"))).toBe(false);
		expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(f.session.getFollowUpMessages()).toHaveLength(1);
		expect(f.errors).toEqual([]);
	} finally { clearTimeout(timer); await f.close(); }
});
