import type { Model, Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

// One coding task, not a recall-only greeting. The decisive failure is beyond
// Pi's ordinary 2,000-character tool excerpt, and is not restated by an assistant.
export const fixtureId = "retry-after-supersession-and-late-failure";
export const expectedAnswer = {
	delayCapMs: 1250,
	jitter: false,
	authorizedToDeploy: false,
	publicSignature: "parseRetryAfter(value: string, nowMs: number): number",
	failingTest: "http-date-rollover-Z92Q",
	nextEdit: "clamp-negative-to-zero",
	verificationComplete: false,
};
export const continuation = `Resume the Retry-After task from the checkpoint. Do not call tools or invent completed work. Return only one JSON object, with keys delayCapMs (number), jitter (boolean), authorizedToDeploy (boolean), publicSignature (the exact TypeScript signature), failingTest (the exact last failing test name), nextEdit (the pending edit's kebab-case label), verificationComplete (boolean).`;
export const focus = "Preserve current user constraints, superseded decisions versus final decisions, exact public interfaces, last failing test evidence, and unfinished work. Distinguish verified actions from plans.";
export const warmups = [
	"Pause the Retry-After work. Reply only Ready; do not repeat findings or change files.",
	"Continue waiting for the next task. Reply only Ready; this is not new implementation or deployment authorization.",
];
const zero: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const portableFixture = `## Goal
Fix Retry-After parsing in src/retry.ts without dependencies.
## Constraints
Do not deploy or change public parseRetryAfter signature. Preserve existing exports.
parseRetryAfter(value: string, nowMs: number): number
## Decisions
Superseded: 60000ms cap with jitter. Final: 1250ms cap, no jitter.
## Progress
Inspected source and tests. No patch applied; verification is not complete.
## Next steps
Last failure: http-date-rollover-Z92Q returned -1250, expected 0. src/retry.ts:41 returns parsedDate - nowMs. Pending edit: clamp-negative-to-zero, then rerun tests. 70 passed, 1 failed.
`;
export function seed(manager: SessionManager, model: Model<any>) {
	let timestamp = 0;
	const user = (content: string) => manager.appendMessage({ role: "user", content, timestamp: ++timestamp });
	const assistant = (text: string) => manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text }], usage: zero, stopReason: "stop", timestamp: ++timestamp });
	user("Fix Retry-After parsing in src/retry.ts without adding dependencies. Do not deploy or change public parseRetryAfter signature. The public signature is parseRetryAfter(value: string, nowMs: number): number. Inspect source and tests first; preserve existing exports.");
	assistant("Initial proposal: use a 60000ms delay cap and randomized jitter. I have not implemented it.");
	user("Supersede that proposal: use a fixed 1250ms cap, no jitter. First diagnose the date-parsing regression, then patch it and rerun the test. No deployment is authorized.");
	manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "inspect-retry", name: "read", arguments: { path: "synthetic-retry-diagnostic.txt" } }], usage: zero, stopReason: "toolUse", timestamp: ++timestamp });
	const output = `Source excerpt: src/retry.ts exports parseRetryAfter(value: string, nowMs: number): number. Numeric seconds parsing already works.\n` + Array.from({ length: 70 }, (_, i) => `PASS unrelated existing retry fixture ${i + 1}: numeric-seconds branch preserved; harness setup and teardown completed.\n`).join("") + `\nFINAL DIAGNOSTIC: FAIL http-date-rollover-Z92Q: expired HTTP date returned -1250; expected 0. Root cause: src/retry.ts:41 returns parsedDate - nowMs without clamping. Pending edit label: clamp-negative-to-zero. No patch applied. Test run: 70 passed, 1 failed. No verification after the fix exists.\n`;
	const lateEntryId = manager.appendMessage({ role: "toolResult", toolCallId: "inspect-retry", toolName: "read", content: [{ type: "text", text: output }], isError: false, timestamp: ++timestamp });
	assistant("Inspection finished. I have not edited files or rerun verification. Waiting before making the pending change.");
	return { lateEntryId, lateFactOffset: output.indexOf("http-date-rollover-Z92Q"), toolOutputCharacters: output.length };
}

// These are deliberately literal witnesses, not a semantic grade of a summary.
export function literalFacts(text: string) {
	return Object.fromEntries([
		["finalCap", "1250"], ["supersededCap", "60000"],
		["deploymentConstraint", "Do not deploy"], ["noJitter", "no jitter"],
		["publicSignature", expectedAnswer.publicSignature], ["lateFailure", expectedAnswer.failingTest],
		["pendingEdit", expectedAnswer.nextEdit], ["negativeObserved", "-1250"],
	].map(([key, value]) => [key!, text.includes(value!)]));
}
export function gradeAnswer(text: string) {
	try {
		const answer = JSON.parse(text);
		const fields = Object.fromEntries(Object.entries(expectedAnswer).map(([key, value]) => [key, answer?.[key] === value]));
		return { validJson: true, fields, passed: Object.values(fields).every(Boolean) };
	} catch { return { validJson: false, fields: {}, passed: false }; }
}
