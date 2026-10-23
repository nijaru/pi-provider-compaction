import { expect, test } from "bun:test";
import { cacheConfig, requestCacheState, summaryPayload, summaryInstruction, finishCachedRequest, type CachedRequest } from "../cached-summary";

const usage = { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
test("summary payload preserves hooks, tools, routing and prefix; only the append/cap change", () => {
	const input = [{ role: "user", content: [{ type: "input_text", text: "history" }] }];
	const captured = { model: "fixture", input, tools: [{ name: "read" }], service_tier: "priority", prompt_cache_key: "session", max_output_tokens: 8192 };
	const candidate = { ...captured, input: [...input, { role: "user", content: "summarize" }], max_output_tokens: 1000 };
	expect(summaryPayload(captured, candidate)).toEqual(candidate);
	expect(captured.input).toHaveLength(1);
	for (const changed of [{ ...candidate, tools: [] }, { ...candidate, prompt_cache_key: "different" }, { ...candidate, input: [{ role: "user", content: "redacted" }] }]) expect(() => summaryPayload(captured, changed)).toThrow();
});
test("cache-control movement may extend a coalesced Anthropic user block without changing text", () => {
	const captured = { messages: [{ role: "user", content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }] }], system: [{ type: "text", text: "policy" }] };
	const candidate = { ...captured, messages: [{ role: "user", content: [{ type: "text", text: "history" }, { type: "text", text: "summary instruction", cache_control: { type: "ephemeral" } }] }] };
	const result = summaryPayload(captured, candidate);
	expect((result.messages as any)[0].content[0]).toEqual(captured.messages[0]!.content[0]);
	expect((result.messages as any)[0].content[1]).toEqual({ type: "text", text: "summary instruction" });
	expect(() => summaryPayload(captured, { ...candidate, system: [{ type: "text", text: "changed policy" }] })).toThrow();
});
test("expiry is a declared best-effort TTL from request start; unknown remains unknown", () => {
	const request = { model: { id: "m", provider: "p", promptCache: { short: 300 } }, options: { cacheRetention: "short" }, startedAt: Date.now() - 60_000, cycle: "one" } as CachedRequest;
	const message = { model: "m", provider: "p", stopReason: "stop", usage } as any;
	finishCachedRequest(request, message);
	expect(requestCacheState(request)).toMatchObject({ available: true, expiresAt: request.startedAt + 300_000, ttlSource: "model", inputTokens: 100 });
	const unknown = { ...request, model: { ...request.model, promptCache: undefined }, expiresAt: undefined };
	finishCachedRequest(unknown, message);
	expect(requestCacheState(unknown)).toMatchObject({ available: true, expiresAt: undefined, ttlSource: undefined });
	expect(requestCacheState({ ...request, expiresAt: Date.now() - 1 }).available).toBe(false);
	expect(requestCacheState({ ...request, usage: { ...usage, cacheRead: 0 } }).available).toBe(false);
});
test("retained-boundary previews do not expose omitted thinking or tool arguments", () => {
	const request = { context: { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private-omitted-thought" }, { type: "toolCall", name: "read", arguments: { token: "private-argument" } }] }] } } as unknown as CachedRequest;
	const instruction = summaryInstruction(request, 0);
	expect(instruction).toContain("read");
	expect(instruction).not.toContain("private-omitted-thought");
	expect(instruction).not.toContain("private-argument");
});
test("cache preferences accept known retention tiers and reject unknown values", () => {
	expect(cacheConfig({ providerCompaction: { cachedSummaries: false, cacheRetention: "long", outcomeNotifications: true } })).toEqual({ cachedSummaries: false, cacheRetention: "long", outcomeNotifications: true });
	expect(cacheConfig({ providerCompaction: { cacheRetention: "made-up" } }).cacheRetention).toBeUndefined();
});

test("cache-neutral comparison never ignores user data or schema properties named cache_control", () => {
	const captured = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "example", input: { cache_control: "[REDACTED]" } }] }], tools: [{ name: "example", input_schema: { type: "object", properties: { cache_control: { const: "[REDACTED]" } } } }] };
	const instruction = { role: "user", content: [{ type: "text", text: "summarize" }] };
	const leakedInput = { ...captured, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "example", input: { cache_control: "secret-original" } }] }, instruction] };
	expect(() => summaryPayload(captured, leakedInput)).toThrow("summary prefix differs");
	const leakedSchema = { ...captured, messages: [...captured.messages, instruction], tools: [{ name: "example", input_schema: { type: "object", properties: { cache_control: { const: "secret-original" } } } }] };
	expect(() => summaryPayload(captured, leakedSchema)).toThrow("summary request policy differs");
	const valid = summaryPayload(captured, { ...captured, messages: [...captured.messages, instruction] });
	expect((valid.messages as unknown[])[0]).toEqual(captured.messages[0]);
	expect(valid.tools).toEqual(captured.tools);
});
test("file history is carried only from the visible previous summary, with modified paths winning", async () => {
	const { withFileTracking } = await import("../cached-summary");
	const preparation = { fileOps: { read: new Set(["new.txt", "changed.txt"]), edited: new Set(["changed.txt"]), written: new Set() }, previousSummary: "Visible history\n<read-files>\nold.txt\nchanged.txt\n</read-files>\n<modified-files>\nprior-edit.txt\n</modified-files>" } as any;
	const result = withFileTracking({ summary: "Current work", firstKeptEntryId: "kept", tokensBefore: 10 }, preparation);
	expect(result.details).toEqual({ readFiles: ["new.txt", "old.txt"], modifiedFiles: ["changed.txt", "prior-edit.txt"] });
	expect(result.summary).toContain("<read-files>");
	const redacted = withFileTracking({ summary: "Current work", firstKeptEntryId: "kept", tokensBefore: 10 }, { ...preparation, previousSummary: "File history redacted" });
	expect(redacted.summary).not.toContain("old.txt");
});
