import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createProvider, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const checkpoint = { type: "compaction", encrypted_content: "native-prefix" };
const usage = { input_tokens: 20, output_tokens: 4, total_tokens: 24 };
function completion(text: string): Response {
	const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	const response = { id: "resp_fixture", status: "completed", output: [item], usage };
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
async function fixture(options: { hooks?: (pi: ExtensionAPI) => void; nativeFailure?: boolean; api?: string; fastFactory?: (pi: ExtensionAPI) => void } = {}) {
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
		return completion("Portable summary fixture");
	}) as typeof fetch;
	const model: Model<any> = { provider: options.fastFactory ? "openai-codex" : "fixture", api: options.api ?? "openai-responses", id: options.fastFactory ? "gpt-5.5" : "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false });
	const provider = createProvider({ id: model.provider, name: "Fixture", baseUrl: model.baseUrl, models: [model], api: options.api === "azure-openai-responses" ? azureOpenAIResponsesApi() : options.api === "openai-codex-responses" ? openAICodexResponsesApi() : openAIResponsesApi(), auth: { apiKey: { name: "Fixture", login: async () => ({ type: "api_key", key: "fixture" }), resolve: async () => { authControl.beforeResolve?.(); return ({ auth: { apiKey: options.api === "openai-codex-responses" ? `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c` : authControl.key, headers: { "x-deleted": null } }, source: "fixture" }); } } } });
	if (options.fastFactory) runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c`, models: [model] });
	else runtime.registerNativeProvider(provider);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 40, reserveTokens: 1000 }, cacheWarming: { enabled: false } } as any);
	const manager = SessionManager.inMemory(directory);
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Fixture policy", extensionFactories: [...(options.fastFactory ? [options.fastFactory] : []), extension, ...(options.hooks ? [options.hooks] : [])] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime: runtime, sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: [] });
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	return { session, manager, requests, errors, runtime, provider, authControl, async close() { session.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

describe("Pi 0.87 runner + real Responses adapter", () => {
	test.skipIf(!process.env.PI_FAST_MODE_FIXTURE_PATH)("installed pi-fast-mode composes with native compaction and survives reload", async () => {
		// Pi's loader resolves host APIs for packages installed without peer deps.
		// Give the installed source the same host bindings in this Bun fixture.
		const built = await Bun.build({ entrypoints: [process.env.PI_FAST_MODE_FIXTURE_PATH!], target: "bun", packages: "external", plugins: [{ name: "pi-host-bindings", setup(build) { build.onResolve({ filter: /^@earendil-works\// }, ({ path }) => ({ path: import.meta.resolve(path), external: true })); } }] });
		if (!built.success) throw new Error("Could not load installed fast-mode fixture");
		const { default: fastFactory } = await import(`data:text/javascript;base64,${Buffer.from(await built.outputs[0]!.text()).toString("base64")}`);
		const f = await fixture({ api: "openai-codex-responses", fastFactory });
		try {
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
	test("native failure returns the already-produced portable summary without another request", async () => {
		const f = await fixture({ nativeFailure: true });
		try {
			await f.session.prompt("A ".repeat(1000));
			await f.session.prompt("B ".repeat(100));
			const before = f.requests.length;
			const result = await f.session.compact();
			expect(result.summary).toContain("Portable summary fixture");
			expect(f.requests.length - before).toBe(2);
			expect((result.details as any).type).toBeUndefined();
			expect(f.manager.getBranch().reverse().find((entry) => entry.type === "custom" && entry.customType === "pi-provider-compaction:diagnostic")).toMatchObject({ data: { status: "portable: native acquisition or validation failed" } });
			const notices: string[] = [];
			const command = f.session.extensionRunner.getCommand("provider-compaction-status")!;
			const context = f.session.extensionRunner.createCommandContext();
			await command.handler("", { ...context, ui: { ...context.ui, notify: (message) => { notices.push(message); } } });
			expect(notices[0]).toContain("Last attempt: portable: native acquisition or validation failed");
			expect(notices[0]).not.toContain("fixture failure");
			await f.session.prompt("C after portable fallback");
			expect(JSON.stringify(f.requests.at(-1)!.body)).not.toContain("pi-provider-compaction:diagnostic");
		} finally { await f.close(); }
	});
});
