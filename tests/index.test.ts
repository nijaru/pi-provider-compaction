import { describe, expect, test } from "bun:test";
import { getCurrentSystemPrompt, normalizeContext } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import extension from "../index";
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

	test("drops compacted history when nothing follows the compaction", () => {
		const retained = { role: "user", content: [{ type: "input_text", text: "RETAINED_ONE" }] } as ResponseItem;
		const native = details({ output: [retained, checkpoint] });
		const compacted = { role: "user", content: [{ type: "input_text", text: "TOOL_RESULT_ONE" }] } as ResponseItem;
		const prompt = { role: "developer", content: "PROMPT" } as ResponseItem;
		const payload = { model: directModel.id, input: [prompt, retained, compacted] };

		// Nothing is chronologically after the compaction, so only the native output survives.
		expect(rewriteResponsesPayload(payload, native, [])).toEqual({
			model: directModel.id,
			input: [prompt, retained, checkpoint],
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

describe("extension dispatch context", () => {
	// Pi 0.86+ providers read the prompt and tool declarations from the transcript's
	// system messages. The canonical projection already carries them, so folding the
	// base prompt in front would duplicate it.
	test("dispatches the canonical projection without duplicating the system prompt", async () => {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		const pi = {
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(name, handler);
				return () => {};
			},
			getFlag: () => undefined,
			getAllTools: () => [{ name: "read", description: "Read a file", parameters: {} }],
			getActiveTools: () => ["read"],
		};
		(extension as any)(pi);

		const captured: any[] = [];
		const provider = {
			stream(_model: any, context: any) {
				captured.push(context);
				throw new Error("captured dispatch context");
			},
		};
		const systemMessage = { role: "system", content: [{ type: "text", text: "PROJECTION PROMPT" }], timestamp: 1 };
		const ctx = {
			cwd: "/tmp",
			isProjectTrusted: () => false,
			model: directModel,
			thinkingLevel: undefined,
			getSystemPrompt: () => "BASE SYSTEM PROMPT",
			sessionManager: {
				buildSessionProjection: () => ({ entries: [], messages: [systemMessage], thinkingLevel: "high", model: { provider: "openai", modelId: "gpt-test" } }),
				getSessionId: () => "session-1",
			},
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: {}, env: {} }),
				getProvider: () => provider,
			},
		};

		const handler = handlers.get("session_before_compact");
		expect(handler).toBeDefined();
		await handler!({
			preparation: {},
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
		}, ctx);

		expect(captured).toHaveLength(1);
		const messages = captured[0].messages as Array<{ role: string }>;
		expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
		expect(getCurrentSystemPrompt(messages)).toContain("PROJECTION PROMPT");
		expect(getCurrentSystemPrompt(messages)).not.toContain("BASE SYSTEM PROMPT");
	});
});

