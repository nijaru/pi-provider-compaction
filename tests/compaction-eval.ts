/** Explicit opt-in evaluation, not a test or a benchmark framework. Synthetic data only. */
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Usage } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../index";
import { continuation, expectedAnswer, fixtureId, focus, gradeAnswer, literalFacts, portableFixture, seed, warmups } from "./compaction-eval-fixture";

const help = `Usage: bun run tests/compaction-eval.ts [--dry-run | --live] [--model all|deepseek|mimo]
  --out PATH                 New JSONL evidence file (required for --live; never overwritten)
  --max-usd NUMBER           Conservative total admission budget, <= 0.50 (default 0.50)
  --max-seconds NUMBER       Whole-run deadline, <= 600 (default 240)
  --max-output-tokens NUMBER Summary cap, 512..2048 (default 1536); reasoning disabled
  --help                     No runtime/auth/network access
Default is offline: real Pi runner and direct adapters, fake SSE; NOT quality evidence.
One case, one ordinary and one cached attempt per selected model, sequentially.
Each arm: two Ready warmups, one summary, one continuation. No retries or fallback calls.
All arms pay their own warmup cost. Cache misses are reported, not retried.
Live routes: deepseek/deepseek-flash and xiaomi/mimo-v2.6-flash only, existing auth.
Codex/native is not run: this harness cannot bound Remote V2 output; no auth is probed.
Cost admission uses $1/M input (including cache) and $4/M output, not cache savings.
Reported SDK catalog cost is an estimate, not an invoice or subscription charge.`;
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log(help); process.exit(0); }
let live = false, dry = false, selection = "all", out: string | undefined;
let maxUsd = 0.5, maxSeconds = 240, summaryCap = 1536;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--live") live = true;
	else if (arg === "--dry-run") dry = true;
	else if (["--out", "--model", "--max-usd", "--max-seconds", "--max-output-tokens"].includes(arg!)) {
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error("Missing CLI value; use --help");
		if (arg === "--out") out = value;
		else if (arg === "--model") selection = value;
		else if (arg === "--max-usd") maxUsd = Number(value);
		else if (arg === "--max-seconds") maxSeconds = Number(value);
		else summaryCap = Number(value);
	} else throw new Error("Unknown CLI option; use --help");
}
if (live && dry || live && !out || !["all", "deepseek", "mimo"].includes(selection) ||
	!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 0.5 ||
	!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 600 ||
	!Number.isInteger(summaryCap) || summaryCap < 512 || summaryCap > 2048) throw new Error("Invalid evaluation bounds; use --help");

const targets = [
	{ name: "deepseek", provider: "deepseek", id: "deepseek-flash", endpoint: "https://api.deepseek.com/chat/completions" },
	{ name: "mimo", provider: "xiaomi", id: "mimo-v2.6-flash", endpoint: "https://api.xiaomimimo.com/v1/chat/completions" },
].filter((target) => selection === "all" || selection === target.name);
type Stage = "setup" | "warmup1" | "warmup2" | "summary" | "continuation";
const started = performance.now();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), maxSeconds * 1000);
const originalFetch = globalThis.fetch;
const file = out ? await open(out, "wx", 0o600) : undefined;
const emit = async (record: object) => {
	const text = JSON.stringify(record) + "\n";
	if (file) await file.write(text);
	console.log(text.trimEnd());
};
let reservedUsd = 0, networkCalls = 0, failures = 0, stop = false;
const totalUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function addUsage(usage: Usage) {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) totalUsage[key] += usage[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) totalUsage.cost[key] += usage.cost[key];
}
function cap(stage: Stage) { return stage === "summary" ? summaryCap : stage === "continuation" ? 512 : 32; }
function fakeSse(stage: Stage) {
	const text = stage === "summary" ? portableFixture : stage === "continuation" ? JSON.stringify(expectedAnswer) : "Ready";
	const chunks = [
		{ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 75 } } },
	];
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "chatcmpl_eval", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

