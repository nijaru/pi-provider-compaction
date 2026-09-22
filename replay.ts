import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, getDeclaredTools, normalizeContext, resolveTranscript } from "@earendil-works/pi-ai";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { isObject, type JsonObject, type ResponseItem } from "./protocol";

const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_TTL_MS = 5 * 60_000;

export function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Validator only. No serialized item from this function is transmitted. */
export function serializeInput(model: Model<any>, context: TranscriptContext, declarations = context): ResponseItem[] {
	const compat = model.compat as Record<string, unknown> | undefined;
	const flag = (name: string) => compat?.[name] === true;
	const codex = model.api === "openai-codex-responses";
	const normalized = resolveTranscript(context, flag("supportsMidConvoSystemMessages"));
	const tools = resolveTranscript(declarations, flag("supportsMidConvoSystemMessages"));
	return convertResponsesMessages(model, normalized, model.api === "azure-openai-responses" ? new Set([...TOOL_CALL_PROVIDERS, "azure-openai-responses"]) : TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: !codex,
		grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(tools.messages), flag("supportsOpenAIGrammarTools")),
		supportsMidConvoSystemMessages: flag("supportsMidConvoSystemMessages"),
		supportsAdditionalTools: flag("supportsAdditionalTools"),
		supportsToolSearch: flag("supportsToolSearch"),
		toolOptions: {
			...(codex ? { strict: null } : {}),
			supportsStrictMode: (compat?.supportsStrictMode as boolean | undefined) ?? model.api !== "openai-responses",
			supportsOpenAIGrammarTools: flag("supportsOpenAIGrammarTools"),
		},
	}) as unknown as ResponseItem[];
}

export interface PreparedRequest {
	context: TranscriptContext;
	canonical: TranscriptContext;
	payload: JsonObject & { input: ResponseItem[] };
	/** The portable wire input before our sole summary substitution. */
	portableInput: ResponseItem[];
	replacement?: { index: number; count: number };
	createdAt: number;
}

export function capturePreparedRequest(
	model: Model<any>, context: TranscriptContext, canonical: TranscriptContext, payload: unknown,
): PreparedRequest | undefined {
	if (!isObject(payload) || !Array.isArray(payload.input) || !payload.input.every(isObject)) return;
	// Reject stateful provider requests: coverage must be the complete visible input.
	if (payload.previous_response_id || payload.conversation) return;
	if (Buffer.byteLength(JSON.stringify({ context, payload })) > MAX_SNAPSHOT_BYTES) return;
	const expected = serializeInput(model, context);
	if (!equal(expected, payload.input)) return;
	return { context: structuredClone(context), canonical: structuredClone(canonical), payload: structuredClone(payload) as PreparedRequest["payload"], portableInput: expected, createdAt: Date.now() };
}

function promptCount(input: readonly ResponseItem[]): number {
	let count = 0;
	while (input[count]?.role === "system" || input[count]?.role === "developer") count++;
	return count;
}

/** No open/synthetic tool exchange may cross the coverage boundary. */
function closedTools(context: TranscriptContext): boolean {
	const pending = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") return false;
			for (const block of message.content) if (block.type === "toolCall") {
				if (pending.has(block.id)) return false;
				pending.add(block.id);
			}
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) return false;
		}
	}
	return pending.size === 0;
}

/** Only the head may differ (forced/request-only prompt); conversation mapping is exact. */
function mappedPrefix(snapshot: PreparedRequest, prefix: TranscriptContext): TranscriptContext | undefined {
	if (!equal(snapshot.canonical.messages.slice(0, prefix.messages.length), prefix.messages)) return;
	const head = prefix.messages[0]?.role === "system" ? 1 : 0;
	if (head && snapshot.context.messages[0]?.role !== "system") return;
	if (!equal(snapshot.context.messages.slice(head, prefix.messages.length), prefix.messages.slice(head))) return;
	return normalizeContext({ messages: snapshot.context.messages.slice(0, prefix.messages.length) });
}

export function selectCoveredPrefix(model: Model<any>, snapshot: PreparedRequest, prefix: TranscriptContext): ResponseItem[] | undefined {
	if (Date.now() - snapshot.createdAt > SNAPSHOT_TTL_MS || !closedTools(prefix)) return;
	const mapped = mappedPrefix(snapshot, prefix);
	if (!mapped) return;
	const expected = serializeInput(model, mapped, snapshot.context);
	if (!equal(snapshot.portableInput.slice(0, expected.length), expected)) return;
	const start = promptCount(expected);
	let end = expected.length;
	if (snapshot.replacement) {
		if (snapshot.replacement.index < start || snapshot.replacement.index >= end) return;
		end += snapshot.replacement.count - 1;
	}
	if (end <= start) return;
	// Source is the prepared request, never the validator's reconstruction.
	return structuredClone(snapshot.payload.input.slice(start, end));
}

/** Exact positional replacement, not a subsequence search or a suffix rebuild. */
export function substituteSummary(
	payload: unknown, index: number, summary: ResponseItem, output: ResponseItem[],
): (JsonObject & { input: ResponseItem[] }) | undefined {
	if (!isObject(payload) || !Array.isArray(payload.input) || !payload.input.every(isObject)) return;
	if (!equal(payload.input[index], summary)) return;
	if (payload.input.filter((item) => equal(item, summary)).length !== 1) return;
	return { ...payload, input: [...payload.input.slice(0, index), ...structuredClone(output), ...payload.input.slice(index + 1)] };
}

/** Pin the one portable-summary slot using the canonical prefix, not text search. */
export function summarySlot(model: Model<any>, snapshot: PreparedRequest, summaryPrefix: TranscriptContext): number | undefined {
	const mapped = mappedPrefix(snapshot, summaryPrefix);
	if (!mapped) return;
	const prefix = serializeInput(model, mapped, snapshot.context);
	const index = promptCount(prefix);
	if (prefix.length !== index + 1 || !equal(snapshot.portableInput.slice(0, prefix.length), prefix)) return;
	return index;
}

/** Changes to prompt, tools or model compatibility revoke opaque state. */
export function requestPolicy(model: Model<any>, snapshot: PreparedRequest): unknown {
	return {
		model,
		system: getCurrentSystemPrompt(snapshot.context.messages),
		currentTools: getCurrentTools(snapshot.context.messages),
		declarations: getDeclaredTools(resolveTranscript(snapshot.context, (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages).messages),
		instructions: snapshot.payload.instructions,
		tools: snapshot.payload.tools,
		prompt: snapshot.portableInput.slice(0, promptCount(snapshot.portableInput)),
	};
}
