import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
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
import { resolveCompactionModelPolicy } from "../policy";

const model = {
	provider: "openai",
	api: "openai-responses",
	id: "gpt-5.3-codex",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25 },
} as unknown as Model<any>;

const compactionItem: Record<string, unknown> = {
	type: "compaction",
	encrypted_content: "opaque-state",
};

let agentDir: string;
let projectDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-pc-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "pi-pc-project-"));
	// Point the shared agent-dir resolution at an empty temp dir so tests do not
	// read the real ~/.pi/agent/compaction-policy.json.
	process.env.PI_COMPACTOR_AGENT_DIR = agentDir;
});

afterAll(() => {
	delete process.env.PI_COMPACTOR_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

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

/** Mock pi with the real loader semantics: getFlag only sees registered flags. */
function createPi(flagValues: Record<string, string | boolean> = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const flags = new Set<string>();
	const values = new Map(Object.entries(flagValues));
	return {
		pi: {
			on(name: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(name, handler);
			},
			registerFlag(name: string) {
				flags.add(name);
			},
			getFlag(name: string) {
				return flags.has(name) ? values.get(name) : undefined;
			},
		} as unknown as ExtensionAPI,
		handlers,
	};
}

function writeAgentPolicy(models: string[]) {
	writeFileSync(join(agentDir, "compaction-policy.json"), JSON.stringify({ models }));
}

function writeProjectPolicy(models: string[]) {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	// A trust-requiring resource (checked by hasTrustRequiringProjectResources)
	// plus isProjectTrusted=true is what pi-compactor requires to read project policy.
	writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
	writeFileSync(join(projectDir, ".pi", "compaction-policy.json"), JSON.stringify({ models }));
}

function policyCtx(trusted = true) {
	return {
		cwd: projectDir,
		isProjectTrusted: () => trusted,
	};
}

// ── Policy precedence ───────────────────────────────────────────────────

describe("generic-compaction-model precedence", () => {
	test("flag takes precedence and registers for shared runtime visibility", () => {
		const { pi, handlers } = createPi({ "compaction-model": "openrouter/deepseek/deepseek-v4-flash" });
		extension(pi);
		expect(handlers.get("session_before_compact")).toBeDefined();
		expect(resolveCompactionModelPolicy(pi, policyCtx())).toEqual({ hasSelectors: true, source: "flag" });
	});

	test("policy files with selectors take precedence when the flag is unset", () => {
		const { pi } = createPi();
		extension(pi);
		try {
			writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
			expect(resolveCompactionModelPolicy(pi, policyCtx())).toEqual({ hasSelectors: true, source: "agent-policy" });

			writeProjectPolicy(["openai/gpt-5.2"]);
			expect(resolveCompactionModelPolicy(pi, policyCtx())).toEqual({ hasSelectors: true, source: "project-policy" });

			// An untrusted project policy must not be read.
			expect(resolveCompactionModelPolicy(pi, policyCtx(false)).source).toBe("agent-policy");
		} finally {
			rmSync(join(projectDir, ".pi", "compaction-policy.json"), { force: true });
		}
	});

	test("an empty models list is an explicit no-generic-model choice", () => {
		const { pi } = createPi();
		extension(pi);
		writeAgentPolicy([]);
		expect(resolveCompactionModelPolicy(pi, policyCtx())).toEqual({ hasSelectors: false });
	});

	test("a malformed or oversized policy falls back to no selectors", () => {
		const { pi } = createPi();
		extension(pi);
		writeFileSync(join(agentDir, "compaction-policy.json"), "{not json");
		expect(resolveCompactionModelPolicy(pi, policyCtx())).toEqual({ hasSelectors: false });
	});

	test("a whitespace or oversized flag falls back like pi-compactor", () => {
		const { pi } = createPi({ "compaction-model": "   " });
		extension(pi);
		expect(resolveCompactionModelPolicy(pi, policyCtx()).hasSelectors).toBe(false);
	});
});

// ── Compaction request shaping ──────────────────────────────────────────

test("shapes the standalone compact request and preserves opaque output", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requestUrl = String(input);
		requestInit = init;
		return new Response(
			JSON.stringify({
				output: [compactionItem, { type: "message", id: "kept" }],
				usage: {
					input_tokens: 200,
					input_tokens_details: { cached_tokens: 50, cache_write_tokens: 25 },
					output_tokens: 100,
					output_tokens_details: { reasoning_tokens: 64 },
					total_tokens: 300,
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
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

test("maps the compact response usage onto Pi's Usage with cost applied", async () => {
	const fetchImpl = (async () =>
		new Response(
			JSON.stringify({
				output: [compactionItem],
				usage: {
					input_tokens: 200,
					input_tokens_details: { cached_tokens: 50, cache_write_tokens: 25 },
					output_tokens: 100,
					output_tokens_details: { reasoning_tokens: 64 },
					total_tokens: 300,
				},
			}),
		)) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

	const result = await compactOpenAIResponses({ model, baseUrl: "https://api.openai.com/v1", input: [], fetchImpl });
	const usage: Usage = result.usage!;
	// OpenAI counts cached and cache-write tokens inside input_tokens.
	expect(usage.input).toBe(125);
	expect(usage.cacheRead).toBe(50);
	expect(usage.cacheWrite).toBe(25);
	expect(usage.reasoning).toBe(64);
	expect(usage.output).toBe(100);
	expect(usage.totalTokens).toBe(300);
	expect(usage.cost.total).toBeCloseTo((125 * 1 + 100 * 2 + 50 * 0.5 + 25 * 0.25) / 1_000_000, 12);
});

test("rejects a compact response without opaque state", async () => {
	const fetchImpl = (async () => new Response(JSON.stringify({ output: [{ type: "message" }] }))) as unknown as (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>;
	await expect(
		compactOpenAIResponses({
			model,
			baseUrl: "https://api.openai.com/v1",
			input: [],
			fetchImpl,
		}),
	).rejects.toThrow("opaque compaction state");
});

test("includes the provider error body when the compact request fails", async () => {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })) as unknown as (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>;
	await expect(
		compactOpenAIResponses({
			model,
			baseUrl: "https://api.openai.com/v1",
			input: [],
			fetchImpl,
		}),
	).rejects.toThrow('failed (429: {"error":{"message":"rate limited"}})');
});

// ── Restore and replay ──────────────────────────────────────────────────

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

// ── Fallback and precedence in the live hooks ───────────────────────────

test("leaves unsupported providers on Pi's normal path", async () => {
	const { pi, handlers } = createPi();
	extension(pi);
	const handler = handlers.get("session_before_compact");
	expect(handler).toBeDefined();
	const unsupported = { ...model, api: "anthropic-messages" } as Model<any>;
	expect(
		await handler?.({ preparation: {}, branchEntries: [], signal: new AbortController().signal }, { model: unsupported }),
	).toBeUndefined();
	expect(supportsNativeCompaction(unsupported)).toBe(false);
	expect(supportsNativeCompaction({ ...model, provider: "openai-codex", api: "openai-codex-responses" })).toBe(false);
	expect(supportsNativeCompaction({ ...model, provider: "xai" })).toBe(false);
});

test("a configured generic model suppresses both the native request and replay", async () => {
	writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
	try {
		const { pi, handlers } = createPi();
		extension(pi);

		// Compaction hook must make no network attempt: no auth resolution at all.
		let authCalls = 0;
		const compactHandler = handlers.get("session_before_compact");
		expect(
			await compactHandler?.(
				{ preparation: {}, branchEntries: [], signal: new AbortController().signal },
				{
					model,
					isProjectTrusted: () => false,
					cwd: projectDir,
					modelRegistry: {
						getApiKeyAndHeaders: async () => {
							authCalls += 1;
							return { ok: true };
						},
					},
				},
			),
		).toBeUndefined();
		expect(authCalls).toBe(0);

		// Replay hook must not resurrect a persisted native window that the
		// generic compaction has already summarized away.
		const kept = { type: "message", id: "kept", role: "assistant" } as Record<string, unknown>;
		const entry = compactionEntry(details([kept, compactionItem]));
		const requestHandler = handlers.get("before_provider_request");
		expect(
			await requestHandler?.(
				{ payload: { model: model.id, input: [{ role: "developer", content: "old system" }, kept] } },
				{
					model,
					cwd: projectDir,
					isProjectTrusted: () => false,
					getSystemPrompt: () => "current system",
					sessionManager: { getBranch: () => [entry] },
				},
			),
		).toBeUndefined();
	} finally {
		writeAgentPolicy([]); // restore the explicit-no-selector agent policy
	}
});

test("replays native state without dropping the system prompt", async () => {
	const { pi, handlers } = createPi();
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
			cwd: projectDir,
			isProjectTrusted: () => false,
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

test("replay with an empty system prompt rewrites the window without instructions", async () => {
	const { pi, handlers } = createPi();
	extension(pi);
	const handler = handlers.get("before_provider_request");
	const kept = { type: "message", id: "kept", role: "assistant" } as Record<string, unknown>;
	const entry = compactionEntry(details([kept, compactionItem]));
	const payload = { model: model.id, input: [kept] };
	const rewritten = await handler?.(
		{ payload },
		{
			model,
			cwd: projectDir,
			isProjectTrusted: () => false,
			getSystemPrompt: () => "",
			sessionManager: { getBranch: () => [entry] },
		},
	);
	expect(rewritten).toEqual({ ...payload, input: [kept, compactionItem] });
	expect((rewritten as Record<string, unknown>).instructions).toBeUndefined();
});

// ── Native compaction request composition ───────────────────────────────

test("chains a second native compaction on the previous opaque window", async () => {
	const { pi, handlers } = createPi();
	extension(pi);
	const handler = handlers.get("session_before_compact");

	const kept = { type: "message", id: "kept", role: "assistant" } as Record<string, unknown>;
	const previousEntry = compactionEntry(details([kept, compactionItem]));
	previousEntry.id = "compact-0";
	const followUp = {
		type: "message",
		id: "m2",
		parentId: "compact-0",
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: "next turn" }] },
	} as SessionEntry;

	let requestBody: any;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				output: [compactionItem],
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const result = await handler?.(
			{
				preparation: { firstKeptEntryId: "m2", tokensBefore: 500 },
				branchEntries: [previousEntry, followUp],
				signal: new AbortController().signal,
			},
			{
				model,
				cwd: projectDir,
				isProjectTrusted: () => false,
				getSystemPrompt: () => "current system",
				sessionManager: {
					getBranch: () => [previousEntry, followUp],
					buildContextEntries: () => [previousEntry, followUp],
				},
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({
						ok: true,
						apiKey: "secret",
						headers: {},
						baseUrl: "https://api.openai.com/v1",
					}),
				},
			},
		);

		// The request chains the previous opaque window plus post-compaction entries,
		// with the system prompt folded into instructions. Retained items come
		// before the compaction item in the previous window's canonical output.
		expect(requestBody.model).toBe(model.id);
		expect(requestBody.input.length).toBe(3);
		expect(requestBody.input[0]).toEqual(kept);
		expect(requestBody.input[1]).toEqual(compactionItem);
		expect(requestBody.instructions).toBe("current system");
		// The result carries usage through to Pi's compaction entry.
		const compaction = (result as { compaction: { usage?: Usage; details: NativeCompactionDetails } }).compaction;
		expect(compaction.usage?.totalTokens).toBe(15);
		expect(compaction.details.output).toEqual([compactionItem]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
