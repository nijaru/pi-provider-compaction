/**
 * Generic-compaction-model precedence resolution shared with pi-compactor.
 *
 * When pi-compactor's generic compaction model is configured — via the
 * `compaction-model` flag or a `compaction-policy.json` file — the explicit
 * generic model takes precedence over provider-native compaction: this
 * extension must not request a native compaction and must not replay a
 * previously persisted native window.
 *
 * Pi scopes `getFlag` to flags the calling extension registered, so this
 * extension registers the same flag name (see index.ts). The policy-file
 * fallback mirrors pi-compactor exactly: project policy requires project
 * trust; the agent-dir policy does not; a valid file with an empty `models`
 * list disables the generic model. This module must stay in sync with
 * `readModelSelectors` in pi-compactor's policy.ts.
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

/** Resolve whether pi-compactor's generic compaction model takes precedence. */
export function resolveCompactionModelPolicy(pi: Pick<ExtensionAPI, "getFlag">, ctx: PolicyContext): CompactionModelPolicy {
	const rawFlag = pi.getFlag(COMPACTION_MODEL_FLAG);
	if (typeof rawFlag === "string" && rawFlag.trim()) {
		const selector = normalizeSelector(rawFlag);
		return selector ? { hasSelectors: true, source: "flag" } : { hasSelectors: false };
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
