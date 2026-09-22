/** Opt-in, authenticated protocol test. Not part of `bun test`; sends three requests. */
import { randomBytes } from "node:crypto";
import { normalizeContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { capturePreparedRequest, selectCoveredPrefix, type PreparedRequest } from "../replay";
import { requestProviderCompaction, resolveNativeProtocol } from "../protocol";

const [providerId, modelId] = process.argv.slice(2);
if (!providerId || !modelId) throw new Error("Usage: bun run tests/live-smoke.ts PROVIDER MODEL (authenticated; three requests)");
const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
const selected = registry.find(providerId, modelId);
if (!selected) throw new Error("Requested model is not in the configured catalog");
const protocol = resolveNativeProtocol(selected);
if (!protocol) throw new Error("Model API has no supported protocol");
const auth = await registry.getApiKeyAndHeaders(selected);
if (!auth.ok) throw new Error("No resolved authentication for requested model");
const provider = registry.getProvider(providerId)!;
const model = auth.baseUrl ? { ...selected, baseUrl: auth.baseUrl } : selected;
const code = randomBytes(6).toString("hex");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const prefix = normalizeContext({ systemPrompt: "Follow the conversation. Preserve exact calibration codes when summarizing.", messages: [
	{ role: "user", content: "Earlier we established the calibration code. Keep the assistant's value available for later.", timestamp: 1 },
	{ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: `The calibration code is ${code}.` }], stopReason: "stop", usage, timestamp: 2 },
] });
const retained = { role: "user" as const, content: "The recent task is a continuation test. Reply READY only.", timestamp: 3 };
const context = normalizeContext({ messages: [...prefix.messages, retained] });
const signal = AbortSignal.timeout(120_000);
const options = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal, transport: "sse" as const, maxRetries: 0, maxTokens: 128 };
let snapshot: PreparedRequest | undefined;
function assertSuccess(message: AssistantMessage) {
	if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(`Provider request failed (${message.stopReason}); backend not validated`);
}
const initial = await provider.streamSimple(model, context, { ...options, onPayload(payload) { snapshot = capturePreparedRequest(model, context, context, payload); } }).result();
assertSuccess(initial);
if (!snapshot) throw new Error("Actual request could not be mapped");
const input = selectCoveredPrefix(model, snapshot, prefix);
if (!input) throw new Error("Actual request did not prove prefix coverage");
const native = await requestProviderCompaction({ provider, model, context, input, preparedPayload: snapshot.payload, protocol, apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal });
const followup = normalizeContext({ messages: [prefix.messages[0]!, { role: "user", content: "Portable summary placeholder", timestamp: 4 }, retained, initial, { role: "user", content: "What was the calibration code? Reply with the exact code only.", timestamp: 5 }] });
const continued = await provider.streamSimple(model, followup, { ...options, onPayload(payload: any) {
	const prompt = model.api === "openai-codex-responses" ? 0 : 1;
	return { ...payload, input: [...payload.input.slice(0, prompt), ...native.output, ...payload.input.slice(prompt + 1)] };
} }).result();
assertSuccess(continued);
const answer = continued.content.filter((part) => part.type === "text").map((part) => part.text).join("");
if (!answer.includes(code)) throw new Error("Continuation accepted native state but failed the exact-code recall check");
console.log(JSON.stringify({ provider: providerId, model: modelId, api: model.api, protocol, prefixItems: input.length, nativeItems: native.output.length, continuation: "accepted; exact code recalled", usage: { initial: initial.usage.totalTokens, native: native.usage.totalTokens, continuation: continued.usage.totalTokens } }));
