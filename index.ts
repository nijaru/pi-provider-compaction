import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, registerSessionResourceCleanup, type Model, type Provider, type ProviderHeaders, type ProviderStreamOptions, type SimpleStreamOptions, type TranscriptContext, type Usage } from "@earendil-works/pi-ai";
import { compact, convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveCompactionModelPolicy } from "./policy";
import { cacheConfig, cachedSummary, captureCachedRequest, finishCachedRequest, requestCacheState, sameCachedPrompt, supportsCachedSummary, withFileTracking, type CachedRequest } from "./cached-summary";
import { bindUsageHeaders, installObserver, type InstalledObserver, type ObserveRequest } from "./provider";
import { serveUsageObservers } from "./usage-observer";
import { capturePreparedRequest, equal, requestPolicy, selectCoveredPrefix, substituteSummary, summarySlot, type PreparedRequest } from "./replay";
import { isObject, NativeCompactionValidationError, requestProviderCompaction, resolveNativeProtocol, supportsResponsesApi, validateCompactedOutput, type NativeProtocol, type ResponseItem } from "./protocol";

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
	options: (ProviderStreamOptions | SimpleStreamOptions) & { serviceTier?: string };
	branchLength: number;
	branchHash: string;
	routeHash: string;
	authHash: string;
	policyHash: string;
	sessionId: string;
}
interface Active {
	entryId: string;
	summary: string;
	branchLength: number;
	branchHash: string;
	routeHash: string;
	policyHash: string;
	/** Model field of the prepared payload; a request hook rewrite invalidates native state. */
	payloadModel?: string;
}

interface ExpiryAttempt {
	sessionId: string;
	cycle: string;
	isCurrent(): boolean;
	signal?: AbortSignal;
}

