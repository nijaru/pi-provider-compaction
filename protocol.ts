import type {
	AssistantMessageEventStream,
	Context,
	Model,
	Provider,
	ProviderHeaders,
	Usage,
} from "@earendil-works/pi-ai";

export type JsonObject = Record<string, unknown>;
export type ResponseItem = JsonObject;
export type NativeProtocol = "responses-compact" | "remote-v2";

const RESPONSES_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const REMOTE_RETAINED_BYTES = 8 * 1024 * 1024;
const REMOTE_RETAINED_CHARS = 64_000 * 4;

export function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsResponsesApi(model: Model<any> | undefined): model is Model<any> {
	return model !== undefined && RESPONSES_APIS.has(String(model.api));
}

export function resolveNativeProtocol(model: Model<any> | undefined): NativeProtocol | undefined {
	if (!supportsResponsesApi(model)) return undefined;
	return model.api === "openai-codex-responses" ? "remote-v2" : "responses-compact";
}

export function isCompactionItem(value: unknown): value is ResponseItem {
	return isObject(value) && value.type === "compaction" && typeof value.encrypted_content === "string" && value.encrypted_content.length > 0;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateItemSize(item: ResponseItem): void {
	if (byteLength(item) > MAX_ITEM_BYTES) throw new Error("Native compaction output item exceeded 2 MiB");
}

export function validateCompactedOutput(value: unknown): ResponseItem[] {
	if (!isObject(value) || !Array.isArray(value.output) || value.output.length === 0) {
		throw new Error("Responses Compact returned an invalid output window");
	}
	const output = value.output.map((item) => {
		if (!isObject(item)) throw new Error("Responses Compact returned a non-object output item");
		validateItemSize(item);
		return structuredClone(item);
	});
	const checkpoints = output.filter(isCompactionItem);
	if (checkpoints.length !== 1) {
		throw new Error(`Responses Compact returned ${checkpoints.length} compaction items; expected exactly one`);
	}
	return output;
}

async function readJsonBounded(response: Response, signal: AbortSignal): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error("Native compaction response exceeded 8 MiB");
	}
	if (!response.body) throw new Error("Native compaction response did not contain a body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const onAbort = () => void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) throw new Error("Native compaction response exceeded 8 MiB");
			chunks.push(value);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("Native compaction response returned malformed JSON");
	}
}

function requestUrl(input: string | URL | Request): URL {
	return new URL(input instanceof Request ? input.url : String(input));
}

export function responsesCompactUrl(input: string | URL | Request): URL {
	const original = requestUrl(input);
	if (!original.pathname.endsWith("/responses")) {
		throw new Error("Provider request URL does not end with /responses");
	}
	const compact = new URL(original);
	compact.pathname = `${compact.pathname}/compact`;
	if (compact.origin !== original.origin) throw new Error("Responses Compact URL changed origin");
	return compact;
}

function mergedHeaders(input: string | URL | Request, init?: RequestInit): Headers {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
	headers.delete("content-encoding");
	headers.delete("content-length");
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return headers;
}

function compactPayload(payload: JsonObject): JsonObject {
	const allowed = [
		"model",
		"input",
		"instructions",
		"previous_response_id",
		"prompt_cache_key",
		"prompt_cache_retention",
		"service_tier",
	] as const;
	const result: JsonObject = {};
	for (const key of allowed) {
		if (Object.hasOwn(payload, key) && payload[key] !== undefined) result[key] = structuredClone(payload[key]);
	}
	if (typeof result.model !== "string" || !Array.isArray(result.input)) {
		throw new Error("Provider did not expose a valid Responses payload for compaction");
	}
	return result;
}

function errorResponse(error: unknown): Response {
	return Response.json(
		{ error: { message: error instanceof Error ? error.message : String(error), type: "invalid_request_error" } },
		{ status: 400 },
	);
}

function rawUsage(response: JsonObject): JsonObject {
	if (!isObject(response.usage)) throw new Error("Native compaction response is missing usage");
	return structuredClone(response.usage);
}

