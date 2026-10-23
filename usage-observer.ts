import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installObserver, type InstalledObserver } from "./provider";

const REQUEST = "pi-provider-compaction:observe-usage";
const READY = "pi-provider-compaction:usage-observer-ready";
type ModelKey = { provider: string; id: string };
type PriceUsage = (timestamp: number, usage: Usage) => void;
interface UsageRequest {
	context: ExtensionContext;
	model: NonNullable<ExtensionContext["model"]>;
	priceFor(model: ModelKey): PriceUsage;
	respond(observer: InstalledObserver | undefined): void;
	handled?: boolean;
}

/** Share the existing stream owner, rather than stacking competing pricing wrappers. */
export function serveUsageObservers(pi: ExtensionAPI, current: () => ExtensionContext | undefined) {
	const leases = new Set<InstalledObserver>();
	const remove = pi.events.on(REQUEST, (value) => {
		const request = value as Partial<UsageRequest> | undefined;
		const owner = current();
		if (!owner || !request || request.handled || !request.context || !request.model || typeof request.priceFor !== "function" || typeof request.respond !== "function") return;
		try {
			if (request.context.modelRegistry !== owner.modelRegistry || request.context.sessionManager.getSessionId() !== owner.sessionManager.getSessionId()) return;
			request.handled = true;
			const sessionId = owner.sessionManager.getSessionId();
			const installed = installObserver(pi, { model: request.model, modelRegistry: owner.modelRegistry }, (model, _context, _options, scope) => {
				// The SDK header event identifies the owner even when a branch
				// summary has an independent routing id. Sample policy at dispatch.
				const price = request.priceFor!({ provider: model.provider, id: model.id });
				return Object.assign((payload: unknown) => payload, { priceUsage: (message: { timestamp: number; usage: Usage }) => {
					if (scope.sessionId === sessionId) price(message.timestamp, message.usage);
				} });
			});
			if (!installed) { request.respond(undefined); return; }
			const lease: InstalledObserver = {
				provider: installed.provider,
				api: installed.api,
				isInstalled: () => installed.isInstalled(),
				remove() { leases.delete(lease); installed.remove(); },
			};
			leases.add(lease);
			request.respond(lease);
		} catch { /* Optional cost estimates must not veto a provider request. */ }
	});
	return {
		ready(context: ExtensionContext) { pi.events.emit(READY, { context }); },
		clear() { for (const lease of leases) lease.remove(); },
		dispose() { remove(); for (const lease of leases) lease.remove(); },
	};
}