describe("canonical projection and payload ownership", () => {
	function makePi() {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		return {
			handlers,
			api: {
				on(name: string, handler: (event: any, ctx: any) => unknown) {
					handlers.set(name, handler);
					return () => {};
				},
				getFlag: () => undefined,
				getAllTools: () => [{ name: "read", description: "Read a file", parameters: {} }],
				getActiveTools: () => ["read"],
			},
		};
	}

	function projectionContext(entries: any[], messages: any[], overrides: any = {}) {
		return {
			cwd: "/tmp",
			isProjectTrusted: () => false,
			model: directModel,
			thinkingLevel: undefined,
			getSystemPrompt: () => "BASE_SYSTEM_PROMPT",
			sessionManager: {
				buildSessionProjection: () => ({ entries, messages, thinkingLevel: "high", model: { provider: "openai", modelId: "gpt-test" } }),
				// Raw context keeps the omitted message so the test fails if this is used.
				buildContextEntries: () => entries.map((entry: any) => entry.sourceEntry),
				getBranch: () => entries.map((entry: any) => entry.sourceEntry),
				getSessionId: () => "session-1",
			},
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: {}, env: {} }),
				getProvider: () => overrides.provider,
			},
		};
	}

	test("native request input applies context_edit omissions instead of raw entries", async () => {
		const keptMessage = { role: "user", content: [{ type: "text", text: "KEPT_CONTENT" }], timestamp: 1 };
		const omittedMessage = { role: "assistant", content: [{ type: "text", text: "OMITTED_SHOULD_NOT_BE_SENT" }], timestamp: 2 };
		const keptEntry = { type: "message", id: "m1", parentId: null, timestamp: "t1", message: keptMessage } as SessionEntry;
		const omittedEntry = { type: "message", id: "m2", parentId: "m1", timestamp: "t2", message: omittedMessage } as SessionEntry;
		const editEntry = { type: "context_edit", id: "e1", parentId: "m2", timestamp: "t3", targetId: "m2", replacement: null } as SessionEntry;

		let sentPayload: any;
		const provider = {
			stream(_model: any, _context: any, options: any) {
				return {
					[Symbol.asyncIterator]() {
						return {
							async next() {
								sentPayload = await options.onPayload({ model: "gpt-test", input: [{ type: "message", role: "user", content: "provider-built" }] });
								throw new Error("stop after capture");
							},
						};
					},
				};
			},
		} as any;

		const { handlers, api } = makePi();
		(extension as any)(api);
		const ctx = projectionContext(
			[
				{ sourceEntry: keptEntry, messages: [keptMessage] },
				{ sourceEntry: omittedEntry, messages: [] },
				{ sourceEntry: editEntry, messages: [] },
			],
			[keptMessage],
			{ provider },
		);

		await handlers.get("session_before_compact")!(
			{ preparation: {}, branchEntries: [keptEntry, omittedEntry, editEntry], customInstructions: undefined, signal: new AbortController().signal },
			ctx,
		);

		const serialized = JSON.stringify(sentPayload.input);
		expect(serialized).toContain("KEPT_CONTENT");
		expect(serialized).not.toContain("OMITTED_SHOULD_NOT_BE_SENT");
	});

	test("replay does not overwrite a payload's serialized instructions", async () => {
		const keptMessage = { role: "user", content: [{ type: "text", text: "KEPT_CONTENT" }], timestamp: 1 };
		const keptEntry = { type: "message", id: "m1", parentId: "c1", timestamp: "t2", message: keptMessage } as SessionEntry;
		const native = compactionEntry(details({ output: [checkpoint, { type: "message", role: "assistant", content: [] }] }));

		// `before_provider_request` rewrites the payload and never dispatches a stream.
		const provider = {} as any;
		const { handlers, api } = makePi();
		(extension as any)(api);
		const ctx = {
			...projectionContext([{ sourceEntry: keptEntry, messages: [keptMessage] }], [keptMessage], { provider }),
			model: directModel,
			sessionManager: {
				...projectionContext([], [], { provider }).sessionManager,
				getBranch: () => [native, keptEntry],
				buildSessionProjection: () => ({ entries: [{ sourceEntry: keptEntry, messages: [keptMessage] }], messages: [keptMessage], thinkingLevel: "high", model: { provider: "openai", modelId: "gpt-test" } }),
			},
		};

		const payload = { model: "gpt-test", instructions: "PER_REQUEST_OVERRIDE", input: [{ type: "message", role: "user", content: "kept" }] };
		const result: any = await handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx);
		expect(result.instructions).toBe("PER_REQUEST_OVERRIDE");
	});

	test("replay preserves the serialized prompt and never synthesizes instructions", async () => {
		const keptMessage = { role: "user", content: [{ type: "text", text: "KEPT_CONTENT" }], timestamp: 1 };
		const keptEntry = { type: "message", id: "m1", parentId: "c1", timestamp: "t2", message: keptMessage } as SessionEntry;
		const native = compactionEntry(details({ output: [checkpoint] }));

		// `before_provider_request` rewrites the payload and never dispatches a stream.
		const provider = {} as any;
		const { handlers, api } = makePi();
		(extension as any)(api);
		const base = projectionContext([{ sourceEntry: keptEntry, messages: [keptMessage] }], [keptMessage], { provider });
		const ctx = {
			...base,
			sessionManager: {
				...base.sessionManager,
				getBranch: () => [native, keptEntry],
				buildSessionProjection: () => ({ entries: [{ sourceEntry: keptEntry, messages: [keptMessage] }], messages: [keptMessage], thinkingLevel: "high", model: { provider: "openai", modelId: "gpt-test" } }),
			},
		};

		// The Responses API carries the prompt in `input`; a context_with_system
		// transformation must survive, and ctx.getSystemPrompt() must not be injected.
		const payload = { model: "gpt-test", input: [{ role: "developer", content: "TRANSFORMED_PROMPT" }, { type: "message", role: "user", content: "kept" }] };
		const result: any = await handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx);
		expect(result.instructions).toBeUndefined();
		expect(JSON.stringify(result.input[0])).toContain("TRANSFORMED_PROMPT");
	});

	test("replay does not duplicate retained pre-compaction messages", async () => {
		const retainedMessage = { role: "user", content: [{ type: "text", text: "RETAINED_ONE" }], timestamp: 1 };
		const newMessage = { role: "user", content: [{ type: "text", text: "NEW_ONE" }], timestamp: 3 };
		const retainedEntry = { type: "message", id: "m1", parentId: null, timestamp: "t1", message: retainedMessage } as SessionEntry;
		const native = compactionEntry(details({ output: [retainedMessage, checkpoint] }));
		const newEntry = { type: "message", id: "m3", parentId: "c1", timestamp: "t3", message: newMessage } as SessionEntry;

		const provider = {} as any;
		const { handlers, api } = makePi();
		(extension as any)(api);
		const base = projectionContext([], [], { provider });
		const ctx = {
			...base,
			sessionManager: {
				...base.sessionManager,
				// Raw order: the retained entry came before the compaction.
				getBranch: () => [retainedEntry, native, newEntry],
				// Projection order: newest compaction, then retained entries, then new.
				buildSessionProjection: () => ({
					entries: [
						{ sourceEntry: native, messages: [] },
						{ sourceEntry: retainedEntry, messages: [retainedMessage] },
						{ sourceEntry: newEntry, messages: [newMessage] },
					],
					messages: [retainedMessage, newMessage],
					thinkingLevel: "high",
					model: { provider: "openai", modelId: "gpt-test" },
				}),
			},
		};

		const payload = {
			model: "gpt-test",
			input: [
				{ role: "developer", content: "PROMPT" },
				{ role: "user", content: [{ type: "input_text", text: "RETAINED_ONE" }] },
				{ role: "user", content: [{ type: "input_text", text: "NEW_ONE" }] },
			],
		};
		const result: any = await handlers.get("before_provider_request")!({ type: "before_provider_request", payload }, ctx);

		const serialized = JSON.stringify(result.input);
		// The native output already carries the retained message; post items must not repeat it.
		expect(serialized.split("RETAINED_ONE").length - 1).toBe(1);
		expect(serialized).toContain("NEW_ONE");
		expect(JSON.stringify(result.input[0])).toContain("PROMPT");
	});
});