export default function (pi: ExtensionAPI): void {
	// Evidence is deliberately process/session-local. A reload cannot prove unchanged
	// hook/privacy policy, even if the visible summary text happens to match.
	// Older hosts in the native adapter's supported range lack getSettings.
	// Keep their existing native path; cache preferences require that host API.
	const configuration = () => typeof pi.getSettings === "function" ? cacheConfig(pi.getSettings()) : { cachedSummaries: false, outcomeNotifications: false, cacheRetention: undefined };
	const secret = randomBytes(32);
	const routeDigest = (value: unknown) => createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
	let runtimeId = randomUUID();
	let ctx: ExtensionContext | undefined;
	let usageObservers = serveUsageObservers(pi, () => ctx);
	let snapshot: Captured | undefined;
	let cache: CachedRequest | undefined;
	let compactionRequest = false;
	let expiryAttempt: ExpiryAttempt | undefined;
	let lastOutcome: { path: string; elapsedMs: number; usage?: Usage; reason?: string } | undefined;
	let active: Active | undefined;
	let pending: { details: NativeCompactionDetails; capture: Captured; summary: string } | undefined;
	let observer: InstalledObserver | undefined;
	let unregisterCleanup: (() => void) | undefined;
	let generation = 0;
	let requestSequence = 0;
	let captureStatus = "no request observed";
	let compactionStatus = "not attempted in this runtime";
	let fallbackReason: string | undefined;
	const captureRejected = (reason: string) => { captureStatus = reason; };
	const fallback = (reason: string) => { fallbackReason = reason; compactionStatus = `portable: ${reason}`; };
	pi.registerCommand("provider-compaction-status", {
		description: "Show cache/native eligibility and measured compaction usage",
		handler: async (_args, context) => {
			const state = cacheState(context);
			const remaining = state.expiresAt === undefined ? "unknown lifetime" : `estimated ${Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000))}s remaining (model declaration; best effort)`;
			const usage = lastOutcome?.usage;
			context.ui.notify(`Provider compaction\nObserver: ${observer?.isInstalled() ? "installed" : "unavailable for current registration"}\nCapture: ${captureStatus}\nCache: ${state.reason}; ${remaining}\nLast attempt: ${compactionStatus}${lastOutcome ? `\nOutcome: ${lastOutcome.path}, ${lastOutcome.elapsedMs}ms${usage ? `; input ${usage.input}, cache read ${usage.cacheRead}, write ${usage.cacheWrite}, output ${usage.output}; estimated cost $${usage.cost.total.toFixed(6)}` : "; usage unavailable"}${lastOutcome.reason ? `; ${lastOutcome.reason}` : ""}` : ""}`, "info");
		},
	});
	const invalidate = () => { generation++; runtimeId = randomUUID(); snapshot = undefined; cache = undefined; active = undefined; pending = undefined; expiryAttempt = undefined; captureStatus = "invalidated by lifecycle/history/policy change"; };
	const retire = () => {
		usageObservers.clear();
		invalidate();
		const installed = observer;
		observer = undefined; ctx = undefined;
		unregisterCleanup?.(); unregisterCleanup = undefined;
		installed?.remove();
		lastOutcome = undefined;
	};
	pi.on("before_provider_headers", (event, context) => {
		bindUsageHeaders(event.headers, context.sessionManager.getSessionId());
		// Lazy API loading or catalog refresh can recompose effective providers
		// between auxiliary calls that have no before_agent_start boundary.
		usageObservers.ready(context);
	});
	const generic = (context: ExtensionContext) => resolveCompactionModelPolicy(pi, context).hasSelectors;
	const route = (model: Model<any>, options: ProviderStreamOptions | SimpleStreamOptions) => routeDigest({ model, apiKey: options.apiKey, headers: options.headers, env: options.env });
	const unchanged = (branch: readonly SessionEntry[], length: number, hash: string) => branch.length >= length && digest(branch.slice(0, length)) === hash && !branch.slice(length).some((entry) => entry.type === "context_edit");

	const cacheState = (context: ExtensionContext) => {
		let reason: string | undefined;
		if (!configuration().cachedSummaries) reason = "cached summaries disabled";
		else if (generic(context)) reason = "explicit compaction model takes precedence";
		else if (cache && !observer?.isInstalled()) reason = "request observer no longer owned";
		else if (cache && (cache.sessionId !== context.sessionManager.getSessionId() || context.model?.id !== cache.model.id || context.model?.provider !== cache.model.provider || context.model?.api !== cache.model.api || context.modelRegistry.getProvider(cache.model.provider) !== cache.provider || !unchanged(context.sessionManager.getBranch(), cache.branchLength, cache.branchHash))) reason = "cache snapshot no longer matches session/model/history";
		return requestCacheState(cache, reason);
	};
	const removeCacheState = pi.events.on("pi-provider-compaction:cache-state", (request) => {
		if (!isObject(request) || !isObject(request.context) || typeof request.respond !== "function") return;
		try { request.respond(cacheState(request.context as unknown as ExtensionContext)); } catch { /* Stale requester. */ }
	});
	const removeExpiry = pi.events.on("pi-provider-compaction:compact-before-expiry", (request) => {
		if (!isObject(request) || !isObject(request.context) || typeof request.respond !== "function" || typeof request.run !== "function" || typeof request.isCurrent !== "function") return;
		const context = request.context as unknown as ExtensionContext;
		const run = request.run as () => Promise<boolean>;
		const authorized = request.isCurrent as () => boolean;
		const execute = async () => {
			const state = cacheState(context);
			if (expiryAttempt || !state.available || state.cycle !== request.cycle || state.expiresAt === undefined || Date.now() >= state.expiresAt || !context.isIdle() || context.hasPendingMessages() || !authorized()) return false;
			const ticket = generation;
			const attempt: ExpiryAttempt = {
				sessionId: context.sessionManager.getSessionId(), cycle: state.cycle,
				isCurrent: () => {
					try {
						return expiryAttempt === attempt && generation === ticket &&
							context.sessionManager.getSessionId() === attempt.sessionId &&
							!context.hasPendingMessages() && authorized();
					} catch { return false; }
				},
			};
			expiryAttempt = attempt;
			try { return await run(); }
			finally { if (expiryAttempt === attempt) expiryAttempt = undefined; }
		};
		request.respond(execute());
	});
	pi.on("session_shutdown", () => { removeCacheState(); removeExpiry(); });

	const observe: ObserveRequest = (model, context, options) => {
		const owner = ctx;
		if (!owner) return;
		let manager: ExtensionContext["sessionManager"];
		try { manager = owner.sessionManager; }
		catch {
			// Bare SDK dispose() invalidates contexts without session_shutdown.
			// Retire the owned registration before dispatching another session.
			retire();
			return;
		}
		if (options.sessionId !== manager.getSessionId()) return;
		if (compactionRequest) return;
		if (!supportsNativeCompaction(model) && !supportsCachedSummary(model)) { captureRejected("unsupported API"); return; }
		if (!options.onPayload) {
			// The portable-summary request re-enters this observer without a payload
			// callback. Do not overwrite the main request's capture diagnostic.
			if (captureStatus !== "eligible prepared request captured") captureRejected("no payload callback");
			return;
		}
		if (generic(owner)) { captureRejected("generic compaction model takes precedence"); return; }
		// The Azure adapter also accepts API-specific overrides and process-env
		// fallbacks. Those must not silently select a route absent from our evidence.
		if (!supportedRouteOptions(model, options)) { captureRejected("unsupported route overrides"); return; }
		const ticket = generation;
		const startedAt = Date.now();
		const sequence = ++requestSequence;
		const config = configuration();
		const effectiveOptions = { ...options, ...(config.cacheRetention === undefined ? {} : { cacheRetention: config.cacheRetention }) };
		let candidate: CachedRequest | undefined;
		const branch = manager.getBranch();
		const branchHash = digest(branch);
		const canonical = transcript(manager.buildSessionProjection().messages);
		const current = () => {
			if (sequence !== requestSequence || generation !== ticket || ctx !== owner || options.signal?.aborted || !supportedRouteOptions(model, options)) return false;
			try { return unchanged(owner.sessionManager.getBranch(), branch.length, branchHash); }
			catch { retire(); return false; }
		};
		const handler = async (payload: unknown) => {
			if (!current()) return payload;
			snapshot = undefined;
			const auth = await owner.modelRegistry.getApiKeyAndHeaders(model);
			if (!current()) return payload;
			// A registry lookup after payload hooks must describe the credentials used by
			// THIS request, not a newly rotated account. Header/env rewrites without an
			// exact auth correspondence are deliberately ineligible.
			const normalizedHeaders = (headers: ProviderHeaders | undefined) => Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => String(a).localeCompare(String(b)));
			if (!auth.ok || generic(owner) || auth.apiKey !== options.apiKey || (auth.baseUrl ?? model.baseUrl) !== model.baseUrl || !equal(normalizedHeaders(auth.headers), normalizedHeaders(options.headers)) || !equal(auth.env ?? {}, options.env ?? {})) {
				active = undefined; cache = undefined;
				captureRejected("resolved auth/route differs from prepared request, or generic policy changed");
				return payload;
			}
			const provider = owner.modelRegistry.getProvider(model.provider);
			if (!provider) { captureRejected("provider unavailable"); return payload; }
			const routeHash = route(model, options);
			if (config.cachedSummaries && supportsCachedSummary(model)) {
				const warming = options.maxTokens === 1 && cache && cache.authHash === routeDigest(auth) && sameCachedPrompt(cache.payload, payload) && equal(cache.context, context);
				candidate = warming ? { ...cache!, startedAt, cycle: randomUUID(), usage: undefined, expiresAt: undefined } : captureCachedRequest({
					model, provider, context, canonical, options: effectiveOptions, startedAt,
					sessionId: manager.getSessionId(), branchLength: branch.length, branchHash, authHash: routeDigest(auth),
				}, payload);
				if (!warming) cache = undefined;
			}
			if (!supportsNativeCompaction(model)) { captureStatus = candidate ? "eligible cached request captured" : "cached request ineligible"; return payload; }
			const prepared = capturePreparedRequest(model, context, canonical, payload, captureRejected);
			if (!prepared) { active = undefined; return payload; }
			const policyHash = digest(requestPolicy(model, prepared));
			const latest = latestCompaction(branch);
			const payloadModel = isObject(payload) && typeof payload.model === "string" ? payload.model : undefined;
			let result = payload;
			if (active && latest?.id === active.entryId && latest.summary === active.summary && active.payloadModel === payloadModel && unchanged(branch, active.branchLength, active.branchHash) && active.routeHash === routeHash && active.policyHash === policyHash) {
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
						// The actual request contains opaque state, not the captured readable prefix.
						candidate = undefined; cache = undefined;
					} else active = undefined;
				} else active = undefined;
			} else active = undefined;
			captureStatus = "eligible prepared request captured";
			snapshot = {
				prepared, model: structuredClone(model), provider,
				options: { apiKey: options.apiKey, headers: structuredClone(options.headers), env: structuredClone(options.env), fetch: options.fetch, ...(typeof (options as { serviceTier?: unknown }).serviceTier === "string" ? { serviceTier: (options as { serviceTier: string }).serviceTier } : {}) },
				branchLength: branch.length, branchHash, routeHash, authHash: routeDigest(auth), policyHash,
				sessionId: owner.sessionManager.getSessionId(),
			};
			return result;
		};
		return Object.assign(handler, {
			cacheRetention: config.cacheRetention,
			complete: (message: Parameters<typeof finishCachedRequest>[1]) => {
				if (!candidate || sequence !== requestSequence || !current()) return;
				finishCachedRequest(candidate, message);
				if (candidate.usage) cache = candidate;
			},
		});
	};

	const install = (context: ExtensionContext) => {
		ctx = context;
		if (observer?.provider === context.model?.provider && observer?.api === context.model?.api && observer?.isInstalled()) return;
		if (observer) { invalidate(); observer.remove(); observer = undefined; }
		if (!supportsNativeCompaction(context.model) && !supportsCachedSummary(context.model)) return;
		observer = installObserver(pi, context, observe);
		captureStatus = observer ? "awaiting prepared request" : "unsupported provider registration";
	};
	pi.on("session_start", (_event, context) => {
		retire();
		usageObservers.dispose();
		usageObservers = serveUsageObservers(pi, () => ctx);
		install(context);
		usageObservers.ready(context);
		const sessionId = context.sessionManager.getSessionId();
		// AgentSession.dispose() cleans session resources even without emitting
		// session_shutdown. The captured registry keeps owned cleanup usable.
		unregisterCleanup = registerSessionResourceCleanup((disposedId) => {
			if (disposedId === undefined || disposedId === sessionId) { retire(); usageObservers.dispose(); }
		});
		const latest = latestCompaction(context.sessionManager.getBranch());
		if (latest?.summary === NATIVE_COMPACTION_SUMMARY) context.ui.notify("Legacy native compaction has no portable summary. Native replay is disabled; recover from earlier history or start a new session.", "warning");
	});
	pi.on("before_agent_start", (_event, context) => { install(context); usageObservers.ready(context); });
	pi.on("model_select", (_event, context) => { invalidate(); install(context); usageObservers.ready(context); });
	pi.on("session_tree", () => { invalidate(); });
	pi.on("session_shutdown", () => { retire(); usageObservers.dispose(); });
	// Privacy-policy owners must invalidate before changing a policy that can affect
	// hidden covered history. Arbitrary dynamic privacy compositions are unsupported.
	const removeInvalidation = pi.events.on("pi-provider-compaction:invalidate", invalidate);
	pi.on("session_shutdown", () => { if (typeof removeInvalidation === "function") removeInvalidation(); });

	pi.on("session_before_compact", async (event, context) => {
		const began = Date.now();
		compactionStatus = "preparing compaction";
		fallbackReason = undefined;
		const attempt = expiryAttempt;
		const capture = snapshot;
		const cached = cacheState(context).available ? cache : undefined;
		snapshot = undefined; cache = undefined; pending = undefined;
		const cancelled = (usage?: Usage, reason = "compaction ownership or input changed") => {
			lastOutcome = { path: attempt ? "expiry cancelled" : "cancelled", elapsedMs: Date.now() - began, usage, reason };
			return { cancel: true as const };
		};
		const reject = (reason: string) => {
			fallback(reason);
			return attempt ? cancelled(undefined, reason) : undefined;
		};
		// The provider may run before the companion's handler. Share its live
		// ownership/input guard instead of paying for work that a later handler cancels.
		if (attempt) {
			if (event.reason !== "manual" || !attempt.isCurrent() || !cached || cached.cycle !== attempt.cycle || attempt.signal && attempt.signal !== event.signal) return reject("idle transaction no longer authorized");
			attempt.signal = event.signal;
		}
		if ((!capture && !cached) || !context.model || generic(context) || event.signal.aborted) return reject("no eligible snapshot, explicit model override, or aborted attempt");
		const ticket = generation;
		const branch = context.sessionManager.getBranch();
		const branchHash = digest(branch);
		const source = cached ?? capture!;
		if (context.sessionManager.getSessionId() !== source.sessionId || !equal(branch, event.branchEntries) || !unchanged(branch, source.branchLength, source.branchHash)) return reject("history/session changed since capture");
		const current = () => ticket === generation && !event.signal.aborted && (!attempt || attempt.isCurrent()) && supportedRouteOptions(source.model, source.options) && !generic(context) &&
			context.model?.id === source.model.id && context.model?.provider === source.model.provider && context.model?.api === source.model.api &&
			observer?.isInstalled() === true && context.modelRegistry.getProvider(source.model.provider) === source.provider && unchanged(context.sessionManager.getBranch(), branch.length, branchHash);
		const auth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
		if (!current()) return cancelled();
		if (!auth.ok || routeDigest(auth) !== source.authHash) return reject("auth changed since capture");
		const protocol = capture ? resolveNativeProtocol(context.model) : undefined;
		let input: ResponseItem[] | undefined;
		if (capture && protocol && unchanged(branch, capture.branchLength, capture.branchHash) && source.authHash === capture.authHash) {
			const projection = context.sessionManager.buildSessionProjection();
			const boundary = projection.entries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
			if (boundary >= 0) input = selectCoveredPrefix(capture.model, capture.prepared, transcript(projection.entries.slice(0, boundary).flatMap((entry) => entry.messages)), fallback);
		}
		let portable: Awaited<ReturnType<typeof compact>> | undefined;
		let attemptedUsage: Usage | undefined;
		let summaryPath = "standard";
		let summaryReason: string | undefined;
		if (cached) {
			compactionStatus = "generating cached portable summary";
			compactionRequest = true;
			try {
				const result = await cachedSummary(cached, context, event.preparation, event.customInstructions, event.signal, current);
				portable = result.result;
				attemptedUsage = result.usage;
				summaryReason = result.reason;
				if (portable) summaryPath = "cached";
			} finally { compactionRequest = false; }
			if (!current()) return cancelled(attemptedUsage);
		}
		if (!portable) {
			if (attempt) return cancelled(attemptedUsage, summaryReason ?? "warm cache unavailable");
			// Without native coverage or a dispatched cached attempt, Pi can own fallback.
			if (!input && !attemptedUsage) return reject(summaryReason ?? fallbackReason ?? "native coverage unavailable");
			compactionStatus = "generating portable summary";
			try {
				portable = await compact(event.preparation, source.model, auth.apiKey, auth.headers as Record<string, string> | undefined, event.customInstructions, event.signal, context.thinkingLevel, source.provider.streamSimple.bind(source.provider), auth.env, undefined, undefined, source.sessionId);
				portable = withFileTracking(portable, event.preparation);
				portable.usage = combineUsage(attemptedUsage, portable.usage);
			} catch {
				if (!current()) return cancelled(attemptedUsage);
				return reject("portable summary generation failed");
			}
		}
		if (!current() || !portable.summary.trim() || portable.summary === NATIVE_COMPACTION_SUMMARY) return cancelled(portable.usage);
		const outcome = (path: string, result: typeof portable, reason?: string) => {
			lastOutcome = { path, elapsedMs: Date.now() - began, usage: result!.usage, reason };
			result!.details = { ...(isObject(result!.details) ? result!.details : {}), providerCompaction: lastOutcome };
			return { compaction: result! };
		};
		if (!capture || !protocol || !input) {
			compactionStatus = `${summaryPath} portable summary prepared`;
			return outcome(summaryPath, portable, summaryReason);
		}
		try {
			const freshAuth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
			if (!current()) return cancelled(portable.usage);
			if (!freshAuth.ok || routeDigest(freshAuth) !== capture.authHash) { fallback("auth changed after portable generation"); return outcome(summaryPath, portable, "native auth changed"); }
			compactionStatus = "requesting native checkpoint";
			let native: Awaited<ReturnType<typeof requestProviderCompaction>>;
			compactionRequest = true;
			try {
				native = await requestProviderCompaction({
					provider: capture.provider, model: capture.model, context: capture.prepared.context,
					input, preparedPayload: capture.prepared.payload, protocol,
					apiKey: capture.options.apiKey, headers: capture.options.headers, env: capture.options.env,
					signal: event.signal, isCurrent: current, fetch: capture.options.fetch, sessionId: source.sessionId,
					...(capture.options.serviceTier === undefined ? {} : { serviceTier: capture.options.serviceTier }),
				});
			} finally { compactionRequest = false; }
			if (!current()) return cancelled(combineUsage(native.usage, portable.usage));
			const finalAuth = await context.modelRegistry.getApiKeyAndHeaders(context.model);
			if (!current()) return cancelled(combineUsage(native.usage, portable.usage));
			if (!finalAuth.ok || routeDigest(finalAuth) !== capture.authHash) {
				// The checkpoint is no longer safe to commit, but both requests
				// completed and their known usage still belongs in the session.
				portable.usage = combineUsage(native.usage, portable.usage);
				fallback("auth changed after native generation");
				return outcome(summaryPath, portable, "native auth changed");
			}
			const details: NativeCompactionDetails = {
				...(isObject(portable.details) ? portable.details : {}),
				type: NATIVE_COMPACTION_TYPE, version: 3, provider: capture.model.provider, api: capture.model.api, model: capture.model.id,
				protocol, identity: identity(capture.model, capture.options), output: native.output,
				nativeUsage: native.usage, portableUsage: portable.usage,
				coverage: { kind: "summarized-prefix", firstKeptEntryId: portable.firstKeptEntryId, sourceLeafId: branch.at(-1)!.id, sourceHash: branchHash, policyHash: capture.policyHash, inputHash: digest(input), runtimeId },
			};
			const result = outcome(`${summaryPath} + native`, { ...portable, usage: combineUsage(native.usage, portable.usage), details }, summaryReason);
			pending = { details: result.compaction.details as NativeCompactionDetails, capture, summary: portable.summary };
			return result;
		} catch (error) {
			if (!current()) return cancelled(error instanceof NativeCompactionValidationError ? combineUsage(error.usage, portable.usage) : portable.usage);
			fallback("native acquisition or validation failed");
			if (error instanceof NativeCompactionValidationError && error.usage !== undefined) portable.usage = combineUsage(error.usage, portable.usage);
			return outcome(summaryPath, portable, "native acquisition or validation failed");
		}
	});
	pi.on("session_compact", (event, context) => {
		const recorded = isObject(event.compactionEntry.details) ? event.compactionEntry.details.providerCompaction : undefined;
		const owned = isObject(recorded) && equal(recorded, lastOutcome);
		if (readNativeCompactionDetails(event.compactionEntry.details)?.version === 3) compactionStatus = "native checkpoint committed";
		else if (fallbackReason) compactionStatus = `portable: ${fallbackReason}`;
		else if (owned) compactionStatus = `${lastOutcome!.path} portable summary committed`;
		else fallback("another handler supplied the committed result");
		if (owned) {
			if (configuration().outcomeNotifications && lastOutcome) context.ui.notify(`Compacted via ${lastOutcome.path} in ${(lastOutcome.elapsedMs / 1000).toFixed(1)}s${lastOutcome.usage ? `; cache read ${lastOutcome.usage.cacheRead}, write ${lastOutcome.usage.cacheWrite}; estimated cost $${lastOutcome.usage.cost.total.toFixed(6)}` : ""}`, "info");
		} else lastOutcome = { path: "Pi/other handler", elapsedMs: 0, usage: event.compactionEntry.usage, reason: compactionStatus };
		// Only static diagnostics are persisted, never request/auth data or error text.
		if (fallbackReason) pi.appendEntry("pi-provider-compaction:diagnostic", { status: `portable: ${fallbackReason}` });
		active = undefined; snapshot = undefined; cache = undefined;
		const candidate = pending; pending = undefined;
		if (!candidate || !equal(event.compactionEntry.details, candidate.details) || event.compactionEntry.summary !== candidate.summary) return;
		const branch = context.sessionManager.getBranch();
		const coverage = candidate.details.coverage;
		const index = branch.findIndex((entry) => entry.id === event.compactionEntry.id);
		if (!coverage || index < 0 || event.compactionEntry.firstKeptEntryId !== coverage.firstKeptEntryId || event.compactionEntry.parentId !== coverage.sourceLeafId || digest(branch.slice(0, index)) !== coverage.sourceHash) return;
		active = {
			entryId: event.compactionEntry.id,
			summary: candidate.summary,
			branchLength: index + 1,
			branchHash: digest(branch.slice(0, index + 1)),
			routeHash: candidate.capture.routeHash,
			policyHash: candidate.capture.policyHash,
			...(typeof candidate.capture.prepared.payload.model === "string" ? { payloadModel: candidate.capture.prepared.payload.model } : {}),
		};
	});
	pi.on("session_compact_failed", () => { pending = undefined; snapshot = undefined; cache = undefined; compactionStatus = "compaction failed or cancelled"; });
}
