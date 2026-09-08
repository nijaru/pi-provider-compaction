import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { calculateCost } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { resolveCompactionModelPolicy } from "./policy";

export const NATIVE_COMPACTION_TYPE = "pi-provider-compaction/openai-responses";
export const NATIVE_COMPACTION_VERSION = 1;
export const NATIVE_COMPACTION_SUMMARY =
	"This context was compacted using the provider's native OpenAI Responses state.";

const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

type ResponseItem = Record<string, unknown>;
type JsonObject = Record<string, unknown>;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NativeCompactionDetails {
	type: typeof NATIVE_COMPACTION_TYPE;
	version: typeof NATIVE_COMPACTION_VERSION;
	provider: string;
	api: string;
	model: string;
	output: ResponseItem[];
	/** Provider token accounting for the compaction pass, when reported. */
	usage?: Usage;
}

interface NativeCompactionState extends NativeCompactionDetails {
	entryId: string;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsNativeCompaction(model: Model<any> | undefined): model is Model<any> {
	return model?.provider === "openai" && model?.api === "openai-responses";
}

function isCompactionItem(value: unknown): value is ResponseItem {
	return (
		isObject(value) &&
		value.type === "compaction" &&
		typeof value.encrypted_content === "string"
	);
}

export function readNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isObject(value)) return undefined;
	if (value.type !== NATIVE_COMPACTION_TYPE || value.version !== NATIVE_COMPACTION_VERSION) return undefined;
	if (typeof value.provider !== "string" || typeof value.api !== "string" || typeof value.model !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.output) || !value.output.every(isObject) || !value.output.some(isCompactionItem)) {
		return undefined;
	}
	return {
		type: NATIVE_COMPACTION_TYPE,
		version: NATIVE_COMPACTION_VERSION,
		provider: value.provider,
		api: value.api,
		model: value.model,
		output: value.output,
	};
}

export function findLatestNativeCompaction(
	entries: readonly SessionEntry[],
	model: Model<any> | undefined,
): NativeCompactionState | undefined {
	if (!supportsNativeCompaction(model)) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const details = readNativeCompactionDetails(entry.details);
		if (!details) return undefined;
		if (details.provider !== model.provider || details.api !== model.api || details.model !== model.id) {
			return undefined;
		}
		return { ...details, entryId: entry.id };
	}
	return undefined;
}

function responseItemsFromMessages(model: Model<any>, messages: AgentMessage[]): ResponseItem[] {
	const llmMessages = convertToLlm(messages);
	const input = convertResponsesMessages(
		model,
		// tools: [] is intentional: tool definitions are not needed to reserialize
		// recorded tool calls, and omitting them drops namespaces on cross-model
		// history instead of risking provider pairing-validation failures.
		// includeSystemPrompt: false because the system prompt travels in the
		// standalone compact request's `instructions` field instead.
		{ messages: llmMessages, tools: [] },
		TOOL_CALL_PROVIDERS,
		{ includeSystemPrompt: false },
	);
	return input.filter(isObject) as unknown as ResponseItem[];
}

function responseItemsFromEntries(model: Model<any>, entries: readonly SessionEntry[]): ResponseItem[] {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	return responseItemsFromMessages(model, messages);
}

function nativeRequestInput(
	model: Model<any>,
	branchEntries: readonly SessionEntry[],
	activeEntries: readonly SessionEntry[],
	previous: NativeCompactionState | undefined,
): ResponseItem[] {
	if (previous) {
		const previousIndex = branchEntries.findIndex((entry) => entry.id === previous.entryId);
		if (previousIndex >= 0) {
			return [...previous.output, ...responseItemsFromEntries(model, branchEntries.slice(previousIndex + 1))];
		}
	}
	return responseItemsFromEntries(model, activeEntries);
}

