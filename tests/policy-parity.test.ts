import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readCompactionModelFlagFromArgv, resolveCompactionModelPolicy } from "../policy";
import type { CompactionModelSource } from "../policy";

// Drift detector for the precedence contract shared with pi-compactor, not a
// dependency on it: skips when the sibling checkout is not present.
const require = createRequire(import.meta.url);
let readModelSelectors: ((pi: any, ctx: any) => string[]) | undefined;
try {
	readModelSelectors = require("../../pi-compactor/policy.ts").readModelSelectors;
} catch {
	readModelSelectors = undefined;
}

const parity = readModelSelectors ? describe : describe.skip;

let agentDir: string;
let projectDir: string;
let previousOverride: string | undefined;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-pc-parity-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "pi-pc-parity-project-"));
	previousOverride = process.env.PI_COMPACTOR_AGENT_DIR;
	process.env.PI_COMPACTOR_AGENT_DIR = agentDir;
});

afterAll(() => {
	if (previousOverride === undefined) delete process.env.PI_COMPACTOR_AGENT_DIR;
	else process.env.PI_COMPACTOR_AGENT_DIR = previousOverride;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

function writeAgentPolicy(models: string[]) {
	writeFileSync(join(agentDir, "compaction-policy.json"), JSON.stringify({ models }));
}

function clearAgentPolicy() {
	rmSync(join(agentDir, "compaction-policy.json"), { force: true });
}

function writeProjectPolicy(models: string[]) {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	// A trust-requiring resource plus isProjectTrusted=true is what both
	// implementations require before reading project policy.
	writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
	writeFileSync(join(projectDir, ".pi", "compaction-policy.json"), JSON.stringify({ models }));
}

function clearProjectPolicy() {
	rmSync(join(projectDir, ".pi", "compaction-policy.json"), { force: true });
}

function ctx(trusted = true) {
	return { cwd: projectDir, isProjectTrusted: () => trusted };
}

/**
 * Feed both implementations from the same argv the way Pi does: Pi populates
 * the shared runtime flag value from CLI args, pi-compactor reads it via its
 * registered getFlag, and this extension re-derives it from process.argv.
 */
function checkAgreement(argv: string[], expectedSource?: CompactionModelSource) {
	const runtimeValue = readCompactionModelFlagFromArgv(argv);
	const selfPi = { getFlag: (_name: string) => undefined };
	const siblingPi = { getFlag: (_name: string) => runtimeValue };
	const mine = resolveCompactionModelPolicy(selfPi as any, ctx(), argv);
	const theirs = readModelSelectors!(siblingPi as any, ctx());
	expect(mine.hasSelectors).toBe(theirs.length > 0);
	if (expectedSource !== undefined) expect(mine.source).toBe(expectedSource);
	return { mine, theirs };
}

parity("precedence parity with pi-compactor", () => {
	test("flag forms agree, last occurrence wins", () => {
		clearAgentPolicy();
		try {
			checkAgreement(["--compaction-model", "openrouter/deepseek/deepseek-v4-flash"], "flag");
			checkAgreement(["--compaction-model=openrouter/deepseek/deepseek-v4-flash"], "flag");
			checkAgreement(
				["--compaction-model", "openrouter/a", "--compaction-model", "openrouter/b"],
				"flag",
			);
		} finally {
			clearAgentPolicy();
		}
	});

	test("args after -- are not flags", () => {
		writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
		try {
			const { mine, theirs } = checkAgreement(["--", "--compaction-model", "openrouter/a"], "agent-policy");
			expect(mine.hasSelectors).toBe(true);
			expect(theirs).toEqual(["openrouter/deepseek/deepseek-v4-flash"]);
		} finally {
			clearAgentPolicy();
		}
	});

	test("agent policy agrees, including the explicit empty-list opt-out", () => {
		try {
			writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
			checkAgreement([], "agent-policy");
			writeAgentPolicy([]);
			const { mine, theirs } = checkAgreement([]);
			expect(mine).toEqual({ hasSelectors: false });
			expect(theirs).toEqual([]);
		} finally {
			clearAgentPolicy();
		}
	});

	test("trusted project policy wins over agent policy", () => {
		writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
		writeProjectPolicy(["openai/gpt-5.2"]);
		try {
			const { mine, theirs } = checkAgreement([], "project-policy");
			expect(mine.hasSelectors).toBe(true);
			expect(theirs).toEqual(["openai/gpt-5.2"]);
		} finally {
			clearProjectPolicy();
			clearAgentPolicy();
		}
	});

	test("untrusted project policy falls back to agent policy on both sides", () => {
		writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
		writeProjectPolicy(["openai/gpt-5.2"]);
		try {
			const runtimeValue = readCompactionModelFlagFromArgv([]);
			const selfPi = { getFlag: (_name: string) => undefined };
			const siblingPi = { getFlag: (_name: string) => runtimeValue };
			const untrusted = { cwd: projectDir, isProjectTrusted: () => false };
			const mine = resolveCompactionModelPolicy(selfPi as any, untrusted, []);
			const theirs = readModelSelectors!(siblingPi as any, untrusted);
			expect(mine).toEqual({ hasSelectors: true, source: "agent-policy" });
			expect(theirs).toEqual(["openrouter/deepseek/deepseek-v4-flash"]);
		} finally {
			clearProjectPolicy();
			clearAgentPolicy();
		}
	});

	test("bare, whitespace, and oversized flags fall through identically", () => {
		writeAgentPolicy(["openrouter/deepseek/deepseek-v4-flash"]);
		try {
			// Bare and whitespace flags fall through to policy files.
			checkAgreement(["--compaction-model"], "agent-policy");
			checkAgreement(["--compaction-model", "   "], "agent-policy");
			// Oversized selectors are rejected without falling through;
			// the agent policy must not rescue them.
			const oversized = `openrouter/${"a".repeat(600)}`;
			const runtimeValue = readCompactionModelFlagFromArgv(["--compaction-model", oversized]);
			expect(runtimeValue).toBe(oversized);
			const selfPi = { getFlag: (_name: string) => undefined };
			const siblingPi = { getFlag: (_name: string) => runtimeValue };
			expect(resolveCompactionModelPolicy(selfPi as any, ctx(), ["--compaction-model", oversized])).toEqual({
				hasSelectors: false,
			});
			expect(readModelSelectors!(siblingPi as any, ctx())).toEqual([]);
		} finally {
			clearAgentPolicy();
		}
	});

	test("malformed policy disables the generic model on both sides", () => {
		writeFileSync(join(agentDir, "compaction-policy.json"), "{not json");
		try {
			const { mine, theirs } = checkAgreement([]);
			expect(mine).toEqual({ hasSelectors: false });
			expect(theirs).toEqual([]);
		} finally {
			clearAgentPolicy();
		}
	});
});
