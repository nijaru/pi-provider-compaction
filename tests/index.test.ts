import { describe, expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { supportsNativeCompaction } from "../index";
import {
	requestProviderCompaction,
	resolveNativeProtocol,
	responsesCompactUrl,
	validateCompactedOutput,
	type ResponseItem,
} from "../protocol";

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

const directModel = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-test",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
} as unknown as Model<any>;

const codexModel = {
	...directModel,
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
} as unknown as Model<any>;

const azureModel = {
	...directModel,
	provider: "azure-openai-responses",
	api: "azure-openai-responses",
	baseUrl: "https://example.openai.azure.com/openai/v1",
} as unknown as Model<any>;

const checkpoint = { type: "compaction", encrypted_content: "opaque-state" } as ResponseItem;

function asyncStream(run: () => Promise<void>, streamUsage: Usage = usage): any {
	return {
		async *[Symbol.asyncIterator]() {
			await run();
			yield {
				type: "done",
				reason: "stop",
				message: { usage: streamUsage, stopReason: "stop", content: [] },
			};
		},
	};
}

describe("automatic route resolution", () => {
	test("uses standalone compact for Responses and Remote V2 for Codex", () => {
		expect(resolveNativeProtocol(directModel)).toBe("responses-compact");
		expect(resolveNativeProtocol(azureModel)).toBe("responses-compact");
		expect(resolveNativeProtocol(codexModel)).toBe("remote-v2");
		expect(supportsNativeCompaction(directModel)).toBe(true);
		expect(supportsNativeCompaction(azureModel)).toBe(true);
		expect(supportsNativeCompaction(codexModel)).toBe(true);
		expect(supportsNativeCompaction({ ...directModel, api: "anthropic-messages" })).toBe(false);
	});

	test("derives /responses/compact without changing Azure query semantics", () => {
		const url = responsesCompactUrl(
			"https://example.openai.azure.com/openai/v1/responses?api-version=2026-08-01",
		);
		expect(url.toString()).toBe(
			"https://example.openai.azure.com/openai/v1/responses/compact?api-version=2026-08-01",
		);
	});
});

describe("standalone Responses bridge", () => {
	test("lets the active provider build auth/url then redirects exactly one request to /compact", async () => {
		let sentPayload: any;
		let compactUrl = "";
		let compactInit: RequestInit | undefined;
		const provider = {
			stream(_model: any, _context: any, options: any) {
				return asyncStream(async () => {
					sentPayload = await options.onPayload({
						model: "azure-deployment",
						input: [{ type: "message", role: "user", content: "provider-built" }],
						stream: true,
						store: false,
						prompt_cache_key: "session",
					});
					const response = await options.fetch(
						"https://example.openai.azure.com/openai/v1/responses?api-version=2026-08-01",
						{
							method: "POST",
							headers: { "api-key": "secret", "content-encoding": "gzip" },
							body: "provider body is replaced by bridge",
						},
					);
					expect(response.ok).toBe(true);
					await response.text();
				});
			},
		} as any;

		const result = await requestProviderCompaction({
			provider,
			model: azureModel,
			context: normalizeContext({ systemPrompt: "system", messages: [], tools: [] }),
			protocol: "responses-compact",
			input: [{ type: "message", role: "user", content: "native-history" }],
			apiKey: "secret",
			headers: { "api-key": "secret" },
			env: { AZURE_OPENAI_API_VERSION: "2026-08-01" },
			signal: new AbortController().signal,
			fetch: (async (input: string | URL, init?: RequestInit) => {
				compactUrl = String(input);
				compactInit = init;
				return new Response(
					JSON.stringify({
						id: "resp-1",
						output: [{ type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] }, checkpoint],
						usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as unknown as typeof fetch,
		});

		expect(sentPayload.input).toEqual([{ type: "message", role: "user", content: "native-history" }]);
		expect(compactUrl).toBe(
			"https://example.openai.azure.com/openai/v1/responses/compact?api-version=2026-08-01",
		);
		const headers = new Headers(compactInit?.headers);
		expect(headers.get("api-key")).toBe("secret");
		expect(headers.get("content-encoding")).toBeNull();
		expect(JSON.parse(String(compactInit?.body))).toEqual({
			model: "azure-deployment",
			input: [{ type: "message", role: "user", content: "native-history" }],
			prompt_cache_key: "session",
		});
		expect(result.output.at(-1)).toEqual(checkpoint);
		expect(result.usage).toEqual(usage);
	});

	test("preserves the full canonical compact output and rejects malformed checkpoints", () => {
		const retained = { type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] };
		expect(validateCompactedOutput({ output: [retained, checkpoint] })).toEqual([retained, checkpoint]);
		expect(() => validateCompactedOutput({ output: [retained] })).toThrow("expected exactly one");
		expect(() => validateCompactedOutput({ output: [checkpoint, checkpoint] })).toThrow("expected exactly one");
	});
});

describe("Codex Remote V2 bridge", () => {
	test("appends compaction_trigger through Pi's Codex transport and captures the emitted checkpoint", async () => {
		let prepared: any;
		const provider = {
			stream(_model: any, _context: any, options: any) {
				return asyncStream(async () => {
					prepared = await options.onPayload({ model: codexModel.id, input: [{ type: "message", role: "user", content: [] }] });
					const response = await options.fetch("https://chatgpt.com/backend-api/codex/responses", {
						method: "POST",
						headers: { authorization: "Bearer oauth", "chatgpt-account-id": "acct" },
						body: JSON.stringify(prepared),
					});
					expect(response.ok).toBe(true);
					await response.text();
				});
			},
		} as any;
		const user = { type: "message", role: "user", content: [{ type: "input_text", text: "recent" }] };
		const result = await requestProviderCompaction({
			provider,
			model: codexModel,
			context: normalizeContext({ systemPrompt: "system", messages: [], tools: [] }),
			protocol: "remote-v2",
			input: [user, { type: "message", role: "assistant", content: [] }],
			apiKey: "oauth",
			signal: new AbortController().signal,
			fetch: (async () => {
				const events = [
					{ type: "response.output_item.done", item: checkpoint },
					{ type: "response.completed", response: { output: [checkpoint] } },
				];
				return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}) as unknown as typeof fetch,
		});

		expect(prepared.input.at(-1)).toEqual({ type: "compaction_trigger" });
		expect(result.output).toEqual([user, checkpoint]);
		expect(result.usage.totalTokens).toBe(15);
	});
});
