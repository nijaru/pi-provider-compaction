/**
 * Generic-compaction-model precedence resolution shared with pi-compactor.
 *
 * When pi-compactor's generic compaction model is configured — via the
 * `compaction-model` flag or a `compaction-policy.json` file — the explicit
 * generic model takes precedence over provider-native compaction: this
 * extension must not request a native compaction and must not replay a
 * previously persisted native window.
 *
 * Pi scopes `getFlag` to flags the calling extension registered, and Pi
 * rejects two extensions registering the same flag name. This extension
 * therefore never registers `compaction-model` (owned by pi-compactor) and
 * reads the shared CLI value from `process.argv` instead. The policy-file
 * fallback mirrors pi-compactor exactly: project policy requires project
 * trust; the agent-dir policy does not; a valid file with an empty `models`
 * list disables the generic model. This module must stay in sync with
 * `readModelSelectors` in pi-compactor's policy.ts (see
 * tests/policy-parity.test.ts, which checks the two against each other when
 * the sibling checkout is present).
 *
 * Flag-source note (verified against Pi 0.85.1): extension flag values are
 * populated solely from CLI unknown flags (parseArgs in cli/args.js feeds
 * extensionFlagValues in main.js, applied by applyExtensionFlagValues in
 * agent-session-services.js). There is no config-file flag source, so reading
 * process.argv with Pi's exact parsing rules observes every flag value the
 * host can deliver. A programmatic SDK host injecting extensionFlagValues
 * without argv would not be seen here; flag scoping provides no shared read
 * API for that path.
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

export type CompactionModelSource = "flag" | "project-policy" | "agent-policy";

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
	pi: Pick<ExtensionAPI, "getFlag">,
	ctx: PolicyContext,
	argv: readonly string[] = process.argv.slice(2),
): CompactionModelPolicy {
	const argvRaw = readCompactionModelFlagFromArgv(argv);
	if (typeof argvRaw === "string" && argvRaw.trim()) {
		const selector = normalizeSelector(argvRaw);
		return selector ? { hasSelectors: true, source: "flag" } : { hasSelectors: false };
	}
	// A bare `--compaction-model` (true) or whitespace value falls through like
	// pi-compactor: Pi reports "requires a value" and the policy files still apply.
	// An oversized selector above already returned hasSelectors:false.
	try {
		const rawFlag = pi.getFlag(COMPACTION_MODEL_FLAG);
		if (typeof rawFlag === "string" && rawFlag.trim()) {
			const selector = normalizeSelector(rawFlag);
			return selector ? { hasSelectors: true, source: "flag" } : { hasSelectors: false };
		}
	} catch {
		// getFlag can throw on a stale context; fall through to policy files.
	}

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
