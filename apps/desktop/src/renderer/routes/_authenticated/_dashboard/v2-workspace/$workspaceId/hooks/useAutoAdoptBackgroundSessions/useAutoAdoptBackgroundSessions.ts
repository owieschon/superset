import type { WorkspaceStore } from "@superset/panes";
import { workspaceTrpc } from "@superset/workspace-client";
import { useEffect } from "react";
import { logStressEvent } from "renderer/lib/performance/stress-instrumentation";
import { getTerminalBackgroundMarkerIdsKey } from "renderer/lib/terminal/terminal-background-intents";
import type { StoreApi } from "zustand/vanilla";
import {
	getAttachedTerminalIdsKey,
	getBackgroundTerminalSessions,
	parseAttachedTerminalIdsKey,
} from "../../components/BackgroundTerminalsButton/BackgroundTerminalsButton.utils";
import type { PaneViewerData } from "../../types";
import { focusOrAddTerminalPane } from "../../utils/focusTerminalPane";
import { resolveAdoptionFocusRestore } from "./resolveAdoptionFocusRestore";

interface UseAutoAdoptBackgroundSessionsArgs {
	store: StoreApi<WorkspaceStore<PaneViewerData>>;
	workspaceId: string;
	isLayoutReady: boolean;
}

/**
 * When a workspace is opened, running terminal daemon sessions that have no
 * pane get their panes created automatically instead of sitting behind the
 * background-terminals dropdown — this is the only surface for sessions
 * launched outside the desktop (e.g. `superset workspaces create --agent …`
 * from the CLI, which writes no pane layout of its own).
 *
 * Gated on pane-layout hydration so the attached-pane check runs against the
 * real layout, not an empty store. The adoption itself is idempotent —
 * already-attached panes are filtered out and re-adoption just focuses the
 * existing pane — so it reruns freely as the session list settles. That's
 * what lets a session that lands slightly after open (a CLI race, a poll
 * refresh) still get a pane, instead of being stranded by a one-shot pass
 * that fired on a premature or empty list. Deliberately backgrounded sessions
 * (marker set) are always skipped.
 *
 * Adoption keeps its hands off a usable active tab, but hands focus to the
 * session it just adopted when that tab holds only terminals the host no
 * longer lists — see `resolveAdoptionFocusRestore`.
 */
export function useAutoAdoptBackgroundSessions({
	store,
	workspaceId,
	isLayoutReady,
}: UseAutoAdoptBackgroundSessionsArgs): void {
	const sessionsQuery = workspaceTrpc.terminal.list.useQuery(
		{ workspaceId },
		{ enabled: isLayoutReady, refetchOnWindowFocus: false },
	);
	const sessions = sessionsQuery.data?.sessions;
	// Don't act on a cached list still being refetched — it may name a session
	// killed while the workspace was closed, which would adopt a ghost pane.
	const isFetchingSessions = sessionsQuery.isFetching;

	useEffect(() => {
		if (!isLayoutReady || !sessions || isFetchingSessions) return;

		const state = store.getState();
		const marked = new Set(
			parseAttachedTerminalIdsKey(
				getTerminalBackgroundMarkerIdsKey(workspaceId),
			),
		);
		const toAdopt = getBackgroundTerminalSessions(
			sessions,
			parseAttachedTerminalIdsKey(getAttachedTerminalIdsKey(state.tabs)),
		).filter((session) => !marked.has(session.terminalId));
		if (toAdopt.length === 0) return;

		// Read against the pre-adoption layout, before the tabs adoption is
		// about to add exist.
		const restoreActiveTabId = resolveAdoptionFocusRestore({
			tabs: state.tabs,
			activeTabId: state.activeTabId,
			liveTerminalIds: sessions.map((session) => session.terminalId),
		});

		// Oldest→newest so tabs read chronologically, which also leaves
		// `addTab`'s focus on the newest adopted session when nothing is
		// restored.
		for (const session of toAdopt.reverse()) {
			focusOrAddTerminalPane(store, session.terminalId);
		}
		if (restoreActiveTabId) {
			store.getState().setActiveTab(restoreActiveTabId);
		}
		logStressEvent("background-terminals.auto-adopt", {
			count: toAdopt.length,
			workspaceId,
		});
	}, [isLayoutReady, isFetchingSessions, sessions, store, workspaceId]);
}
