import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import extension, {
	NATIVE_COMPACTION_SUMMARY,
	NATIVE_COMPACTION_TYPE,
	NATIVE_COMPACTION_VERSION,
	compactOpenAIResponses,
	findLatestNativeCompaction,
	type NativeCompactionDetails,
	rewriteResponsesPayload,
	supportsNativeCompaction,
} from "../index";

const model = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5.3-codex",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
} as Model<any>;

const compactionItem: Record<string, unknown> = {
	type: "compaction",
	encrypted_content: "opaque-state",
};

function details(output: Record<string, unknown>[] = [compactionItem]): NativeCompactionDetails {
	return {
		type: NATIVE_COMPACTION_TYPE,
		version: NATIVE_COMPACTION_VERSION,
		provider: model.provider,
		api: model.api,
		model: model.id,
		output,
	};
}

function compactionEntry(nativeDetails = details()): SessionEntry {
	return {
		type: "compaction",
		id: "compact-1",
		parentId: "message-1",
		timestamp: new Date().toISOString(),
		summary: NATIVE_COMPACTION_SUMMARY,
		firstKeptEntryId: "message-1",
		tokensBefore: 123,
		details: nativeDetails,
	} as SessionEntry;
}

test("shapes the standalone compact request and preserves opaque output", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(input);
		requestInit = init;
		return new Response(JSON.stringify({ output: [compactionItem, { type: "message", id: "kept" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

	const result = await compactOpenAIResponses({
		model,
		baseUrl: "https://api.openai.com/v1/",
		apiKey: "secret",
		headers: { Authorization: null, "x-test": "yes" },
		input: [{ type: "message", role: "user", content: "hello" }],
		instructions: "system",
		fetchImpl,
	});

	expect(requestUrl).toBe("https://api.openai.com/v1/responses/compact");
	expect(requestInit?.method).toBe("POST");
	expect(requestInit?.headers).toEqual({
		"content-type": "application/json",
		"x-test": "yes",
		authorization: "Bearer secret",
	});
	expect(JSON.parse(String(requestInit?.body))).toEqual({
		model: model.id,
		input: [{ type: "message", role: "user", content: "hello" }],
		instructions: "system",
	});
	expect(result.output).toEqual([compactionItem, { type: "message", id: "kept" }]);
});

test("rejects a compact response without opaque state", async () => {
	const fetchImpl = (async () => new Response(JSON.stringify({ output: [{ type: "message" }] }))) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	await expect(
		compactOpenAIResponses({
			model,
			baseUrl: "https://api.openai.com/v1",
			input: [],
			fetchImpl,
		}),
	).rejects.toThrow("opaque compaction state");
});

test("restores the latest provider state only for the same model", () => {
	const entry = compactionEntry();
	expect(findLatestNativeCompaction([entry], model)?.output).toEqual([compactionItem]);
	expect(findLatestNativeCompaction([entry], { ...model, id: "other" })).toBeUndefined();
	expect(findLatestNativeCompaction([{ ...entry, details: { type: "other" } } as SessionEntry], model)).toBeUndefined();
});

test("replaces old context and retains items after the native window", () => {
	const nativeMessage = { type: "message", id: "kept", role: "assistant" } as Record<string, unknown>;
	const nativeDetails = details([nativeMessage, compactionItem]);
	const payload = {
		model: model.id,
		input: [
			{ role: "developer", content: "system" },
			nativeMessage,
			{ type: "message", role: "user", content: "new" },
		],
	};

	const rewritten = rewriteResponsesPayload(payload, nativeDetails, [payload.input[2]]);
	expect(rewritten).toEqual({
		...payload,
		input: [nativeMessage, compactionItem, { type: "message", role: "user", content: "new" }],
	});
	expect(rewritten).not.toBe(payload);
});

test("does not anchor on an older duplicate post-compaction message", () => {
	const nativeMessage = { type: "message", id: "kept", role: "assistant" } as Record<string, unknown>;
	const repeatedUser = { type: "message", role: "user", content: "same" } as Record<string, unknown>;
	const intervening = {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "between" }],
	} as Record<string, unknown>;
	const nativeDetails = details([nativeMessage, compactionItem]);
	const payload = {
		model: model.id,
		input: [nativeMessage, repeatedUser, intervening, repeatedUser],
	};

	const rewritten = rewriteResponsesPayload(payload, nativeDetails, [repeatedUser, intervening, repeatedUser]);
	expect(rewritten).toEqual({
		...payload,
		input: [nativeMessage, compactionItem, repeatedUser, intervening, repeatedUser],
	});
});

test("leaves unsupported providers on Pi's normal path", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		getFlag() {
			return undefined;
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	const handler = handlers.get("session_before_compact");
	expect(handler).toBeDefined();
	const unsupported = { ...model, api: "anthropic-messages" } as Model<any>;
	expect(await handler?.({ preparation: {}, branchEntries: [], signal: new AbortController().signal }, { model: unsupported })).toBeUndefined();
	expect(supportsNativeCompaction(unsupported)).toBe(false);
	expect(supportsNativeCompaction({ ...model, provider: "openai-codex", api: "openai-codex-responses" })).toBe(false);
	expect(supportsNativeCompaction({ ...model, provider: "xai" })).toBe(false);
});

test("does not override an explicitly selected generic compaction model", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		getFlag() {
			return "openrouter/deepseek/deepseek-v4-flash";
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	const handler = handlers.get("before_provider_request");
	expect(await handler?.({ payload: { input: [] } }, { model })).toBeUndefined();
});

test("replays native state without dropping the system prompt", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(name, handler);
		},
		getFlag() {
			return undefined;
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	const handler = handlers.get("before_provider_request");
	const kept = { type: "message", id: "kept", role: "assistant" } as Record<string, unknown>;
	const entry = compactionEntry(details([kept, compactionItem]));
	const payload = {
		model: model.id,
		input: [{ role: "developer", content: "old system" }, kept],
	};
	const rewritten = await handler?.(
		{ payload },
		{
			model,
			getSystemPrompt: () => "current system",
			sessionManager: { getBranch: () => [entry] },
		},
	);
	expect(rewritten).toEqual({
		...payload,
		input: [kept, compactionItem],
		instructions: "current system",
	});
});

