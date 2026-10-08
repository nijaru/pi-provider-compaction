import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { readCompactionModelFlagFromArgv, resolveCompactionModelPolicy } from "../policy";
import type { CompactionModelPolicy } from "../policy";

type PolicyContext = Parameters<typeof resolveCompactionModelPolicy>[1];
// Optional drift detection supplements, but never gates, this repository's contracts.
const siblingPath = new URL("../../pi-compactor/policy.ts", import.meta.url);
const readModelSelectors: ((pi: { getFlag(name: string): unknown }, ctx: PolicyContext) => string[]) | undefined =
	existsSync(siblingPath) ? createRequire(import.meta.url)(fileURLToPath(siblingPath)).readModelSelectors : undefined;

let agentDir: string;
let projectDir: string;
let previousOverride: string | undefined;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-pc-policy-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "pi-pc-policy-project-"));
	previousOverride = process.env.PI_COMPACTOR_AGENT_DIR;
	process.env.PI_COMPACTOR_AGENT_DIR = agentDir;
});
afterEach(() => {
	if (previousOverride === undefined) delete process.env.PI_COMPACTOR_AGENT_DIR;
	else process.env.PI_COMPACTOR_AGENT_DIR = previousOverride;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

function writeAgentPolicy(models: unknown) {
	writeFileSync(join(agentDir, "compaction-policy.json"), JSON.stringify({ models }));
}
function writeProjectPolicy(models: unknown, resources = true) {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	if (resources) writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
	writeFileSync(join(projectDir, ".pi", "compaction-policy.json"), JSON.stringify({ models }));
}
function context(trusted = true): PolicyContext {
	return { cwd: projectDir, isProjectTrusted: () => trusted };
}
function checkPolicy(argv: string[], expected: CompactionModelPolicy, selectors: string[], ctx = context()) {
	expect(resolveCompactionModelPolicy({ getFlag: () => undefined }, ctx, argv)).toEqual(expected);
	if (readModelSelectors) {
		const value = readCompactionModelFlagFromArgv(argv);
		expect(readModelSelectors({ getFlag: () => value }, ctx)).toEqual(selectors);
	}
}
const none = { hasSelectors: false };
const agent = { hasSelectors: true, source: "agent-policy" } as const;
const project = { hasSelectors: true, source: "project-policy" } as const;
const flag = { hasSelectors: true, source: "flag" } as const;

describe("generic-model precedence", () => {
	test("flag forms and last occurrence override both policy files", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"]);
		for (const argv of [["--compaction-model", "cli/model"], ["--compaction-model=cli/model"], ["--compaction-model", "old/model", "--compaction-model=cli/model"]]) {
			expect(readCompactionModelFlagFromArgv(argv)).toBe("cli/model");
			checkPolicy(argv, flag, ["cli/model"]);
		}
	});

	test("argument terminator and bare/whitespace flags leave policy selection intact", () => {
		writeAgentPolicy(["agent/model"]);
		for (const argv of [["--", "--compaction-model", "cli/model"], ["--compaction-model"], ["--compaction-model", "   "]]) {
			checkPolicy(argv, agent, ["agent/model"]);
		}
		for (const next of ["--other-flag", "@prompt.txt"]) {
			expect(readCompactionModelFlagFromArgv(["--compaction-model", next])).toBe(true);
		}
	});

	test("an oversized flag disables selection without rescuing it from a policy", () => {
		writeAgentPolicy(["agent/model"]);
		checkPolicy(["--compaction-model", "x".repeat(513)], none, []);
	});

	test("explicit empty policies stop the search", () => {
		writeAgentPolicy(["agent/model"]);
		checkPolicy([], agent, ["agent/model"]);
		writeProjectPolicy([]);
		checkPolicy([], none, []);
		rmSync(join(projectDir, ".pi", "compaction-policy.json"));
		writeAgentPolicy([]);
		checkPolicy([], none, []);
	});

	test("only trusted project policy takes precedence", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"]);
		checkPolicy([], project, ["project/model"]);
		checkPolicy([], agent, ["agent/model"], context(false));
		checkPolicy([], agent, ["agent/model"], { cwd: projectDir, isProjectTrusted() { throw new Error("stale context"); } });
	});

	test("policy-only projects require saved explicit trust, not a default true context", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"], false);
		checkPolicy([], agent, ["agent/model"]);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		checkPolicy([], project, ["project/model"]);
		checkPolicy([], agent, ["agent/model"], context(false));
	});

	test("malformed and oversized project policies fall back to the agent policy", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"]);
		const path = join(projectDir, ".pi", "compaction-policy.json");
		for (const content of ["{bad json", JSON.stringify({ models: "not an array" }), JSON.stringify({ models: ["project/model"], padding: "x".repeat(65536) })]) {
			writeFileSync(path, content);
			checkPolicy([], agent, ["agent/model"]);
		}
		writeFileSync(join(agentDir, "compaction-policy.json"), "{bad json");
		checkPolicy([], none, []);
	});

	test("invalid selector entries are ignored, and valid ones are trimmed and bounded", () => {
		writeAgentPolicy([null, 42, " ", "x".repeat(513)]);
		checkPolicy([], none, []);
		writeAgentPolicy([" agent/model ", "agent/model", ...Array.from({ length: 10 }, (_, i) => `agent/${i}`)]);
		checkPolicy([], agent, ["agent/model", ...Array.from({ length: 7 }, (_, i) => `agent/${i}`)]);
	});
});
