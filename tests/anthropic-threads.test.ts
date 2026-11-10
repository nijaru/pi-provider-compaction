import { afterEach, expect, test } from "bun:test";
import { createProvider, normalizeContext, type Model, type SimpleStreamOptions, type UserMessage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cachedSummary, captureCachedRequest, finishCachedRequest } from "../cached-summary";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.each(["string", "blocks"] as const)("discarded cached summary preserves Anthropic thread continuation (%s content)", async (format) => {
	const model: Model<"anthropic-messages"> = {
		provider: "fixture", api: "anthropic-messages", id: "fixture", name: "Fixture",
		baseUrl: "https://fixture.invalid/v1", reasoning: false, input: ["text"],
		contextWindow: 100000, maxTokens: 4096, promptCache: { short: 300 },
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsMessageThreads: true },
	};
	const provider = createProvider({ id: model.provider, name: "Fixture", baseUrl: model.baseUrl, models: [model], api: anthropicMessagesApi(), auth: {} });
	const requests: Record<string, any>[] = [];
	let invalidated = false;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith("https://fixture.invalid/")) throw new Error(`Unexpected fixture network: ${url}`);
		requests.push(JSON.parse(String(init?.body)));
		// Input arriving during the summary revokes it, but the provider still
		// receives a successful response and must leave the foreground thread alone.
		if (requests.length === 2) invalidated = true;
		const events = [
			{ type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: model.id, content: [], usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 15 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reply" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;

	const user: UserMessage = { role: "user", content: format === "string" ? "History" : [{ type: "text", text: "History" }], timestamp: 1 };
	const transcript = normalizeContext({ messages: [user] });
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(user);
	const firstKeptEntryId = sessionManager.appendMessage({ role: "user", content: "Retained", timestamp: 2 });
	const options: SimpleStreamOptions = { apiKey: "fixture", cacheRetention: "short", sessionId: sessionManager.getSessionId() };
	let payload: unknown;
	const reply = await provider.streamSimple(model, transcript, { ...options, onPayload(body) { payload = structuredClone(body); } }).result();
	expect(reply.stopReason).toBe("stop");
	const request = captureCachedRequest({
		model, provider, context: transcript, canonical: transcript, options, startedAt: Date.now(),
		sessionId: options.sessionId!, branchLength: 1, branchHash: "", authHash: "",
	}, payload)!;
	finishCachedRequest(request, reply);
	const result = await cachedSummary(request, { sessionManager } as unknown as ExtensionContext,
		{ firstKeptEntryId, tokensBefore: 100 } as Parameters<typeof cachedSummary>[2],
		undefined, new AbortController().signal, () => !invalidated);
	expect(result.reason).toBe("summary request invalidated");
	expect(result.result).toBeUndefined();
	expect(result.usage?.cacheRead).toBe(15);

	const next = await provider.streamSimple(model, normalizeContext({ messages: [user, reply, { role: "user", content: "Follow-up", timestamp: 3 }] }), options).result();
	expect(next.stopReason).toBe("stop");
	expect(requests).toHaveLength(3);
	expect(requests[0]!.thread).toEqual({ type: "create" });
	expect(requests[1]!.thread).toBeUndefined();
	expect(requests[1]!.messages[0]).toEqual(requests[0]!.messages[0]);
	expect(requests[2]!.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
});