function authHeaders(apiKey: string | undefined, headers: Record<string, string | null> | undefined): Record<string, string> {
	const result: Record<string, string> = { "content-type": "application/json" };
	let hasAuthorization = false;
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value === null) continue;
		result[name] = value;
		if (name.toLowerCase() === "authorization" && value.trim() !== "") hasAuthorization = true;
	}
	if (!hasAuthorization && apiKey) result.authorization = `Bearer ${apiKey}`;
	return result;
}

export interface CompactRequestOptions {
	model: Model<any>;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string | null>;
	input: ResponseItem[];
	instructions?: string;
	signal?: AbortSignal;
	fetchImpl?: FetchImplementation;
}

export async function compactOpenAIResponses(options: CompactRequestOptions): Promise<NativeCompactionDetails> {
	const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/responses/compact`;
	const body: JsonObject = {
		model: options.model.id,
		input: options.input,
	};
	if (options.instructions) body.instructions = options.instructions;

	const response = await (options.fetchImpl ?? fetch)(endpoint, {
		method: "POST",
		headers: authHeaders(options.apiKey, options.headers),
		body: JSON.stringify(body),
		signal: options.signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		const suffix = detail ? `: ${detail.slice(0, 400)}` : "";
		throw new Error(`OpenAI Responses compact request failed (${response.status}${suffix})`);
	}

	const result: unknown = await response.json();
	if (!isObject(result) || !Array.isArray(result.output)) {
		throw new Error("OpenAI Responses compact response did not contain output items");
	}
	const output = result.output.filter((item): item is ResponseItem => isObject(item));
	if (output.length !== result.output.length || !output.some(isCompactionItem)) {
		throw new Error("OpenAI Responses compact response did not contain opaque compaction state");
	}
	return {
		type: NATIVE_COMPACTION_TYPE,
		version: NATIVE_COMPACTION_VERSION,
		provider: options.model.provider,
		api: options.model.api,
		model: options.model.id,
		output,
		usage: compactUsage(options.model, result),
	};
}

/** Map the compact response's ResponseUsage onto Pi's Usage, with cost applied. */
function compactUsage(model: Model<any>, result: JsonObject): Usage | undefined {
	const usage = result.usage;
	if (!isObject(usage)) return undefined;
	const cached = nestedNumber(usage.input_tokens_details, "cached_tokens");
	const cacheWrite = nestedNumber(usage.input_tokens_details, "cache_write_tokens");
	const mapped: Usage = {
		// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
		input: Math.max(0, readNumber(usage.input_tokens) - cached - cacheWrite),
		output: readNumber(usage.output_tokens),
		cacheRead: cached,
		cacheWrite,
		reasoning: nestedNumber(usage.output_tokens_details, "reasoning_tokens"),
		totalTokens: readNumber(usage.total_tokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	try {
		calculateCost(model, mapped);
	} catch {
		// Cost lookup can fail for models without cost metadata; the token counts remain useful.
	}
	return mapped;
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedNumber(value: unknown, key: string): number {
	return isObject(value) ? readNumber(value[key]) : 0;
}

/** Key-order-insensitive serialization for boundary matching: providers may re-serialize retained items with reordered keys. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isObject(value)) {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function itemMatches(left: ResponseItem, right: ResponseItem): boolean {
	const leftId = typeof left.id === "string" ? left.id : undefined;
	const rightId = typeof right.id === "string" ? right.id : undefined;
	if (leftId && rightId) return leftId === rightId;
	const leftCallId = typeof left.call_id === "string" ? left.call_id : undefined;
	const rightCallId = typeof right.call_id === "string" ? right.call_id : undefined;
	if (leftCallId && rightCallId) return leftCallId === rightCallId && left.type === right.type;
	if (left.type === "message" && right.type === "message") {
		return left.role === right.role && stableStringify(left.content) === stableStringify(right.content);
	}
	return stableStringify(left) === stableStringify(right);
}

function findLastSubsequence(items: ResponseItem[], sequence: ResponseItem[]): number {
	if (sequence.length === 0) return -1;
	for (let start = items.length - sequence.length; start >= 0; start--) {
		let matches = true;
		for (let offset = 0; offset < sequence.length; offset++) {
			if (!itemMatches(items[start + offset], sequence[offset])) {
				matches = false;
				break;
			}
		}
		if (matches) return start;
	}
	return -1;
}

/** Replace the old Pi context with native output while retaining items added after compaction. */
export function rewriteResponsesPayload(
	payload: unknown,
	details: NativeCompactionDetails,
	postCompactionItems: ResponseItem[],
): unknown {
	if (!isObject(payload) || !Array.isArray(payload.input)) return payload;
	const currentInput = payload.input.filter((item): item is ResponseItem => isObject(item));
	if (currentInput.length !== payload.input.length) return payload;

	// Prefer the post-compaction boundary. Matching an individual retained item
	// first can select an older duplicate user message and drop intervening state.
	const postStart = findLastSubsequence(currentInput, postCompactionItems);
	if (postStart >= 0) {
		return { ...payload, input: [...details.output, ...currentInput.slice(postStart)] };
	}

	const retainedOutput = details.output.filter((item) => item.type !== "compaction");
	const retainedStart = findLastSubsequence(currentInput, retainedOutput);
	if (retainedStart >= 0) {
		return {
			...payload,
			input: [...details.output, ...currentInput.slice(retainedStart + retainedOutput.length)],
		};
	}
	return { ...payload, input: [...details.output, ...postCompactionItems] };
}

/** True when pi-compactor's generic compaction model takes precedence (flag or policy file). */
function genericCompactionSelected(
	pi: Pick<ExtensionAPI, "getFlag">,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">,
): boolean {
	return resolveCompactionModelPolicy(pi, ctx).hasSelectors;
}

export default function (pi: ExtensionAPI): void {
	// Do not register COMPACTION_MODEL_FLAG here: Pi rejects duplicate flag
	// registrations, and pi-compactor already owns `--compaction-model`.
	// Precedence reads the shared CLI value from process.argv (see policy.ts)
	// so it works whether or not pi-compactor is installed.

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!supportsNativeCompaction(model)) return;
		const branch = ctx.sessionManager.getBranch();
		const latest = findLatestNativeCompaction(branch, model);
		// Resolve the policy only when a native window exists to replay: the disk
		// reads are wasted work on every ordinary request otherwise.
		if (!latest || genericCompactionSelected(pi, ctx)) return;
		const index = branch.findIndex((entry) => entry.id === latest.entryId);
		const postItems = index >= 0 ? responseItemsFromEntries(model, branch.slice(index + 1)) : [];
		const rewritten = rewriteResponsesPayload(event.payload, latest, postItems);
		if (rewritten === event.payload || !isObject(rewritten)) return rewritten;
		const systemPrompt = ctx.getSystemPrompt();
		if (!systemPrompt) return rewritten;
		// openai-responses normally carries the system prompt as an input item. Move
		// it to `instructions` so replacing the input window cannot drop it.
		return { ...rewritten, instructions: systemPrompt };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!supportsNativeCompaction(model)) return;
		if (genericCompactionSelected(pi, ctx)) return;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return;
			const baseUrl = auth.baseUrl ?? model.baseUrl;
			if (!baseUrl) return;

			const branchEntries = event.branchEntries;
			const activeEntries = ctx.sessionManager.buildContextEntries();
			const previous = findLatestNativeCompaction(branchEntries, model);
			const input = nativeRequestInput(model, branchEntries, activeEntries, previous);
			const instructions = [ctx.getSystemPrompt(), event.customInstructions]
				.filter((value): value is string => typeof value === "string" && value.trim() !== "")
				.join("\n\n");
			const details = await compactOpenAIResponses({
				model,
				baseUrl,
				apiKey: auth.apiKey,
				headers: auth.headers,
				input,
				instructions: instructions || undefined,
				signal: event.signal,
			});
			return {
				compaction: {
					summary: NATIVE_COMPACTION_SUMMARY,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: details.usage,
					details,
				},
			};
		} catch (error) {
			if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
			console.error(
				`[pi-provider-compaction] native OpenAI Responses compaction failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return;
		}
	});
}