describe("portable summarization headers", () => {
	test("keeps null header deletions for the summary request", async () => {
		let portableOptions: any;
		const provider = {
			stream(_model: any, _context: any, options: any) {
				return asyncStream(async () => {
					const prepared = await options.onPayload({ model: "gpt-test", input: [] });
					const response = await options.fetch("https://api.openai.com/v1/responses", {
						method: "POST",
						headers: {},
						body: JSON.stringify(prepared),
					});
					await response.text();
				});
			},
			// The portable summary call reaches the provider through `compact`.
			streamSimple(_model: any, _context: any, options: any) {
				portableOptions = options;
				return {
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "summary" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-test",
						usage,
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				};
			},
		} as any;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({
			id: "resp-1",
			output: [{ type: "message", role: "user", content: [] }, checkpoint],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		}), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

		try {
			const handlers = new Map<string, (event: any, ctx: any) => unknown>();
			const api = {
				on(name: string, handler: (event: any, ctx: any) => unknown) {
					handlers.set(name, handler);
					return () => {};
				},
				getFlag: () => undefined,
				getAllTools: () => [],
				getActiveTools: () => [],
			};
			(extension as any)(api);

			const ctx = {
				cwd: "/tmp",
				isProjectTrusted: () => false,
				model: directModel,
				thinkingLevel: undefined,
				getSystemPrompt: () => "SYSTEM",
				sessionManager: {
					buildSessionProjection: () => ({ entries: [], messages: [], thinkingLevel: "high", model: { provider: "openai", modelId: "gpt-test" } }),
					getBranch: () => [],
					getSessionId: () => "session-1",
				},
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret", headers: { "x-test": "value", "x-delete": null }, env: {} }),
					getProvider: () => provider,
				},
			};

			await handlers.get("session_before_compact")!({
				preparation: {
					firstKeptEntryId: "keep",
					messagesToSummarize: [{ role: "user", content: "old", timestamp: Date.now() }],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 100,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
				},
				branchEntries: [],
				customInstructions: "preserve",
				signal: new AbortController().signal,
			}, ctx);

			// `null` deletes a provider default header; stripping it would restore it.
			expect(portableOptions?.headers).toEqual({ "x-test": "value", "x-delete": null });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
