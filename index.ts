import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Model, type Provider, type ProviderHeaders, type ProviderStreamOptions, type SimpleStreamOptions, type TranscriptContext, type Usage } from "@earendil-works/pi-ai";
import { compact, convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveCompactionModelPolicy } from "./policy";
import { installObserver, type ObserveRequest } from "./provider";
import { capturePreparedRequest, equal, requestPolicy, selectCoveredPrefix, substituteSummary, summarySlot, type PreparedRequest } from "./replay";
import { isObject, requestProviderCompaction, resolveNativeProtocol, supportsResponsesApi, validateCompactedOutput, type NativeProtocol, type ResponseItem } from "./protocol";

export const NATIVE_COMPACTION_TYPE = "pi-provider-compaction/openai-responses";
export const NATIVE_COMPACTION_VERSION = 3;
export const NATIVE_COMPACTION_SUMMARY = "This context was compacted using the provider's native OpenAI Responses state.";

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
	version: 1 | 2 | 3;
	provider: string;
	api: string;
	model: string;
	protocol: NativeProtocol;
	identity?: NativeIdentity;
	output: ResponseItem[];
	nativeUsage?: Usage;
	portableUsage?: Usage;
	usage?: Usage;
	readFiles?: string[];
	modifiedFiles?: string[];
	coverage?: {
		kind: "summarized-prefix";
		firstKeptEntryId: string;
		sourceLeafId: string;
		sourceHash: string;
		policyHash: string;
		inputHash: string;
		runtimeId: string;
	};
}

export const supportsNativeCompaction = supportsResponsesApi;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const transcript = (messages: AgentMessage[]): TranscriptContext => normalizeContext({ messages: convertToLlm(messages) });

/** Legacy state is inspectable, but its whole-window coverage is never replayed as v3. */
export function readNativeCompactionDetails(value: unknown): NativeCompactionDetails | undefined {
	if (!isObject(value) || value.type !== NATIVE_COMPACTION_TYPE || (value.version !== 1 && value.version !== 2 && value.version !== 3)) return;
	if (typeof value.provider !== "string" || typeof value.api !== "string" || typeof value.model !== "string") return;
	const protocol = value.version === 1 ? "responses-compact" : value.protocol;
	if (protocol !== "responses-compact" && protocol !== "remote-v2") return;
	try {
		const output = validateCompactedOutput(value);
		if (value.version === 3) {
			const coverage = value.coverage;
			if (!isObject(coverage) || coverage.kind !== "summarized-prefix") return;
			for (const field of ["firstKeptEntryId", "sourceLeafId", "sourceHash", "policyHash", "inputHash", "runtimeId"]) {
				if (typeof coverage[field] !== "string" || !coverage[field]) return;
			}
			if (!isObject(value.identity) || typeof value.identity.endpoint !== "string") return;
		}
		return { ...structuredClone(value), protocol, output } as unknown as NativeCompactionDetails;
	} catch { return; }
}

function latestCompaction(branch: readonly SessionEntry[]) {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction") return entry;
	}
	return undefined;
}

