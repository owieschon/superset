import type { HostServiceContext } from "../types";

/**
 * Fan out completions the store held back while a terminal's subagents were
 * still running (see `TerminalAgentStore.deferStopWhileSubagentsRun`). One
 * per terminal whose roster has drained, so a parent that stopped mid
 * fan-out completes exactly once.
 *
 * No `agent` identity rides along: this is the parent's own deferred Stop,
 * and the renderer's identity binding must not be re-asserted from here.
 */
export function releaseDeferredStops(
	ctx: Pick<HostServiceContext, "eventBus" | "terminalAgentStore">,
	workspaceId: string,
): void {
	for (const released of ctx.terminalAgentStore.releaseSettledStops(
		workspaceId,
	)) {
		ctx.eventBus.broadcastAgentLifecycle({
			workspaceId: released.workspaceId,
			eventType: "Stop",
			terminalId: released.terminalId,
			occurredAt: released.occurredAt,
		});
	}
}
