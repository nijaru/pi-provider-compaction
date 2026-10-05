import { expect, test } from "bun:test";
import { normalizeContext, Type, type Model, type Tool, type ProviderStreams } from "@earendil-works/pi-ai";
import * as direct from "@earendil-works/pi-ai/api/openai-responses";
import * as azure from "@earendil-works/pi-ai/api/azure-openai-responses";
import * as codex from "@earendil-works/pi-ai/api/openai-codex-responses";

// Load the manifest entrypoint, not source or our validator. `check` builds it
// before testing so its bundled converter must agree with the actual Pi host.
const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
const { default: extension } = await import(new URL(`../${manifest.pi.extensions[0]}`, import.meta.url).href);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const grammar: Tool = { name: "edit", description: "Edit", parameters: Type.Object({ input: Type.String() }), constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } };

for (const [api, adapter] of [["openai-responses", direct], ["azure-openai-responses", azure], ["openai-codex-responses", codex]] as const) {
	for (const crossModel of [false, true]) test(`${api}: built artifact captures ${crossModel ? "cross-model ctc_*" : "same-model fc_* promoted to grammar"} history`, async () => {
		const model: Model<any> = { api, provider: api === "openai-responses" ? "openai" : api === "openai-codex-responses" ? "openai-codex" : api, id: "fixture", name: "Fixture", baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: false, contextWindow: 100000, maxTokens: 1000, cost: usage.cost, compat: { supportsOpenAIGrammarTools: true } };
		const id = crossModel ? "call_A|ctc_A" : "call_A|fc_A";
		const context = normalizeContext({ systemPrompt: "policy", tools: [grammar], messages: [
			{ role: "user", content: "Edit A", timestamp: 1 },
			{ role: "assistant", provider: model.provider, api, model: crossModel ? "other" : model.id, content: [{ type: "toolCall", id, name: "edit", arguments: { input: "A" } }], stopReason: "toolUse", usage, timestamp: 2 },
			{ role: "toolResult", toolCallId: id, toolName: "edit", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 3 },
		] });
		const handlers = new Map<string, Function[]>();
		const commands = new Map<string, any>();
		let registration: any = { id: model.provider, ...(adapter as ProviderStreams) };
		let status = "";
		const branch = context.messages.map((message, i) => ({ type: "message", id: String(i), parentId: i ? String(i - 1) : null, timestamp: "2026-10-04", message }));
		const apiKey = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c`;
		const ctx: any = {
			model, cwd: process.cwd(), isProjectTrusted: () => false,
			sessionManager: { getSessionId: () => "fixture", getBranch: () => branch, buildSessionProjection: () => ({ messages: context.messages }) },
			modelRegistry: { getRegisteredNativeProvider: () => registration, getProvider: () => registration, getApiKeyAndHeaders: async () => ({ ok: true, apiKey }) },
			ui: { notify: (value: string) => { status = value; } },
		};
		const pi: any = {
			on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			registerCommand: (name: string, command: any) => commands.set(name, command),
			registerProvider: (provider: any) => { registration = provider; },
			getFlag: () => undefined, events: { on: () => () => {} },
		};
		extension(pi);
		try {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);
			let payload: any;
			const result = await registration.streamSimple(model, context, {
				sessionId: "fixture", apiKey, transport: "sse", maxRetries: 0,
				async onPayload(value: any) { await Promise.resolve(); payload = value; return value; },
				fetch: () => { throw new Error("fixture-stop-before-network"); },
			}).result();
			expect(result.stopReason).toBe("error");
			expect(payload).toBeDefined();
			// Assert the host's changed ID behavior without duplicating conversion.
			expect(payload.input.find((item: any) => item.type === "custom_tool_call")).toMatchObject({ call_id: "call_A", name: "edit", input: "A" });
			expect(payload.input.find((item: any) => item.type === "custom_tool_call").id).toBeUndefined();
			expect(payload.input.some((item: any) => item.type === "custom_tool_call_output")).toBe(true);
			await commands.get("provider-compaction-status").handler("", ctx);
			expect(status).toContain("Observer: installed");
			expect(status).toContain("Capture: eligible prepared request captured");
		} finally {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		}
	});
}
