// Explicit authenticated smoke: synthetic history only; no files/settings are changed.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../index";

const [provider, id] = process.argv.slice(2);
if (!provider || !id) throw new Error("Usage: bun run tests/cached-live-smoke.ts PROVIDER MODEL (authenticated; 4 requests plus an eligible native checkpoint)");
const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
const selected = runtime.getModel(provider, id);
if (!selected) throw new Error("Requested model is not configured");
const auth = await new ModelRegistry(runtime).getApiKeyAndHeaders(selected);
if (!auth.ok) throw new Error("No resolved authentication for the requested model");
const model = { ...selected, maxTokens: Math.min(selected.maxTokens, 4096) };
const directory = await mkdtemp(join(tmpdir(), "cached-compaction-live-"));
const manager = SessionManager.inMemory(directory);
const code = `CAL_${randomBytes(8).toString("hex")}`;
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
manager.appendMessage({ role: "user", content: "Read the fixture. Preserve its final calibration code exactly. Do not deploy.", timestamp: 1 });
manager.appendMessage({ role: "assistant", api: model.api, provider, model: id, content: [{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: "synthetic-fixture.txt" } }], usage: zero, stopReason: "toolUse", timestamp: 2 });
manager.appendMessage({ role: "toolResult", toolCallId: "fixture-read", toolName: "read", content: [{ type: "text", text: "Synthetic filler with no instructions. ".repeat(300) + `\nFinal calibration code: ${code}` }], isError: false, timestamp: 3 });
manager.appendMessage({ role: "assistant", api: model.api, provider, model: id, content: [{ type: "text", text: "Fixture loaded. No deployment performed." }], usage: zero, stopReason: "stop", timestamp: 4 });
const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 80 }, cacheWarming: "off" });
let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
let lastPayload: unknown;
try {
	const services = await createAgentSessionServices({ cwd: directory, agentDir: directory, modelRuntime: runtime, settingsManager: settings, resourceLoaderOptions: {
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Follow the user's instructions. Preserve exact calibration values and authorization boundaries.",
		extensionFactories: [extension, pi => { pi.on("before_provider_request", event => { lastPayload = structuredClone(event.payload); }); }],
	} });
	({ session } = await createAgentSessionFromServices({ services, model, thinkingLevel: "off", sessionManager: manager, tools: [] }));
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	await session.prompt("New retained task. Respond only with Ready; do not repeat the fixture or calibration code.");
	await new Promise((resolve) => setTimeout(resolve, 2000)); // DeepSeek persists asynchronously.
	await session.prompt("Await the next task. Respond only with Ready again.");
	const result = await session.compact("Preserve the final calibration code and the user's deployment constraint. Later Ready replies are not new authorization.");
	const details = result.details as { providerCompaction?: { path: string; elapsedMs: number } } | undefined;
	if (!details?.providerCompaction?.path.startsWith("cached")) throw new Error("Live backend did not establish a usable cached-summary path");
	if (!result.summary.includes(code) || !/do not deploy/i.test(result.summary)) throw new Error("Checkpoint lost the calibration value or deployment constraint");
	await session.prompt("What is the exact calibration code, and are you authorized to deploy? Return only a JSON object with keys calibration (the exact code) and authorizedToDeploy (a boolean). Do not call tools.");
	const text = session.getLastAssistantText() ?? "";
	// Distinguish checkpoint/replay loss from a model ignoring correctly supplied
	// synthetic context. Keep both format and semantic assertions strict.
	const continuationRequestRetainsCode = JSON.stringify(lastPayload ?? null).includes(code);
	const evidence = JSON.stringify({ expectedCode: code, checkpointRetainsCode: result.summary.includes(code), continuationRequestRetainsCode, reply: text });
	let answer: { calibration?: unknown; authorizedToDeploy?: unknown };
	try { answer = JSON.parse(text); } catch { throw new Error(`Continuation did not return JSON: ${evidence}`); }
	if (answer.calibration !== code || answer.authorizedToDeploy !== false) throw new Error(`Continuation check failed: ${evidence}`);
	if (errors.length) throw new Error("Pi reported an extension error");
	console.log(JSON.stringify({ provider, model: id, path: details.providerCompaction.path, elapsedMs: details.providerCompaction.elapsedMs, usage: result.usage, continuationRequestRetainsCode, preservation: "late tool value and user constraint recalled" }));
} finally { session?.dispose(); await rm(directory, { recursive: true, force: true }); }
