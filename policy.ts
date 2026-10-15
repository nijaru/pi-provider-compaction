/**
 * An explicit generic model suppresses both native acquisition and replay.
 * Ask pi-compactor for its effective policy first: only the flag's owner can
 * read SDK-injected extensionFlagValues. The event reply is synchronous.
 * Without a companion reply, argv and policy files retain standalone support;
 * their trust, bounds, and empty-policy rules mirror pi-compactor's resolver.
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const COMPACTION_MODEL_FLAG = "compaction-model";
const PROJECT_POLICY = "compaction-policy.json";
const AGENT_DIR_OVERRIDE = "PI_COMPACTOR_AGENT_DIR";
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_MODEL_SELECTORS = 8;
const MAX_SELECTOR_LENGTH = 512;

type PolicyContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted"> & {
	sessionManager?: Pick<ExtensionContext["sessionManager"], "getSessionDir">;
};

export type CompactionModelSource = "compactor" | "flag" | "project-policy" | "agent-policy";

export interface CompactionModelPolicy {
	/** True when a generic compaction model takes precedence over native compaction. */
	hasSelectors: boolean;
	/** Where the selectors were resolved from, for diagnostics. */
	source?: CompactionModelSource;
}

function normalizeSelector(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const selector = value.trim();
	if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) return undefined;
	return selector;
}

function parsePolicySelectors(value: unknown): string[] | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (!("models" in value) || !Array.isArray(value.models)) return undefined;

	const selectors: string[] = [];
	for (const model of value.models) {
		const selector = normalizeSelector(model);
		if (selector === undefined || selectors.includes(selector)) continue;
		selectors.push(selector);
		if (selectors.length === MAX_MODEL_SELECTORS) break;
	}
	return selectors;
}

function readPolicySelectors(configPath: string): string[] | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return undefined;

		// Read a bounded amount from the opened regular file. This avoids both
		// FIFO blocking and a stat/read TOCTOU defeating the size limit.
		const buffer = Buffer.allocUnsafe(MAX_POLICY_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > MAX_POLICY_BYTES) return undefined;
		return parsePolicySelectors(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown);
	} catch {
		// A malformed or unreadable policy must not prevent native compaction.
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The policy is optional; a close failure must not break compaction.
			}
		}
	}
}

function activeAgentDir(ctx: PolicyContext): string {
	const override = process.env[AGENT_DIR_OVERRIDE]?.trim();
	if (override) return resolve(override);

	try {
		const sessionDir = ctx.sessionManager?.getSessionDir();
		if (sessionDir) {
			const resolvedCwd = resolve(ctx.cwd);
			const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const suffix = `${sep}${join("sessions", safePath)}`;
			const resolvedSessionDir = resolve(sessionDir);
			if (resolvedSessionDir.endsWith(suffix)) {
				return resolvedSessionDir.slice(0, -suffix.length);
			}
		}
	} catch {
		// Fall back to Pi's configured directory when the SDK session is custom.
	}
	return getAgentDir();
}

function isProjectPolicyTrusted(ctx: PolicyContext, agentDir: string): boolean {
	try {
		if (!ctx.isProjectTrusted()) return false;
		// Pi does not treat this custom filename as a trust-requiring resource.
		// Also accept an explicit saved trust decision for policy-only projects.
		return hasTrustRequiringProjectResources(ctx.cwd) || new ProjectTrustStore(agentDir).get(ctx.cwd) === true;
	} catch {
		return false;
	}
}

/**
 * Read the shared `--compaction-model` CLI value without registering the flag.
 * Mirrors Pi's unknown-flag parsing: `--compaction-model value` and
 * `--compaction-model=value`; a bare flag yields `true`. Stops at `--`.
 * Last occurrence wins, matching Pi's Map.set behavior.
 */
export function readCompactionModelFlagFromArgv(argv: readonly string[] = process.argv.slice(2)): string | boolean | undefined {
	let value: string | boolean | undefined;
	const prefix = `--${COMPACTION_MODEL_FLAG}=`;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") break;
		if (arg === `--${COMPACTION_MODEL_FLAG}`) {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
				value = next;
				i++;
			} else {
				value = true;
			}
		} else if (arg.startsWith(prefix)) {
			value = arg.slice(prefix.length);
		}
	}
	return value;
}

/** Resolve whether pi-compactor's generic compaction model takes precedence. */
export function resolveCompactionModelPolicy(
	pi: { events: Pick<ExtensionAPI["events"], "emit"> },
	ctx: PolicyContext,
	argv: readonly string[] = process.argv.slice(2),
): CompactionModelPolicy {
	let effective: boolean | undefined;
	pi.events.emit("pi-compactor:resolve-model-policy", {
		context: ctx,
		respond: (hasSelectors: boolean) => { if (typeof hasSelectors === "boolean") effective = hasSelectors; },
	});
	if (effective !== undefined) return effective ? { hasSelectors: true, source: "compactor" } : { hasSelectors: false };

	const argvRaw = readCompactionModelFlagFromArgv(argv);
	if (typeof argvRaw === "string" && argvRaw.trim()) {
		const selector = normalizeSelector(argvRaw);
		return selector ? { hasSelectors: true, source: "flag" } : { hasSelectors: false };
	}
	// A bare or whitespace flag leaves policy files eligible, like pi-compactor.
	// An oversized selector above already returned hasSelectors:false.

	const agentDir = activeAgentDir(ctx);
	const candidates: Array<{ path: string; source: CompactionModelSource }> = [];
	if (isProjectPolicyTrusted(ctx, agentDir)) {
		candidates.push({ path: join(ctx.cwd, CONFIG_DIR_NAME, PROJECT_POLICY), source: "project-policy" });
	}
	candidates.push({ path: join(agentDir, PROJECT_POLICY), source: "agent-policy" });

	for (const candidate of candidates) {
		const selectors = readPolicySelectors(candidate.path);
		// A readable policy stops the search: an empty models list is an
		// explicit choice to use no generic compaction model.
		if (selectors !== undefined) {
			return selectors.length > 0 ? { hasSelectors: true, source: candidate.source } : { hasSelectors: false };
		}
	}
	return { hasSelectors: false };
}
