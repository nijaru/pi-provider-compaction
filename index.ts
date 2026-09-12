import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { calculateCost } from "@earendil-works/pi-ai";
import type { Context, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	compact,
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { resolveCompactionModelPolicy } from "./policy";
import {
	isCompactionItem,
	isObject,
	requestProviderCompaction,
	resolveNativeProtocol,
	supportsResponsesApi,
	type NativeProtocol,
	type ResponseItem,
} from "./protocol";

export const NATIVE_COMPACTION_TYPE = "pi-provider-compaction/openai-responses";
export const NATIVE_COMPACTION_VERSION = 2;
/** Legacy v1 visible summary, retained only for old sessions/tests. New compactions persist a real portable summary. */
export const NATIVE_COMPACTION_SUMMARY =
	"This context was compacted using the provider's native OpenAI Responses state.";

const TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

type JsonObject = Record<string, unknown>;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NativeIdentity {
	endpoint: string;
	organization?: string;
	project?: string;
	accountId?: string;
	azureApiVersion?: string;
	azureDeployment?: string;
}

export interface NativeCompactionDetails {
	type: typeof NATIVE_COMPACTION_TYPE;
	version: 1 | typeof NATIVE_COMPACTION_VERSION;
	provider: string;
	api: string;
	model: string;
	protocol: NativeProtocol;
	identity?: NativeIdentity;
	output: ResponseItem[];
	/** Native protocol usage. `usage` is a legacy alias accepted for v1 compatibility. */
	nativeUsage?: Usage;
	usage?: Usage;
	portableUsage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
}

interface NativeCompactionState extends NativeCompactionDetails {
	entryId: string;
}

export function supportsNativeCompaction(model: Model<any> | undefined): model is Model<any> {
	return supportsResponsesApi(model);
}

function readUsage(value: unknown): Usage | undefined {
	if (!isObject(value) || !isObject(value.cost)) return undefined;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return undefined;
	}
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		if (typeof value.cost[key] !== "number" || !Number.isFinite(value.cost[key])) return undefined;
	}
	return value as unknown as Usage;
}

function readIdentity(value: unknown): NativeIdentity | undefined {
	if (!isObject(value) || typeof value.endpoint !== "string" || !value.endpoint) return undefined;
	for (const key of ["organization", "project", "accountId", "azureApiVersion", "azureDeployment"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") return undefined;
	}
	return {
		endpoint: value.endpoint,
		organization: value.organization as string | undefined,
		project: value.project as string | undefined,
		accountId: value.accountId as string | undefined,
		azureApiVersion: value.azureApiVersion as string | undefined,
		azureDeployment: value.azureDeployment as string | undefined,
	};
}

export function readNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isObject(value) || value.type !== NATIVE_COMPACTION_TYPE) return undefined;
	if (value.version !== 1 && value.version !== NATIVE_COMPACTION_VERSION) return undefined;
	if (typeof value.provider !== "string" || typeof value.api !== "string" || typeof value.model !== "string") return undefined;
	if (!Array.isArray(value.output) || !value.output.every(isObject) || !value.output.some(isCompactionItem)) return undefined;
	const protocol = value.version === 1
		? "responses-compact"
		: value.protocol === "responses-compact" || value.protocol === "remote-v2"
			? value.protocol
			: undefined;
	if (!protocol) return undefined;
	const strings = (candidate: unknown): string[] | undefined =>
		candidate === undefined ? undefined : Array.isArray(candidate) && candidate.every((item) => typeof item === "string") ? [...candidate] : undefined;
	return {
		type: NATIVE_COMPACTION_TYPE,
		version: value.version,
		provider: value.provider,
		api: value.api,
		model: value.model,
		protocol,
		identity: value.version === 1 ? undefined : readIdentity(value.identity),
		output: structuredClone(value.output) as ResponseItem[],
		nativeUsage: readUsage(value.nativeUsage ?? value.usage),
		usage: readUsage(value.usage),
		portableUsage: readUsage(value.portableUsage),
		readFiles: strings(value.readFiles),
		modifiedFiles: strings(value.modifiedFiles),
	};
}

function identityEqual(left: NativeIdentity | undefined, right: NativeIdentity | undefined): boolean {
	if (!left) return true; // Legacy checkpoints did not persist route identity.
	if (!right) return false;
	return left.endpoint === right.endpoint && left.organization === right.organization && left.project === right.project && left.accountId === right.accountId && left.azureApiVersion === right.azureApiVersion && left.azureDeployment === right.azureDeployment;
}

export function findLatestNativeCompaction(
	entries: readonly SessionEntry[],
	model: Model<any> | undefined,
	identity?: NativeIdentity,
): NativeCompactionState | undefined {
	if (!supportsNativeCompaction(model)) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const details = readNativeCompactionDetails(entry.details);
		if (!details) return undefined;
		if (details.provider !== model.provider || details.api !== model.api || details.model !== model.id) return undefined;
		if (!identityEqual(details.identity, identity)) return undefined;
		return { ...details, entryId: entry.id };
	}
	return undefined;
}

