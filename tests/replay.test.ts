import { describe, expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { capturePreparedRequest, selectCoveredPrefix, substituteSummary, serializeInput, SNAPSHOT_TTL_MS, requestPolicy } from "../replay";

const model = { provider: "openai", api: "openai-responses", id: "test", baseUrl: "https://example.test/v1", input: ["text", "image"], reasoning: false } as Model<any>;
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const context = normalizeContext({ systemPrompt: "policy", messages: [user("A"), user("B")], tools: [] });
const native = [{ type: "compaction", encrypted_content: "A-only" }];

describe("prefix-only request evidence", () => {
	test("selects A from the actual prepared input, never retained B", () => {
		const payload = { input: serializeInput(model, context), service_tier: "priority" };
		const snapshot = capturePreparedRequest(model, context, context, payload)!;
		const prefix = normalizeContext({ messages: context.messages.slice(0, 2) });
		expect(selectCoveredPrefix(model, snapshot, prefix)).toEqual([payload.input[1]]);
	});
	test("cannot acquire native input from a request-time redacted or unmapped prefix", () => {
		const redacted = normalizeContext({ systemPrompt: "policy", messages: [user("REDACTED"), user("B")] });
		const snapshot = capturePreparedRequest(model, redacted, context, { input: serializeInput(model, redacted) })!;
		expect(selectCoveredPrefix(model, snapshot, normalizeContext({ messages: context.messages.slice(0, 2) }))).toBeUndefined();
		expect(capturePreparedRequest(model, context, context, { input: serializeInput(model, redacted) })).toBeUndefined();
	});
	test("substitutes only the proven summary contribution and preserves every other field", () => {
		const current = normalizeContext({ systemPrompt: "policy", messages: [user("summary"), user("B"), user("C")] });
		const payload = { input: serializeInput(model, current), tools: [{ type: "custom", name: "edit" }], instructions: "request-only", service_tier: "priority" };
		const result = substituteSummary(payload, 1, payload.input[1]!, native)!;
		expect(result.input).toEqual([payload.input[0], ...native, payload.input[2], payload.input[3]]);
		expect(result.tools).toBe(payload.tools);
		expect(result.instructions).toBe("request-only");
		expect(result.input[2]).toBe(payload.input[2]);
		expect(payload.input).toHaveLength(4);
	});
	test("stale, oversized, and stateful snapshots cannot acquire native input", () => {
		const payload = { input: serializeInput(model, context) };
		const snapshot = capturePreparedRequest(model, context, context, payload)!;
		snapshot.createdAt -= SNAPSHOT_TTL_MS + 1;
		expect(selectCoveredPrefix(model, snapshot, normalizeContext({ messages: context.messages.slice(0, 2) }))).toBeUndefined();
		expect(capturePreparedRequest(model, context, context, { ...payload, previous_response_id: "hidden-server-context" })).toBeUndefined();
		expect(capturePreparedRequest(model, context, context, { ...payload, oversized: "x".repeat(8 * 1024 * 1024) })).toBeUndefined();
	});
	test("diagnostics identify rejection without returning request content", () => {
		const reasons: string[] = [];
		const reject = (reason: string) => { reasons.push(reason); };
		const payload = { input: serializeInput(model, context) };
		expect(capturePreparedRequest(model, context, context, { input: [{ role: "user", content: "SECRET" }] }, reject)).toBeUndefined();
		const snapshot = capturePreparedRequest(model, context, context, payload)!;
		snapshot.createdAt -= SNAPSHOT_TTL_MS + 1;
		expect(selectCoveredPrefix(model, snapshot, context, reject)).toBeUndefined();
		expect(reasons).toEqual(["prepared input differs from serializer", "snapshot expired"]);
	});
	test("removed grammar declarations remain part of the policy fingerprint", () => {
		const base = { ...model, compat: { supportsMidConvoSystemMessages: true, supportsOpenAIGrammarTools: true } };
		const policy = (property: string) => {
			const transcript = normalizeContext({ messages: [{ role: "system", content: "policy", timestamp: 1, toolsAdded: [{ name: "old", description: "old", parameters: { type: "object", properties: { [property]: { type: "string" } }, required: [property] } as any, constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } }] }, user("A"), { role: "system", content: "", toolsRemoved: [{ name: "old" }], timestamp: 2 }] });
			const snapshot = capturePreparedRequest(base, transcript, transcript, { input: serializeInput(base, transcript) })!;
			return requestPolicy(base, snapshot);
		};
		expect(policy("input")).not.toEqual(policy("replacement"));
	});
	test("ambiguous summary-like input fails unchanged rather than fuzzy matching", () => {
		const item = { role: "user", content: "identical" };
		const payload = { input: [item, { ...item }] };
		expect(substituteSummary(payload, 0, item, native)).toBeUndefined();
	});
});