function header(headers: ProviderHeaders | undefined, name: string): string | undefined {
	const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
	return typeof value === "string" && value ? value : undefined;
}
function identity(model: Model<any>, options: ProviderStreamOptions | SimpleStreamOptions): NativeIdentity {
	const azure = model.api === "azure-openai-responses";
	const azureBase = options.env?.AZURE_OPENAI_BASE_URL || (options.env?.AZURE_OPENAI_RESOURCE_NAME ? `https://${options.env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : undefined);
	const url = new URL(azure ? azureBase ?? model.baseUrl : model.baseUrl);
	url.username = ""; url.password = ""; url.search = ""; url.hash = "";
	let accountId = header(options.headers, "chatgpt-account-id");
	if (!accountId && model.api === "openai-codex-responses" && options.apiKey) {
		try {
			const token = JSON.parse(Buffer.from(options.apiKey.split(".")[1]!, "base64url").toString("utf8"));
			const id = token["https://api.openai.com/auth"]?.chatgpt_account_id;
			if (typeof id === "string") accountId = id;
		} catch { /* A malformed credential is left to the provider, never persisted. */ }
	}
	const map = options.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP?.split(",").map((entry) => entry.split("=").map((part) => part.trim()));
	return {
		endpoint: url.toString().replace(/\/+$/, ""),
		organization: header(options.headers, "openai-organization"),
		project: header(options.headers, "openai-project"),
		accountId,
		azureApiVersion: azure ? options.env?.AZURE_OPENAI_API_VERSION ?? "v1" : undefined,
		azureDeployment: azure ? map?.find(([id]) => id === model.id)?.[1] ?? model.id : undefined,
	};
}
function combineUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first) return second;
	if (!second) return first;
	const result = structuredClone(first);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) result[key] += second[key];
	for (const key of ["reasoning", "cacheWrite1h"] as const) if (first[key] !== undefined || second[key] !== undefined) result[key] = (first[key] ?? 0) + (second[key] ?? 0);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) result.cost[key] += second.cost[key];
	return result;
}

function supportedRouteOptions(model: Model<any>, options: ProviderStreamOptions | SimpleStreamOptions): boolean {
	if (model.api !== "azure-openai-responses") return true;
	const extra = options as ProviderStreamOptions;
	if (["azureBaseUrl", "azureResourceName", "azureApiVersion", "azureDeploymentName"].some((key) => extra[key] !== undefined)) return false;
	return !["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP"].some((key) => process.env[key] !== undefined && options.env?.[key] === undefined);
}

interface Captured {
	prepared: PreparedRequest;
	model: Model<any>;
	provider: Provider;
	options: ProviderStreamOptions | SimpleStreamOptions;
	branchLength: number;
	branchHash: string;
	routeHash: string;
	authHash: string;
	policyHash: string;
	sessionId: string;
}
interface Active {
	entryId: string;
	detailsHash: string;
	summary: string;
	branchLength: number;
	branchHash: string;
	routeHash: string;
	policyHash: string;
}

export default function (pi: ExtensionAPI): void {
	// Evidence is deliberately process/session-local. A reload cannot prove unchanged
	// hook/privacy policy, even if the visible summary text happens to match.
	const secret = randomBytes(32);
	const routeDigest = (value: unknown) => createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
	let runtimeId = randomUUID();
	let ctx: ExtensionContext | undefined;
	let snapshot: Captured | undefined;
	let active: Active | undefined;
	let pending: { details: NativeCompactionDetails; capture: Captured; summary: string } | undefined;
	let uninstall: (() => void) | undefined;
	let installedProvider: string | undefined;
	let generation = 0;
	let captureStatus = "no request observed";
	let compactionStatus = "not attempted in this runtime";
	const captureRejected = (reason: string) => { captureStatus = reason; };
	const fallback = (reason: string) => { compactionStatus = `portable: ${reason}`; };
	pi.registerCommand("provider-compaction-status", {
		description: "Show content-free native compaction eligibility and last attempt",
		handler: async (_args, context) => {
			context.ui.notify(`Provider compaction\nObserver: ${installedProvider ? "installed" : "unavailable for current registration"}\nCapture: ${captureStatus}\nLast attempt: ${compactionStatus}`, "info");
		},
	});
	const invalidate = () => { generation++; runtimeId = randomUUID(); snapshot = undefined; active = undefined; pending = undefined; captureStatus = "invalidated by lifecycle/history/policy change"; };
	const generic = (context: ExtensionContext) => resolveCompactionModelPolicy(pi, context).hasSelectors;
	const route = (model: Model<any>, options: ProviderStreamOptions | SimpleStreamOptions) => routeDigest({ model, apiKey: options.apiKey, headers: options.headers, env: options.env });
	const unchanged = (branch: readonly SessionEntry[], length: number, hash: string) => branch.length >= length && digest(branch.slice(0, length)) === hash && !branch.slice(length).some((entry) => entry.type === "context_edit");

	const observe: ObserveRequest = (model, context, options) => {
		const owner = ctx;
		if (!owner || options.sessionId !== owner.sessionManager.getSessionId()) return;
		if (!supportsNativeCompaction(model)) { captureRejected("unsupported API"); return; }
		if (!options.onPayload) { captureRejected("no payload callback"); return; }
		if (generic(owner)) { captureRejected("generic compaction model takes precedence"); return; }
		// The Azure adapter also accepts API-specific overrides and process-env
		// fallbacks. Those must not silently select a route absent from our evidence.
		if (!supportedRouteOptions(model, options)) { captureRejected("unsupported route overrides"); return; }
		const ticket = generation;
		const branch = owner.sessionManager.getBranch();
		const branchHash = digest(branch);
		const canonical = transcript(owner.sessionManager.buildSessionProjection().messages);
		const current = () => generation === ticket && ctx === owner && !options.signal?.aborted && supportedRouteOptions(model, options) && digest(owner.sessionManager.getBranch()) === branchHash;
		return async (payload) => {
			if (!current()) return payload;
			snapshot = undefined;
			const prepared = capturePreparedRequest(model, context, canonical, payload, captureRejected);
			if (!prepared) { active = undefined; return payload; }
			const auth = await owner.modelRegistry.getApiKeyAndHeaders(model);
			if (!current()) return payload;
			// A registry lookup after payload hooks must describe the credentials used by
			// THIS request, not a newly rotated account. Header/env rewrites without an
			// exact auth correspondence are deliberately ineligible.
			const normalizedHeaders = (headers: ProviderHeaders | undefined) => Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => String(a).localeCompare(String(b)));
			if (!auth.ok || generic(owner) || auth.apiKey !== options.apiKey || (auth.baseUrl ?? model.baseUrl) !== model.baseUrl || !equal(normalizedHeaders(auth.headers), normalizedHeaders(options.headers)) || !equal(auth.env ?? {}, options.env ?? {})) {
				active = undefined;
				captureRejected("resolved auth/route differs from prepared request, or generic policy changed");
				return payload;
			}
			const provider = owner.modelRegistry.getProvider(model.provider);
			if (!provider) { captureRejected("provider unavailable"); return payload; }
			const routeHash = route(model, options);
			const policyHash = digest(requestPolicy(model, prepared));
			const latest = latestCompaction(branch);
			let result = payload;
			if (active && latest?.id === active.entryId && latest.summary === active.summary && digest(latest.details) === active.detailsHash && unchanged(branch, active.branchLength, active.branchHash) && active.routeHash === routeHash && active.policyHash === policyHash) {
				const details = readNativeCompactionDetails(latest.details);
				const projection = owner.sessionManager.buildSessionProjection();
				const contribution = projection.entries.find((entry) => entry.sourceEntry.id === latest.id);
				const prefix = contribution ? transcript(contribution.messages) : undefined;
				const slot = prefix ? summarySlot(model, prepared, prefix) : undefined;
				if (details?.version === 3 && details.coverage?.runtimeId === runtimeId && details.coverage.firstKeptEntryId === latest.firstKeptEntryId && slot !== undefined) {
					const replaced = substituteSummary(payload, slot, prepared.portableInput[slot]!, details.output);
					if (replaced) {
						result = replaced;
						prepared.payload = structuredClone(replaced);
						prepared.replacement = { index: slot, count: details.output.length };
					} else active = undefined;
				} else active = undefined;
			} else active = undefined;
			captureStatus = "eligible prepared request captured";
			snapshot = {
				prepared, model: structuredClone(model), provider,
				options: { apiKey: options.apiKey, headers: structuredClone(options.headers), env: structuredClone(options.env), fetch: options.fetch },
				branchLength: branch.length, branchHash, routeHash, authHash: routeDigest(auth), policyHash,
				sessionId: owner.sessionManager.getSessionId(),
			};
			return result;
		};
	};

	const install = (context: ExtensionContext) => {
		ctx = context;
		if (installedProvider === context.model?.provider) return;
		uninstall?.(); uninstall = undefined; installedProvider = undefined;
		if (!supportsNativeCompaction(context.model)) return;
		uninstall = installObserver(pi, context, observe);
		if (uninstall) installedProvider = context.model.provider;
		captureStatus = uninstall ? "awaiting prepared request" : "unsupported provider registration";
	};
	pi.on("session_start", (_event, context) => {
		invalidate(); install(context);
		const latest = latestCompaction(context.sessionManager.getBranch());
		if (latest?.summary === NATIVE_COMPACTION_SUMMARY) context.ui.notify("Legacy native compaction has no portable summary. Native replay is disabled; recover from earlier history or start a new session.", "warning");
	});
	pi.on("before_agent_start", (_event, context) => { install(context); });
	pi.on("model_select", (_event, context) => { invalidate(); install(context); });
	pi.on("session_tree", () => { invalidate(); });
	pi.on("session_shutdown", () => { invalidate(); uninstall?.(); uninstall = undefined; installedProvider = undefined; ctx = undefined; });
	// Privacy-policy owners must invalidate before changing a policy that can affect
	// hidden covered history. Arbitrary dynamic privacy compositions are unsupported.
	const removeInvalidation = pi.events.on("pi-provider-compaction:invalidate", invalidate);
	pi.on("session_shutdown", () => { if (typeof removeInvalidation === "function") removeInvalidation(); });

	pi.on("session_before_compact", async (event, context) => {
		const capture = snapshot;
		snapshot = undefined; pending = undefined;
		if (!capture) { fallback(`no eligible snapshot (${captureStatus})`); return; }
		if (!context.model || generic(context) || event.signal.aborted) { fallback("missing model, generic model override, or aborted attempt"); return; }
		const protocol = resolveNativeProtocol(context.model);
		if (!protocol || context.sessionManager.getSessionId() !== capture.sessionId) { fallback("unsupported protocol or changed session"); return; }
		const ticket = generation;
		const branch = context.sessionManager.getBranch();
		const branchHash = digest(branch);
		if (!equal(branch, event.branchEntries) || !unchanged(branch, capture.branchLength, capture.branchHash)) { fallback("history changed since capture"); return; }
		const projection = context.sessionManager.buildSessionProjection();
		const boundary = projection.entries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
		if (boundary < 0) { fallback("retained boundary missing from projection"); return; }
		const prefix = transcript(projection.entries.slice(0, boundary).flatMap((entry) => entry.messages));
		const input = selectCoveredPrefix(capture.model, capture.prepared, prefix, fallback);
		if (!input) return;
		const current = () => ticket === generation && !event.signal.aborted && supportedRouteOptions(capture.model, capture.options) && !generic(context) && context.modelRegistry.getProvider(capture.model.provider) === capture.provider && digest(context.sessionManager.getBranch()) === branchHash;
		const auth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
		if (!current()) return { cancel: true };
		if (!auth.ok || routeDigest(auth) !== capture.authHash) { fallback("auth changed since capture"); return; }
		compactionStatus = "generating portable summary";
		let portable: Awaited<ReturnType<typeof compact>>;
		try {
			portable = await compact(event.preparation, capture.model, auth.apiKey, auth.headers as Record<string, string> | undefined, event.customInstructions, event.signal, context.thinkingLevel, capture.provider.streamSimple.bind(capture.provider), auth.env, undefined, undefined, capture.sessionId);
		} catch {
			// No result exists to return; let Pi own its ordinary failure/fallback behavior.
			return !current() ? { cancel: true } : undefined;
		}
		if (!current() || !portable.summary.trim() || portable.summary === NATIVE_COMPACTION_SUMMARY) return { cancel: true };
		try {
			const freshAuth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
			if (!current()) return { cancel: true };
			if (!freshAuth.ok || routeDigest(freshAuth) !== capture.authHash) { fallback("auth changed after portable generation"); return { compaction: portable }; }
			compactionStatus = "requesting native checkpoint";
			const native = await requestProviderCompaction({
				provider: capture.provider, model: capture.model, context: capture.prepared.context,
				input, preparedPayload: capture.prepared.payload, protocol,
				apiKey: capture.options.apiKey, headers: capture.options.headers, env: capture.options.env,
				signal: event.signal, fetch: capture.options.fetch,
			});
			if (!current()) return { cancel: true };
			const finalAuth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
			if (!current()) return { cancel: true };
			if (!finalAuth.ok || routeDigest(finalAuth) !== capture.authHash) { fallback("auth changed after native generation"); return { compaction: portable }; }
			const details: NativeCompactionDetails = {
				...(isObject(portable.details) ? portable.details : {}),
				type: NATIVE_COMPACTION_TYPE, version: 3, provider: capture.model.provider, api: capture.model.api, model: capture.model.id,
				protocol, identity: identity(capture.model, capture.options), output: native.output,
				nativeUsage: native.usage, portableUsage: portable.usage,
				coverage: { kind: "summarized-prefix", firstKeptEntryId: portable.firstKeptEntryId, sourceLeafId: branch.at(-1)!.id, sourceHash: branchHash, policyHash: capture.policyHash, inputHash: digest(input), runtimeId },
			};
			pending = { details, capture, summary: portable.summary };
			return { compaction: { ...portable, usage: combineUsage(native.usage, portable.usage), details } };
		} catch {
			if (!current()) return { cancel: true };
			// Do not expose exception text: provider errors may contain request data.
			fallback("native acquisition or validation failed");
			// The portable request already succeeded. Never pay for a duplicate summary.
			return { compaction: portable };
		}
	});
	pi.on("session_compact", (event, context) => {
		if (readNativeCompactionDetails(event.compactionEntry.details)?.version === 3) compactionStatus = "native checkpoint committed";
		else if (!compactionStatus.startsWith("portable:")) fallback("another handler supplied the committed result");
		// Only static diagnostics are persisted, never request/auth data or error text.
		if (compactionStatus.startsWith("portable:")) pi.appendEntry("pi-provider-compaction:diagnostic", { status: compactionStatus });
		active = undefined; snapshot = undefined;
		const candidate = pending; pending = undefined;
		if (!candidate || !equal(event.compactionEntry.details, candidate.details) || event.compactionEntry.summary !== candidate.summary) return;
		const branch = context.sessionManager.getBranch();
		const coverage = candidate.details.coverage;
		if (!coverage || event.compactionEntry.firstKeptEntryId !== coverage.firstKeptEntryId || event.compactionEntry.parentId !== coverage.sourceLeafId || branch.at(-1)?.id !== event.compactionEntry.id || digest(branch.slice(0, -1)) !== coverage.sourceHash) return;
		active = { entryId: event.compactionEntry.id, detailsHash: digest(candidate.details), summary: candidate.summary, branchLength: branch.length, branchHash: digest(branch), routeHash: candidate.capture.routeHash, policyHash: candidate.capture.policyHash };
	});
	pi.on("session_compact_failed", () => { pending = undefined; snapshot = undefined; compactionStatus = "compaction failed or cancelled"; });
}
