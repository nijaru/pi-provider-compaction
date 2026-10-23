import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { readCompactionModelFlagFromArgv, resolveCompactionModelPolicy } from "../policy";
import type { CompactionModelPolicy } from "../policy";

type PolicyContext = Parameters<typeof resolveCompactionModelPolicy>[1];
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
function checkPolicy(argv: string[], expected: CompactionModelPolicy, ctx = context()) {
	expect(resolveCompactionModelPolicy({ events: { emit() {} } }, ctx, argv)).toEqual(expected);
}
const none = { hasSelectors: false };
const agent = { hasSelectors: true, source: "agent-policy" } as const;
const project = { hasSelectors: true, source: "project-policy" } as const;
const flag = { hasSelectors: true, source: "flag" } as const;

describe("generic-model precedence", () => {
	test("the companion's effective scoped policy overrides argv and mirrored files", () => {
		writeAgentPolicy(["agent/model"]);
		const ctx = context();
		for (const hasSelectors of [true, false]) {
			const pi = { events: { emit(name: string, request: any) {
				expect(name).toBe("pi-compactor:resolve-model-policy");
				expect(request.context).toBe(ctx);
				request.respond(hasSelectors);
			} } };
			expect(resolveCompactionModelPolicy(pi, ctx, ["--compaction-model", "argv/model"])).toEqual(
				hasSelectors ? { hasSelectors: true, source: "compactor" } : none,
			);
		}
	});

	test("flag forms and last occurrence override both policy files", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"]);
		for (const argv of [["--compaction-model", "cli/model"], ["--compaction-model=cli/model"], ["--compaction-model", "old/model", "--compaction-model=cli/model"]]) {
			expect(readCompactionModelFlagFromArgv(argv)).toBe("cli/model");
			checkPolicy(argv, flag);
		}
	});

	test("argument terminator and bare/whitespace flags leave policy selection intact", () => {
		writeAgentPolicy(["agent/model"]);
		for (const argv of [["--", "--compaction-model", "cli/model"], ["--compaction-model"], ["--compaction-model", "   "]]) checkPolicy(argv, agent);
		for (const next of ["--other-flag", "@prompt.txt"]) expect(readCompactionModelFlagFromArgv(["--compaction-model", next])).toBe(true);
	});

	test("an oversized flag disables selection without rescuing it from a policy", () => {
		writeAgentPolicy(["agent/model"]);
		checkPolicy(["--compaction-model", "x".repeat(513)], none);
	});

	test("explicit empty policies stop the search", () => {
		writeAgentPolicy(["agent/model"]);
		checkPolicy([], agent);
		writeProjectPolicy([]);
		checkPolicy([], none);
		rmSync(join(projectDir, ".pi", "compaction-policy.json"));
		writeAgentPolicy([]);
		checkPolicy([], none);
	});

	test("only trusted project policy takes precedence", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"]);
		checkPolicy([], project);
		checkPolicy([], agent, context(false));
		checkPolicy([], agent, { cwd: projectDir, isProjectTrusted() { throw new Error("stale context"); } });
	});

	test("policy-only projects require saved explicit trust, not a default true context", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"], false);
		checkPolicy([], agent);
		new ProjectTrustStore(agentDir).set(projectDir, true);
		checkPolicy([], project);
		checkPolicy([], agent, context(false));
	});

	test("malformed and oversized project policies fall back to the agent policy", () => {
		writeAgentPolicy(["agent/model"]);
		writeProjectPolicy(["project/model"]);
		const path = join(projectDir, ".pi", "compaction-policy.json");
		for (const content of ["{bad json", JSON.stringify({ models: "not an array" }), JSON.stringify({ models: ["project/model"], padding: "x".repeat(65536) })]) {
			writeFileSync(path, content);
			checkPolicy([], agent);
		}
		writeFileSync(join(agentDir, "compaction-policy.json"), "{bad json");
		checkPolicy([], none);
	});

	test("only nonempty valid selectors enable a generic-model policy", () => {
		writeAgentPolicy([null, 42, " ", "x".repeat(513)]);
		checkPolicy([], none);
		writeAgentPolicy([" agent/model ", "agent/model"]);
		checkPolicy([], agent);
	});
});
