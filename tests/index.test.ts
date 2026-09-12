import { describe, expect, test } from "bun:test";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	NATIVE_COMPACTION_SUMMARY,
	NATIVE_COMPACTION_TYPE,
	NATIVE_COMPACTION_VERSION,
	compactOpenAIResponses,
	findLatestNativeCompaction,
	readNativeCompactionDetails,
	rewriteResponsesPayload,
	supportsNativeCompaction,
	type NativeCompactionDetails,
} from "../index";
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

function details(overrides: Partial<NativeCompactionDetails> = {}): NativeCompactionDetails {
	return {
		type: NATIVE_COMPACTION_TYPE,
		version: NATIVE_COMPACTION_VERSION,
		provider: directModel.provider,
		api: directModel.api,
		model: directModel.id,
		protocol: "responses-compact",
		identity: { endpoint: directModel.baseUrl },
		output: [checkpoint],
		...overrides,
	};
}

function compactionEntry(native = details(), summary = "portable summary"): SessionEntry {
	return {
		type: "compaction",
		id: "compact-1",
		parentId: "message-1",
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: "message-1",
		tokensBefore: 123,
		details: native,
	} as SessionEntry;
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
			context: { systemPrompt: "system", messages: [], tools: [] },
			protocol: "responses-compact",
			input: [{ type: "message", role: "user", content: "native-history" }],
			apiKey: "secret",
			headers: { "api-key": "secret" },
			env: { AZURE_OPENAI_API_VERSION: "2026-08-01" },
			signal: new AbortController().signal,
			fetch: (async (input, init) => {
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
			context: { systemPrompt: "system", messages: [], tools: [] },
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

describe("persistence and replay", () => {
	test("reads legacy v1 details but writes v2 protocol state", () => {
		const legacy = readNativeCompactionDetails({
			type: NATIVE_COMPACTION_TYPE,
			version: 1,
			provider: directModel.provider,
			api: directModel.api,
			model: directModel.id,
			output: [checkpoint],
			usage,
		});
		expect(legacy?.protocol).toBe("responses-compact");
		expect(legacy?.nativeUsage).toEqual(usage);
		expect(legacy?.identity).toBeUndefined();
		expect(NATIVE_COMPACTION_SUMMARY.length).toBeGreaterThan(0);
	});

	test("matches model and route identity and stops at a newer non-native compaction", () => {
		const native = compactionEntry();
		expect(findLatestNativeCompaction([native], directModel, { endpoint: directModel.baseUrl })?.output).toEqual([checkpoint]);
		expect(findLatestNativeCompaction([native], { ...directModel, id: "other" }, { endpoint: directModel.baseUrl })).toBeUndefined();
		expect(findLatestNativeCompaction([native], directModel, { endpoint: "https://proxy.example/v1" })).toBeUndefined();
		const generic = { ...native, id: "compact-2", details: { readFiles: [] }, summary: "new portable summary" } as SessionEntry;
		expect(findLatestNativeCompaction([native, generic], directModel, { endpoint: directModel.baseUrl })).toBeUndefined();
	});

	test("replaces portable summary payload with native state while retaining post-compaction messages", () => {
		const kept = { type: "message", id: "kept", role: "assistant", content: [] } as ResponseItem;
		const native = details({ output: [kept, checkpoint] });
		const after = { type: "message", role: "user", content: "after" } as ResponseItem;
		const payload = { model: directModel.id, input: [kept, after] };
		expect(rewriteResponsesPayload(payload, native, [after])).toEqual({
			model: directModel.id,
			input: [kept, checkpoint, after],
		});
	});
});

describe("legacy direct helper", () => {
	test("keeps request shaping and usage accounting for deterministic fixtures", async () => {
		let url = "";
		let init: RequestInit | undefined;
		const result = await compactOpenAIResponses({
			model: directModel,
			baseUrl: "https://api.openai.com/v1/",
			apiKey: "secret",
			headers: { Authorization: null, "x-test": "yes" },
			input: [{ type: "message", role: "user", content: "hello" }],
			instructions: "system",
			fetchImpl: async (input: RequestInfo | URL, requestInit?: RequestInit) => {
				url = String(input);
				init = requestInit;
				return new Response(JSON.stringify({
					output: [checkpoint],
					usage: {
						input_tokens: 200,
						input_tokens_details: { cached_tokens: 50, cache_write_tokens: 25 },
						output_tokens: 100,
						output_tokens_details: { reasoning_tokens: 64 },
						total_tokens: 300,
					},
				}));
			},
		});
		expect(url).toBe("https://api.openai.com/v1/responses/compact");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: directModel.id,
			input: [{ type: "message", role: "user", content: "hello" }],
			instructions: "system",
		});
		expect(result.nativeUsage?.input).toBe(125);
		expect(result.nativeUsage?.cacheRead).toBe(50);
		expect(result.nativeUsage?.cacheWrite).toBe(25);
		expect(result.nativeUsage?.reasoning).toBe(64);
		expect(result.usage).toEqual(result.nativeUsage);
	});
});