try {
	await emit({ kind: "plan", live, fixtureId, targets: targets.map(({ provider, id }) => ({ provider, model: id })), strategies: ["ordinary", "cached"], maxUsd, maxSeconds, summaryCap, continuationCap: 512, warmupCap: 32, reasoning: "off", attemptsPerArm: 1, admissionRatesPerMillion: { inputAndCache: 1, output: 4 }, native: "skipped: Remote V2 output cannot be bounded here; no Codex auth accessed", costCaveat: "SDK catalog estimates, not invoices; no off-peak/account discounts inferred", dryCaveat: live ? undefined : "Canned fake SSE validates harness plumbing only, not quality or cost" });
	for (const target of targets) for (const strategy of ["ordinary", "cached"] as const) {
		if (stop || controller.signal.aborted) { stop = true; continue; }
		const directory = await mkdtemp(join(tmpdir(), "compaction-eval-"));
		let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		let stage: Stage = "setup";
		let blocked: string | undefined;
		const armStarted = performance.now();
		const requests: { stage: Stage; elapsedMs: number; usage?: Usage; stopReason?: string; payload?: unknown; inputTokenCeiling?: number; reservedUsd?: number; status?: number }[] = [];
		const dispatched = new Set<Stage>();
		let extensionErrors = 0;
		// Admission is at the actual fetch boundary: even an adapter retry or
		// extension's ordinary fallback cannot silently add another paid request.
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const deny = (reason: string): never => { blocked = reason; throw new Error("Evaluation admission denied"); };
			if (controller.signal.aborted) return deny("elapsed-time cap");
			const url = String(input instanceof Request ? input.url : input);
			if (url !== target.endpoint || init?.method !== "POST" || typeof init.body !== "string") return deny("unapproved route or request format");
			const body = JSON.parse(init.body);
			if (body.model !== target.id || !Array.isArray(body.messages)) return deny("model or conversation drift");
			if (body.tools?.length) return deny("unexpected tools");
			if (body.thinking?.type !== "disabled") return deny(body.thinking?.type === "enabled" ? "reasoning unexpectedly enabled" : "reasoning-off not explicit");
			const outputCap = body.max_tokens ?? body.max_completion_tokens;
			if (!Number.isInteger(outputCap) || outputCap < 1 || outputCap > cap(stage)) return deny("missing or excessive output cap");
			if (stage === "setup" || dispatched.has(stage)) return deny("retry or fallback blocked");
			// Byte count is deliberately much larger than a chars/4 estimate. The
			// extra allowance covers message framing/special tokens, not hidden tools.
			const inputTokenCeiling = Buffer.byteLength(init.body) + 4096 + 64 * body.messages.length;
			const charge = (inputTokenCeiling + outputCap * 4) / 1_000_000;
			if (reservedUsd + charge > maxUsd) { stop = true; return deny("cost cap"); }
			const record = requests.at(-1);
			if (!record || record.stage !== stage) return deny("unobserved provider call");
			reservedUsd += charge; networkCalls++; dispatched.add(stage);
			record.inputTokenCeiling = inputTokenCeiling; record.reservedUsd = charge;
			// Only synthetic prompt fields. Never headers, auth, env, or full options.
			record.payload = { model: body.model, messages: body.messages, maxTokens: outputCap, thinking: body.thinking };
			const response = live ? await originalFetch(input, { ...init, redirect: "error", signal: AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : [])]) }) : fakeSse(stage);
			record.status = response.status;
			return response;
		}) as typeof fetch;
		try {
			const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false, modelsStorePath: join(directory, "models-cache.json"), ...(live ? {} : { credentials: new InMemoryCredentialStore(), modelsPath: null }) });
			if (!live) await runtime.setRuntimeApiKey(target.provider, "synthetic-fixture-not-a-key");
			const selected = runtime.getModel(target.provider, target.id);
			if (!selected || selected.api !== "openai-completions" || selected.baseUrl.replace(/\/$/, "") + "/chat/completions" !== target.endpoint) throw new Error("Unsupported configured route");
			if (selected.cost.tiers?.length || [selected.cost.input, selected.cost.output, selected.cost.cacheRead, selected.cost.cacheWrite].some((rate) => !Number.isFinite(rate) || rate < 0) || selected.cost.input > 1 || selected.cost.cacheRead > 1 || selected.cost.cacheWrite > 1 || selected.cost.output > 4) throw new Error("Catalog rates exceed admission ceilings");
			const auth = await new ModelRegistry(runtime).getApiKeyAndHeaders(selected);
			if (!auth.ok) throw new Error("Authentication unavailable");
			const model = { ...selected, maxTokens: summaryCap };
			const manager = SessionManager.inMemory(directory);
			const fixture = seed(manager, model);
			const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 80 }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse" });
			const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, modelRuntime: runtime, settingsManager: settings, resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				systemPrompt: "You are a coding assistant. Follow user constraints. Preserve exact interfaces and test evidence. Distinguish plans from completed verified work.",
				extensionFactories: strategy === "cached" ? [extension] : [],
			} });
			({ session } = await createAgentSessionFromServices({ services, model, thinkingLevel: "off", sessionManager: manager, tools: [] }));
			// SDK service/session construction can recompose configured providers.
			// Lease the final effective object before session_start installs capture.
			const provider = runtime.getProvider(target.provider)!;
			const originalSimple = provider.streamSimple;
			// Separate eval budget, independent of compaction.reserveTokens. This
			// wraps the real adapter; the production extension is not modified.
			provider.streamSimple = function (requested, context, options = {}) {
				const requestStage = stage, start = performance.now();
				const record: typeof requests[number] = { stage: requestStage, elapsedMs: 0 };
				requests.push(record);
				const stream = originalSimple.call(this, { ...requested, maxTokens: cap(requestStage) }, context, {
					...options, maxTokens: cap(requestStage), reasoning: undefined, maxRetries: 0,
					// Configured adapters may omit the thinking field even at level off.
					// Set the eval policy BEFORE incoming hooks/capture, then let the
					// fetch guard reject any later rewrite. Never patch a captured prefix.
					onPayload: async (payload, dispatchedModel) => {
						if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Unsupported eval payload");
						const bounded = { ...payload, thinking: { type: "disabled" } };
						return await options.onPayload?.(bounded, dispatchedModel) ?? bounded;
					},
					signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
				});
				void stream.result().then((message) => {
					record.elapsedMs = performance.now() - start; record.usage = message.usage; record.stopReason = message.stopReason;
					addUsage(message.usage);
					if (message.usage.output > cap(requestStage) || record.inputTokenCeiling !== undefined && message.usage.input + message.usage.cacheRead + message.usage.cacheWrite > record.inputTokenCeiling) { blocked = "reported usage exceeds admission bound"; stop = true; }
				}).catch(() => { record.elapsedMs = performance.now() - start; record.stopReason = "error"; });
				return stream;
			};
			await session.bindExtensions({ onError: () => { extensionErrors++; } });
			const prompt = async (text: string) => {
				await session!.prompt(text);
				const last = session!.messages.at(-1);
				if (!last || last.role !== "assistant" || last.stopReason !== "stop" || blocked) throw new Error("Incomplete provider answer");
			};
			stage = "warmup1"; await prompt(warmups[0]!);
			// Fixed wait, not a retry: DeepSeek's prefix persistence is asynchronous.
			await new Promise((resolve) => setTimeout(resolve, live ? 2000 : 0));
			stage = "warmup2"; await prompt(warmups[1]!);
			stage = "summary";
			const result = await session.compact(focus);
			const branch = manager.getBranch();
			const boundary = branch.findIndex((entry) => entry.id === result.firstKeptEntryId);
			const lateIndex = branch.findIndex((entry) => entry.id === fixture.lateEntryId);
			const lateFactSummarized = boundary > lateIndex && lateIndex >= 0;
			const details = result.details as { providerCompaction?: { path?: string } } | undefined;
			const actualPath = details?.providerCompaction?.path ?? "ordinary";
			const summaryInputLiteralFacts = literalFacts(JSON.stringify(requests.find((request) => request.stage === "summary")?.payload ?? null));
			if (!live && summaryInputLiteralFacts.lateFailure !== (strategy === "cached")) throw new Error("Offline summary-input qualification failed");
			await emit({ kind: "checkpoint", provider: target.provider, model: target.id, strategy, actualPath, fixture, lateFactSummarized, summaryInputLiteralFacts, summary: result.summary, literalFacts: literalFacts(result.summary), usage: result.usage });
			stage = "continuation"; await prompt(continuation);
			const answer = session.getLastAssistantText() ?? "";
			const payloadText = JSON.stringify(requests.find((request) => request.stage === "continuation")?.payload ?? null);
			const answerGrade = gradeAnswer(answer);
			const failureStage = !lateFactSummarized ? "fixture-boundary" : strategy === "cached" && actualPath !== "cached" ? "cached-path-ineligible" : !answerGrade.passed ? "answer-adherence" : extensionErrors || blocked ? "runtime" : null;
			if (failureStage) failures++;
			await emit({ kind: "result", provider: target.provider, model: target.id, strategy, actualPath, elapsedMs: performance.now() - armStarted, continuation: { readableLiteralFacts: literalFacts(payloadText), nativeCoverageProof: "not applicable: portable-only direct API", answer, answerGrade }, failureStage, blocked, extensionErrors, requests });
		} catch {
			failures++;
			await emit({ kind: "failure", provider: target.provider, model: target.id, strategy, failureStage: stage, blocked, extensionErrors, elapsedMs: performance.now() - armStarted, requests, error: "Stage did not complete; backend/auth errors intentionally not persisted" });
		} finally {
			session?.dispose(); globalThis.fetch = originalFetch;
			await rm(directory, { recursive: true, force: true });
		}
	}
	await emit({ kind: "total", live, elapsedMs: performance.now() - started, networkCalls, reservedUsd, maxUsd, usage: totalUsage, failures, stoppedAtCap: stop || controller.signal.aborted });
	if (failures || stop || controller.signal.aborted) process.exitCode = 1;
} finally {
	clearTimeout(timer); globalThis.fetch = originalFetch; await file?.close();
}