function syntheticCompletion(response: JsonObject, payload: JsonObject): Response {
	const completed = {
		id: typeof response.id === "string" ? response.id : "resp_pi_provider_compaction",
		object: "response",
		created_at: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
		status: "completed",
		model: payload.model,
		output: [],
		parallel_tool_calls: false,
		tool_choice: "auto",
		tools: [],
		usage: rawUsage(response),
	};
	const body = [
		{ type: "response.created", response: { ...completed, status: "in_progress" } },
		{ type: "response.completed", response: completed },
	]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collectProviderUsage(stream: AssistantMessageEventStream, signal: AbortSignal): Promise<Usage> {
	let usage: Usage | undefined;
	for await (const event of stream) {
		if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "Native compaction provider request failed");
		if (event.type === "done") usage = event.message.usage;
	}
	if (!usage) throw new Error("Native compaction provider stream ended without usage");
	return usage;
}

interface TransportRequest {
	provider: Provider;
	model: Model<any>;
	context: Context;
	input: ResponseItem[];
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
	signal: AbortSignal;
	fetch?: typeof globalThis.fetch;
}

export interface TransportResponse {
	output: ResponseItem[];
	usage: Usage;
}

async function requestResponsesCompact(request: TransportRequest): Promise<TransportResponse> {
	let preparedPayload: JsonObject | undefined;
	let compacted: { response: JsonObject; output: ResponseItem[] } | undefined;
	let bridgeError: unknown;
	let dispatches = 0;
	const baseFetch = request.fetch ?? globalThis.fetch;
	const bridgeFetch: typeof globalThis.fetch = async (input, init) => {
		if (request.signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
		dispatches += 1;
		if (dispatches !== 1 || !preparedPayload) {
			bridgeError = new Error("Responses Compact provider dispatched an unexpected additional request");
			return errorResponse(bridgeError);
		}
		try {
			const compactUrl = responsesCompactUrl(input);
			const response = await baseFetch(compactUrl, {
				...init,
				method: "POST",
				headers: mergedHeaders(input, init),
				body: JSON.stringify(compactPayload(preparedPayload)),
				signal: request.signal,
			});
			if (!response.ok) return response;
			const parsed = await readJsonBounded(response, request.signal);
			if (!isObject(parsed)) throw new Error("Responses Compact returned a non-object response");
			compacted = { response: parsed, output: validateCompactedOutput(parsed) };
			return syntheticCompletion(parsed, preparedPayload);
		} catch (error) {
			bridgeError = error;
			return errorResponse(error);
		}
	};

	const stream = request.provider.stream(request.model, request.context, {
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		signal: request.signal,
		transport: "sse",
		cacheRetention: "none",
		maxRetries: 0,
		fetch: bridgeFetch,
		onPayload: (payload: unknown) => {
			if (!isObject(payload)) throw new Error("Responses provider exposed a non-object payload");
			preparedPayload = { ...structuredClone(payload), input: structuredClone(request.input) };
			return preparedPayload;
		},
	});

	const usage = await collectProviderUsage(stream, request.signal).catch((error) => {
		if (bridgeError) throw bridgeError;
		throw error;
	});
	if (bridgeError) throw bridgeError;
	if (!compacted || dispatches !== 1) throw new Error("Responses Compact did not complete exactly one request");
	return { output: compacted.output, usage };
}

interface CollectedSse {
	item: ResponseItem;
}

async function collectCompactionSse(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<CollectedSse> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let pending = "";
	let dataLines: string[] = [];
	let completed = false;
	const items = new Map<string, ResponseItem>();
	const onAbort = () => void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
	signal.addEventListener("abort", onAbort, { once: true });
	const dispatch = () => {
		if (dataLines.length === 0) return;
		const data = dataLines.join("\n");
		dataLines = [];
		if (data === "[DONE]") return;
		let event: unknown;
		try { event = JSON.parse(data); } catch { throw new Error("Remote V2 returned malformed SSE JSON"); }
		if (!isObject(event)) return;
		if (event.type === "response.completed") completed = true;
		const candidates: unknown[] = [];
		if (event.type === "response.output_item.done") candidates.push(event.item);
		if (event.type === "response.completed" && isObject(event.response) && Array.isArray(event.response.output)) {
			candidates.push(...event.response.output);
		}
		for (const candidate of candidates) {
			if (!isCompactionItem(candidate)) continue;
			validateItemSize(candidate);
			items.set(JSON.stringify(candidate), structuredClone(candidate));
		}
	};
	const processLine = (line: string) => {
		if (line === "") return dispatch();
		if (line.startsWith(":")) return;
		if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	};
	try {
		while (true) {
			if (signal.aborted) throw new DOMException("Compaction aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("Remote V2 stream exceeded 8 MiB");
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const raw = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				processLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
				newline = pending.indexOf("\n");
			}
		}
		pending += decoder.decode();
		if (pending) processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
		dispatch();
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
	if (!completed) throw new Error("Remote V2 stream ended without response.completed");
	if (items.size !== 1) throw new Error(`Remote V2 returned ${items.size} distinct compaction items; expected exactly one`);
	return { item: [...items.values()][0] };
}

function retainedUserMessage(item: ResponseItem): boolean {
	return (item.type === undefined || item.type === "message") && item.role === "user" && Array.isArray(item.content);
}

function buildRemoteV2History(input: ResponseItem[], item: ResponseItem): ResponseItem[] {
	validateItemSize(item);
	let remainingBytes = REMOTE_RETAINED_BYTES - byteLength(item);
	let remainingChars = REMOTE_RETAINED_CHARS;
	const kept: ResponseItem[] = [];
	for (let index = input.length - 1; index >= 0; index--) {
		const candidate = input[index];
		if (!retainedUserMessage(candidate)) continue;
		const bytes = byteLength(candidate);
		if (bytes > remainingBytes) continue;
		const chars = JSON.stringify(candidate).length;
		if (chars > remainingChars) continue;
		kept.push(structuredClone(candidate));
		remainingBytes -= bytes;
		remainingChars -= chars;
		if (remainingBytes < 256 || remainingChars < 64) break;
	}
	return [...kept.reverse(), structuredClone(item)];
}

async function requestRemoteV2(request: TransportRequest): Promise<TransportResponse> {
	const baseFetch = request.fetch ?? globalThis.fetch;
	let sentInput: ResponseItem[] | undefined;
	const inspections: Promise<CollectedSse>[] = [];
	const inspectedFetch: typeof globalThis.fetch = async (input, init) => {
		const response = await baseFetch(input, init);
		if (!response.ok || !response.body) return response;
		const [providerBody, inspectionBody] = response.body.tee();
		inspections.push(collectCompactionSse(inspectionBody, request.signal));
		return new Response(providerBody, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};

	const stream = request.provider.stream(request.model, request.context, {
		apiKey: request.apiKey,
		headers: request.headers,
		env: request.env,
		signal: request.signal,
		transport: "sse",
		cacheRetention: "none",
		maxRetries: 0,
		fetch: inspectedFetch,
		onPayload: (payload: unknown) => {
			if (!isObject(payload)) throw new Error("Codex provider exposed a non-object payload");
			sentInput = structuredClone(request.input);
			return { ...structuredClone(payload), input: [...sentInput, { type: "compaction_trigger" }] };
		},
	});
	const usage = await collectProviderUsage(stream, request.signal);
	if (!sentInput || inspections.length !== 1) {
		throw new Error(`Remote V2 observed ${inspections.length} successful provider responses; expected exactly one`);
	}
	const inspection = await inspections[0];
	return { output: buildRemoteV2History(sentInput, inspection.item), usage };
}

export async function requestProviderCompaction(
	request: TransportRequest & { protocol: NativeProtocol },
): Promise<TransportResponse> {
	return request.protocol === "remote-v2" ? requestRemoteV2(request) : requestResponsesCompact(request);
}