function responseItemsFromMessages(model: Model<any>, messages: AgentMessage[]): ResponseItem[] {
	const input = convertResponsesMessages(
		model,
		{ messages: convertToLlm(messages), tools: [] },
		TOOL_CALL_PROVIDERS,
		{ includeSystemPrompt: false },
	);
	return input.filter(isObject) as ResponseItem[];
}

function responseItemsFromEntries(model: Model<any>, entries: readonly SessionEntry[]): ResponseItem[] {
	return responseItemsFromMessages(model, entries.flatMap((entry) => sessionEntryToContextMessages(entry)));
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
			return [...structuredClone(previous.output), ...responseItemsFromEntries(model, branchEntries.slice(previousIndex + 1))];
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
		if (name.toLowerCase() === "authorization" && value.trim()) hasAuthorization = true;
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

/** Legacy/test helper for the direct standalone endpoint. Runtime calls use Pi's provider transport below. */
export async function compactOpenAIResponses(options: CompactRequestOptions): Promise<NativeCompactionDetails> {
	const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/responses/compact`;
	const body: JsonObject = { model: options.model.id, input: options.input };
	if (options.instructions) body.instructions = options.instructions;
	const response = await (options.fetchImpl ?? fetch)(endpoint, {
		method: "POST",
		headers: authHeaders(options.apiKey, options.headers),
		body: JSON.stringify(body),
		signal: options.signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`OpenAI Responses compact request failed (${response.status}${detail ? `: ${detail.slice(0, 400)}` : ""})`);
	}
	const result: unknown = await response.json();
	if (!isObject(result) || !Array.isArray(result.output) || !result.output.every(isObject) || !result.output.some(isCompactionItem)) {
		throw new Error("OpenAI Responses compact response did not contain opaque compaction state");
	}
	const usage = compactUsage(options.model, result);
	return {
		type: NATIVE_COMPACTION_TYPE,
		version: NATIVE_COMPACTION_VERSION,
		provider: options.model.provider,
		api: options.model.api,
		model: options.model.id,
		protocol: "responses-compact",
		output: structuredClone(result.output) as ResponseItem[],
		nativeUsage: usage,
		usage,
	};
}

function compactUsage(model: Model<any>, result: JsonObject): Usage | undefined {
	const usage = result.usage;
	if (!isObject(usage)) return undefined;
	const cached = nestedNumber(usage.input_tokens_details, "cached_tokens");
	const cacheWrite = nestedNumber(usage.input_tokens_details, "cache_write_tokens");
	const mapped: Usage = {
		input: Math.max(0, readNumber(usage.input_tokens) - cached - cacheWrite),
		output: readNumber(usage.output_tokens),
		cacheRead: cached,
		cacheWrite,
		reasoning: nestedNumber(usage.output_tokens_details, "reasoning_tokens"),
		totalTokens: readNumber(usage.total_tokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	try { calculateCost(model, mapped); } catch { /* Models without price metadata still retain token usage. */ }
	return mapped;
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nestedNumber(value: unknown, key: string): number {
	return isObject(value) ? readNumber(value[key]) : 0;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
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
		if (sequence.every((item, offset) => itemMatches(items[start + offset], item))) return start;
	}
	return -1;
}

export function rewriteResponsesPayload(
	payload: unknown,
	details: NativeCompactionDetails,
	postCompactionItems: ResponseItem[],
): unknown {
	if (!isObject(payload) || !Array.isArray(payload.input)) return payload;
	const currentInput = payload.input.filter(isObject) as ResponseItem[];
	if (currentInput.length !== payload.input.length) return payload;
	const postStart = findLastSubsequence(currentInput, postCompactionItems);
	if (postStart >= 0) return { ...payload, input: [...structuredClone(details.output), ...currentInput.slice(postStart)] };
	const retainedOutput = details.output.filter((item) => item.type !== "compaction");
	const retainedStart = findLastSubsequence(currentInput, retainedOutput);
	if (retainedStart >= 0) {
		return { ...payload, input: [...structuredClone(details.output), ...currentInput.slice(retainedStart + retainedOutput.length)] };
	}
	return { ...payload, input: [...structuredClone(details.output), ...structuredClone(postCompactionItems)] };
}

function genericCompactionSelected(
	pi: Pick<ExtensionAPI, "getFlag">,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "sessionManager">,
): boolean {
	return resolveCompactionModelPolicy(pi, ctx).hasSelectors;
}

function normalizedEndpoint(value: string | undefined): string {
	if (!value) return "";
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return value.replace(/\/+$/, "");
	}
}

function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
	const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return typeof match?.[1] === "string" && match[1] ? match[1] : undefined;
}

function codexAccountId(apiKey: string | undefined): string | undefined {
	if (!apiKey) return undefined;
	const parts = apiKey.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isObject(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		return isObject(auth) && typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function azureDeployment(modelId: string, env: Record<string, string> | undefined): string {
	const raw = env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	if (!raw) return modelId;
	for (const entry of raw.split(",")) {
		const [candidate, deployment] = entry.split("=", 2).map((part) => part?.trim());
		if (candidate === modelId && deployment) return deployment;
	}
	return modelId;
}

function routeIdentity(
	model: Model<any>,
	auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string; env?: Record<string, string> },
): NativeIdentity {
	const azure = model.api === "azure-openai-responses";
	return {
		endpoint: normalizedEndpoint(auth.baseUrl ?? auth.env?.AZURE_OPENAI_BASE_URL ?? model.baseUrl),
		organization: headerValue(auth.headers, "openai-organization"),
		project: headerValue(auth.headers, "openai-project"),
		accountId: model.api === "openai-codex-responses" ? codexAccountId(auth.apiKey) : undefined,
		azureApiVersion: azure ? (auth.env?.AZURE_OPENAI_API_VERSION || "v1") : undefined,
		azureDeployment: azure ? azureDeployment(model.id, auth.env) : undefined,
	};
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().flatMap((name) => {
		const tool = available.get(name);
		return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
	});
}

function providerContext(pi: ExtensionAPI, ctx: ExtensionContext, activeEntries: readonly SessionEntry[]): Context {
	const messages = activeEntries.flatMap((entry) => sessionEntryToContextMessages(entry));
	return {
		systemPrompt: ctx.getSystemPrompt(),
		messages: convertToLlm(messages),
		tools: activeTools(pi),
	};
}

function cleanHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

function combineUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first) return second;
	if (!second) return first;
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		cacheWrite1h: first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined ? (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) : undefined,
		reasoning: first.reasoning !== undefined || second.reasoning !== undefined ? (first.reasoning ?? 0) + (second.reasoning ?? 0) : undefined,
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

async function nativeAndPortableCompaction(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
) {
	const model = ctx.model;
	const protocol = resolveNativeProtocol(model);
	if (!model || !protocol || genericCompactionSelected(pi, ctx)) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) return undefined;
	const identity = routeIdentity(model, auth);
	const branchEntries = event.branchEntries;
	const activeEntries = ctx.sessionManager.buildContextEntries();
	const previous = findLatestNativeCompaction(branchEntries, model, identity);
	const input = nativeRequestInput(model, branchEntries, activeEntries, previous);
	const native = await requestProviderCompaction({
		provider,
		model,
		context: providerContext(pi, ctx, activeEntries),
		input,
		protocol,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal: event.signal,
	});
	// Generate the same meaningful text summary Pi would have persisted without
	// the native adapter. This is deliberate extra work: it keeps model/provider
	// switches and sessions loaded without this extension usable.
	const portable = await compact(
		event.preparation,
		model,
		auth.apiKey,
		cleanHeaders(auth.headers),
		event.customInstructions,
		event.signal,
		ctx.thinkingLevel,
		provider.streamSimple.bind(provider),
		auth.env,
		undefined,
		undefined,
		ctx.sessionManager.getSessionId(),
	);
	const portableDetails = isObject(portable.details) ? portable.details : {};
	const details: NativeCompactionDetails = {
		type: NATIVE_COMPACTION_TYPE,
		version: NATIVE_COMPACTION_VERSION,
		provider: model.provider,
		api: model.api,
		model: model.id,
		protocol,
		identity,
		output: native.output,
		nativeUsage: native.usage,
		portableUsage: portable.usage,
		readFiles: Array.isArray(portableDetails.readFiles) ? portableDetails.readFiles.filter((item): item is string => typeof item === "string") : undefined,
		modifiedFiles: Array.isArray(portableDetails.modifiedFiles) ? portableDetails.modifiedFiles.filter((item): item is string => typeof item === "string") : undefined,
	};
	return {
		compaction: {
			...portable,
			usage: combineUsage(native.usage, portable.usage),
			details,
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		if (!supportsNativeCompaction(model)) return;
		const branch = ctx.sessionManager.getBranch();
		// Avoid auth resolution on ordinary requests that have no native checkpoint.
		const candidate = findLatestNativeCompaction(branch, model);
		if (!candidate || genericCompactionSelected(pi, ctx)) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;
		const latest = findLatestNativeCompaction(branch, model, routeIdentity(model, auth));
		if (!latest) return;
		const index = branch.findIndex((entry: SessionEntry) => entry.id === latest.entryId);
		const postItems = index >= 0 ? responseItemsFromEntries(model, branch.slice(index + 1)) : [];
		const rewritten = rewriteResponsesPayload(event.payload, latest, postItems);
		if (rewritten === event.payload || !isObject(rewritten)) return rewritten;
		const systemPrompt = ctx.getSystemPrompt();
		return systemPrompt ? { ...rewritten, instructions: systemPrompt } : rewritten;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			return await nativeAndPortableCompaction(pi, event, ctx);
		} catch (error) {
			if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) return undefined;
			console.error(`[pi-provider-compaction] native compaction failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	});
}
