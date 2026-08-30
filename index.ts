import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertResponsesMessages,
	convertResponsesTools,
} from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

export const NATIVE_COMPACTION_TYPE = "pi-provider-compaction/openai-responses";
export const NATIVE_COMPACTION_VERSION = 1;
export const NATIVE_COMPACTION_SUMMARY =
	"This context was compacted using the provider's native OpenAI Responses state.";

const SUPPORTED_APIS = new Set(["openai-responses", "openai-codex-responses"]);
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
}

interface NativeCompactionState extends NativeCompactionDetails {
	entryId: string;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsNativeCompaction(model: Model<any> | undefined): model is Model<any> {
	return model !== undefined && SUPPORTED_APIS.has(model.api);
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
	tools?: ResponseItem[];
	signal?: AbortSignal;
	fetchImpl?: FetchImplementation;
}

export async function compactOpenAIResponses(options: CompactRequestOptions): Promise<NativeCompactionDetails> {
	const endpoint = `${options.baseUrl.replace(/\/$/, "")}/responses/compact`;
	const body: JsonObject = {
		model: options.model.id,
		input: options.input,
	};
	if (options.instructions) body.instructions = options.instructions;
	if (options.tools && options.tools.length > 0) body.tools = options.tools;

	const response = await (options.fetchImpl ?? fetch)(endpoint, {
		method: "POST",
		headers: authHeaders(options.apiKey, options.headers),
		body: JSON.stringify(body),
		signal: options.signal,
	});
	if (!response.ok) throw new Error(`OpenAI Responses compact request failed (${response.status})`);

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
	};
}

function itemMatches(left: ResponseItem, right: ResponseItem): boolean {
	const leftId = typeof left.id === "string" ? left.id : undefined;
	const rightId = typeof right.id === "string" ? right.id : undefined;
	if (leftId && rightId) return leftId === rightId;
	const leftCallId = typeof left.call_id === "string" ? left.call_id : undefined;
	const rightCallId = typeof right.call_id === "string" ? right.call_id : undefined;
	if (leftCallId && rightCallId) return leftCallId === rightCallId && left.type === right.type;
	if (left.type === "message" && right.type === "message") {
		return left.role === right.role && JSON.stringify(left.content) === JSON.stringify(right.content);
	}
	return JSON.stringify(left) === JSON.stringify(right);
}

function findLastMatchingItem(items: ResponseItem[], target: ResponseItem): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (itemMatches(items[index], target)) return index;
	}
	return -1;
}

function findSubsequence(items: ResponseItem[], sequence: ResponseItem[]): number {
	if (sequence.length === 0) return -1;
	for (let start = 0; start <= items.length - sequence.length; start++) {
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

	for (let index = details.output.length - 1; index >= 0; index--) {
		const nativeItem = details.output[index];
		if (nativeItem.type === "compaction") continue;
		const anchor = findLastMatchingItem(currentInput, nativeItem);
		if (anchor >= 0) {
			return { ...payload, input: [...details.output, ...currentInput.slice(anchor + 1)] };
		}
	}

	const postStart = findSubsequence(currentInput, postCompactionItems);
	if (postStart >= 0) {
		return { ...payload, input: [...details.output, ...currentInput.slice(postStart)] };
	}
	return { ...payload, input: [...details.output, ...postCompactionItems] };
}

function configuredTools(pi: ExtensionAPI, model: Model<any>): ResponseItem[] {
	const active = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	const compat = model.compat as {
		supportsStrictMode?: boolean;
		supportsOpenAIGrammarTools?: boolean;
	} | undefined;
	return convertResponsesTools(tools, {
		supportsStrictMode: compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: compat?.supportsOpenAIGrammarTools ?? false,
	}) as unknown as ResponseItem[];
}

function hasGenericCompactionModel(pi: ExtensionAPI): boolean {
	const value = pi.getFlag("compaction-model");
	return typeof value === "string" && value.trim() !== "";
}

export default function (pi: ExtensionAPI): void {
	let lastRequestTools: ResponseItem[] | undefined;

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (isObject(event.payload) && Array.isArray(event.payload.tools)) {
			lastRequestTools = event.payload.tools.filter(isObject) as ResponseItem[];
		}
		if (hasGenericCompactionModel(pi) || !supportsNativeCompaction(model)) return;

		const latest = findLatestNativeCompaction(ctx.sessionManager.getBranch(), model);
		if (!latest) return;
		const branch = ctx.sessionManager.getBranch();
		const index = branch.findIndex((entry) => entry.id === latest.entryId);
		const postItems = index >= 0 ? responseItemsFromEntries(model, branch.slice(index + 1)) : [];
		const rewritten = rewriteResponsesPayload(event.payload, latest, postItems);
		if (rewritten === event.payload || !isObject(rewritten) || !ctx.getSystemPrompt()) return rewritten;
		// openai-responses normally carries the system prompt as an input item. Move
		// it to `instructions` so replacing the input window cannot drop it.
		return { ...rewritten, instructions: ctx.getSystemPrompt() };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (hasGenericCompactionModel(pi) || !supportsNativeCompaction(model)) return;

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
				tools: lastRequestTools ?? configuredTools(pi, model),
				signal: event.signal,
			});
			return {
				compaction: {
					summary: NATIVE_COMPACTION_SUMMARY,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
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
