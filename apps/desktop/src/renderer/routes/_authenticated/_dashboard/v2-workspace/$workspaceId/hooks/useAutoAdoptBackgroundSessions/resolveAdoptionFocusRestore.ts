import type { TerminalPaneData } from "../../types";

interface AdoptionFocusPaneLike {
	kind: string;
	data: unknown;
}

interface AdoptionFocusTabLike {
	id: string;
	panes: Record<string, AdoptionFocusPaneLike>;
}

interface ResolveAdoptionFocusRestoreArgs {
	tabs: readonly AdoptionFocusTabLike[];
	activeTabId: string | null;
	/** Terminal ids the host just reported as live. */
	liveTerminalIds: Iterable<string>;
}

/**
 * A pane the user can still work in. Non-terminal panes always qualify, and so
 * do optimistic `createOnAttach` panes — their session is created by the pane's
 * own attach, so being absent from the host's list is expected rather than
 * evidence of a dead session. A terminal pane whose id the host no longer
 * lists is the only thing this treats as unusable.
 */
function isUsablePane(
	pane: AdoptionFocusPaneLike,
	liveTerminalIds: ReadonlySet<string>,
): boolean {
	if (pane.kind !== "terminal") return true;

	const data = pane.data as Partial<TerminalPaneData> | null | undefined;
	if (!data || typeof data !== "object") return true;
	if (data.createOnAttach) return true;
	// An unreadable id proves nothing about the session, so keep the pane.
	if (typeof data.terminalId !== "string" || data.terminalId.length === 0) {
		return true;
	}

	return liveTerminalIds.has(data.terminalId);
}

/**
 * Which tab auto-adoption hands focus back to, or `null` to leave focus on the
 * pane it just adopted.
 *
 * Adoption must not steal focus from a pane the user can still use, so the
 * pre-adoption active tab wins by default. The exception is a tab holding
 * nothing but terminals the host no longer lists: those sessions are gone for
 * good (disposed or exited), the panes can only render as Disconnected, and
 * restoring such a tab buries the session that was just adopted. Because only
 * the active tab is mounted, a buried adopted pane never attaches at all — it
 * stays untitled and unread, which is what made a live agent look lost.
 *
 * Call this against the pre-adoption layout: the tabs adoption is about to add
 * are live by construction and would always answer "usable".
 */
export function resolveAdoptionFocusRestore({
	tabs,
	activeTabId,
	liveTerminalIds,
}: ResolveAdoptionFocusRestoreArgs): string | null {
	const activeTab = tabs.find((tab) => tab.id === activeTabId);
	if (!activeTab) return null;

	const live = new Set(liveTerminalIds);
	const panes = Object.values(activeTab.panes);
	const isStale =
		panes.length > 0 && panes.every((pane) => !isUsablePane(pane, live));

	return isStale ? null : activeTab.id;
}
