import { expect, test } from "bun:test";
import { normalizeContext, Type, type Model, type Tool, type ProviderStreams } from "@earendil-works/pi-ai";
import * as direct from "@earendil-works/pi-ai/api/openai-responses";
import * as azure from "@earendil-works/pi-ai/api/azure-openai-responses";
import * as codex from "@earendil-works/pi-ai/api/openai-codex-responses";
import { capturePreparedRequest, selectCoveredPrefix, serializeInput } from "../replay";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const grammar: Tool = { name: "edit", description: "Edit", parameters: Type.Object({ input: Type.String() }), constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } } };
const strict: Tool = { name: "strict", description: "Strict", parameters: Type.Object({ text: Type.String() }), constrainedSampling: { type: "json_schema", strict: "prefer" } };
for (const [api, adapter] of [["openai-responses", direct], ["azure-openai-responses", azure], ["openai-codex-responses", codex]] as const) {
	for (const mid of [false, true]) test(`${api}: real serializer parity for grammar/strict/IDs/images/tool changes (mid=${mid})`, async () => {
		const model = { api, provider: api === "openai-responses" ? "openai" : api === "openai-codex-responses" ? "openai-codex" : api, id: "fixture", baseUrl: "https://fixture.invalid/v1", name: "Fixture", input: ["text", "image"], reasoning: true, contextWindow: 100000, maxTokens: 4096, cost: usage.cost, compat: { supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: mid, supportsAdditionalTools: mid } } as Model<any>;
		const context = normalizeContext({ messages: [
			{ role: "system", content: "forced policy", toolsAdded: [grammar, strict], timestamp: 1 },
			{ role: "user", content: "A", timestamp: 2 },
			{ role: "assistant", api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "call id|foreign-item", name: "edit", arguments: { input: "replace text" } }], usage, stopReason: "toolUse", timestamp: 3 },
			{ role: "toolResult", toolCallId: "call id|foreign-item", toolName: "edit", content: [{ type: "text", text: "done" }, { type: "image", mimeType: "image/png", data: "AA==" }], isError: false, timestamp: 4 },
			{ role: "system", content: "mid-conversation policy", toolsAdded: [{ ...strict, name: "new_tool" }], timestamp: 5 },
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AA==" }, { type: "text", text: "B" }], timestamp: 6 },
		] });
		let payload: any;
		const key = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.c`;
		const result = await (adapter as ProviderStreams).streamSimple(model, context, { apiKey: key, transport: "sse", maxRetries: 0, onPayload(value) { payload = value; throw new Error("fixture-stop-before-network"); }, fetch: (() => { throw new Error("Network must not be called"); }) as any }).result();
		expect(result.stopReason).toBe("error");
		expect(payload).toBeDefined();
		expect(serializeInput(model, context)).toEqual(payload.input);
		expect(payload.input.some((item: any) => item.type === "custom_tool_call")).toBe(true);
		expect(payload.input.some((item: any) => item.type === "custom_tool_call_output")).toBe(true);
		expect(capturePreparedRequest(model, context, context, payload)).toBeDefined();
		if (api === "openai-codex-responses") expect(payload.instructions).toContain("forced policy");
		else expect(payload.input[0].content).toContain("forced policy");
		const snapshot = capturePreparedRequest(model, context, context, payload)!;
		const split = normalizeContext({ messages: context.messages.slice(0, 3) });
		expect(selectCoveredPrefix(model, snapshot, split)).toBeUndefined();
	});
}

test("missing tool result repairs cannot prove a closed coverage boundary", () => {
	const model = { api: "openai-responses", provider: "openai", id: "fixture", baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: false } as Model<any>;
	const context = normalizeContext({ messages: [{ role: "user", content: "A", timestamp: 1 }, { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "call", name: "edit", arguments: {} }], usage, stopReason: "toolUse", timestamp: 2 }, { role: "user", content: "B", timestamp: 3 }] });
	const snapshot = capturePreparedRequest(model, context, context, { input: serializeInput(model, context) })!;
	expect(selectCoveredPrefix(model, snapshot, normalizeContext({ messages: context.messages.slice(0, 2) }))).toBeUndefined();
});
