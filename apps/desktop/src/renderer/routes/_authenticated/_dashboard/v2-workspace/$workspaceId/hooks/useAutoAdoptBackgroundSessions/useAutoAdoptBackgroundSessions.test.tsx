import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceState } from "@superset/panes";
import type { PaneViewerData } from "../../types";

// happy-dom over the preloaded plain-object document. Process-wide, so this
// unregisters in afterAll to leave the other renderer suites their document.
const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "workspace-1";

interface SessionSummary {
	terminalId: string;
	workspaceId: string;
	createdAt: number;
	exited: boolean;
	exitCode: number;
	attached: boolean;
	title: string | null;
}

/** What `terminal.list` has answered for this workspace, set per test. */
let listed: { sessions: SessionSummary[] } | undefined;
/** Whether that answer is a cached one still being refetched. */
let isFetchingSessions = false;

// The wire is faked here rather than behind a real React Query client on
// purpose. `V2ProjectSettings.test.tsx` replaces the whole of
// `@tanstack/react-query` with a one-export stub through `mock.module`, which
// is process-wide and permanent for the rest of a `bun test` run and lands
// before this file — so no suite after it can build a working query client.
// Nothing below depends on the query layer anyway: the behaviour under test is
// what the hook does with a settled answer, which is the same answer React
// Query would hand it. Only `workspaceTrpc` is replaced; every other export is
// passed through so later suites keep the real module.
const realWorkspaceClient = await import("@superset/workspace-client");
mock.module("@superset/workspace-client", () => ({
	...realWorkspaceClient,
	workspaceTrpc: {
		terminal: {
			list: {
				useQuery: () => ({ data: listed, isFetching: isFetchingSessions }),
			},
		},
	},
}));

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { createWorkspaceStore } = await import("@superset/panes");
const { clearTerminalBackgroundMarker, markTerminalForBackground } =
	await import("renderer/lib/terminal/terminal-background-intents");
const { useAutoAdoptBackgroundSessions } = await import(
	"./useAutoAdoptBackgroundSessions"
);

afterEach(cleanup);
afterAll(async () => {
	if (!alreadyRegistered) await GlobalRegistrator.unregister();
});

/**
 * Auto-adoption end to end through the hook: the real pane store, the real
 * adoption pass, and the focus rule wired together. `terminal.list` is the
 * host's post-restart truth (daemon-alive sessions joined to workspace rows),
 * so each case below is a `terminal.list` answer paired with a persisted pane
 * layout.
 */

function session(terminalId: string, createdAt = 1): SessionSummary {
	return {
		terminalId,
		workspaceId: WORKSPACE_ID,
		createdAt,
		exited: false,
		exitCode: 0,
		attached: false,
		title: null,
	};
}

type Store = ReturnType<typeof createWorkspaceStore<PaneViewerData>>;
type WorkspaceTab = WorkspaceState<PaneViewerData>["tabs"][number];

function terminalTab(id: string, terminalId: string): WorkspaceTab {
	const paneId = `pane-${id}`;
	return {
		id,
		createdAt: 1,
		activePaneId: paneId,
		layout: { type: "pane", paneId },
		panes: {
			[paneId]: {
				id: paneId,
				kind: "terminal",
				data: { terminalId } as PaneViewerData,
			},
		},
	};
}

function createStore(tabs: WorkspaceTab[] = []): Store {
	return createWorkspaceStore<PaneViewerData>({
		initialState: { version: 1, tabs, activeTabId: tabs[0]?.id ?? null },
	});
}

function activeTerminalId(store: Store): string | null {
	const state = store.getState();
	const active = state.tabs.find((tab) => tab.id === state.activeTabId);
	if (!active) return null;
	for (const pane of Object.values(active.panes)) {
		if (pane.kind !== "terminal") continue;
		const { terminalId } = pane.data as { terminalId?: string };
		if (terminalId) return terminalId;
	}
	return null;
}

function attachedTerminalIds(store: Store): string[] {
	return store
		.getState()
		.tabs.flatMap((tab) =>
			Object.values(tab.panes).map(
				(pane) => (pane.data as { terminalId?: string }).terminalId ?? "",
			),
		)
		.sort();
}

interface AdoptProps {
	store: Store;
	isLayoutReady: boolean;
}

function adopt(store: Store, isLayoutReady = true) {
	return renderHook(
		({ store: current, isLayoutReady: ready }: AdoptProps) =>
			useAutoAdoptBackgroundSessions({
				store: current,
				workspaceId: WORKSPACE_ID,
				isLayoutReady: ready,
			}),
		{ initialProps: { store, isLayoutReady } },
	);
}

beforeEach(() => {
	listed = undefined;
	isFetchingSessions = false;
	for (const id of ["terminal-live", "terminal-old", "terminal-new"]) {
		clearTerminalBackgroundMarker(WORKSPACE_ID, id);
	}
});

describe("useAutoAdoptBackgroundSessions after a restart", () => {
	// A pane persisted with only a terminalId — an adopted or agent pane, which
	// carries no createOnAttach flag — stays in the layout after its PTY is
	// gone, and can still be the active tab on the next open. Nothing recreates
	// it, so the host never lists it again. Because only the active tab mounts,
	// restoring that tab buries the session just adopted and its pane never
	// attaches. This test models that state directly.
	test("dead selected terminal: focus moves to the adopted session", () => {
		const store = createStore([terminalTab("tab-dead", "terminal-dead")]);
		listed = { sessions: [session("terminal-live", 2)] };

		adopt(store);

		expect(activeTerminalId(store)).toBe("terminal-live");
		// The dead pane is kept as history rather than closed.
		expect(attachedTerminalIds(store)).toEqual([
			"terminal-dead",
			"terminal-live",
		]);
	});

	test("live selected terminal: the adopted session does not steal focus", () => {
		const store = createStore([terminalTab("tab-live", "terminal-live")]);
		listed = {
			sessions: [session("terminal-live", 1), session("terminal-extra", 2)],
		};

		adopt(store);

		expect(store.getState().activeTabId).toBe("tab-live");
		expect(attachedTerminalIds(store)).toEqual([
			"terminal-extra",
			"terminal-live",
		]);
	});

	test("empty workspace: the adopted session becomes the active tab", () => {
		const store = createStore();
		listed = { sessions: [session("terminal-live", 2)] };

		adopt(store);

		expect(activeTerminalId(store)).toBe("terminal-live");
		expect(store.getState().tabs).toHaveLength(1);
	});

	// Several sessions launched before the workspace was opened all get panes,
	// and the newest — the one the user most likely just started — is left
	// selected.
	test("several live paneless terminals: all adopted, the newest focused", () => {
		const store = createStore([terminalTab("tab-dead", "terminal-dead")]);
		listed = {
			sessions: [session("terminal-old", 2), session("terminal-new", 3)],
		};

		adopt(store);

		expect(attachedTerminalIds(store)).toEqual([
			"terminal-dead",
			"terminal-new",
			"terminal-old",
		]);
		expect(activeTerminalId(store)).toBe("terminal-new");
	});

	// A session the user deliberately sent to the background is not adopted, so
	// there is nothing to move focus to and the dead tab stays selected.
	test("deliberately backgrounded session: skipped, dead tab left alone", () => {
		const store = createStore([terminalTab("tab-dead", "terminal-dead")]);
		listed = { sessions: [session("terminal-live", 2)] };
		markTerminalForBackground("terminal-live", WORKSPACE_ID);

		adopt(store);

		expect(store.getState().tabs).toHaveLength(1);
		expect(store.getState().activeTabId).toBe("tab-dead");
	});

	// The hook reruns as the session list settles (a socket-open invalidation,
	// a dropdown poll). A rerun must not add a second pane, and must not walk
	// focus back off the session the first pass adopted.
	test("rerun on a fresh answer: no duplicate pane, focus stays adopted", () => {
		const store = createStore([terminalTab("tab-dead", "terminal-dead")]);
		listed = { sessions: [session("terminal-live", 2)] };

		const { rerender } = adopt(store);
		expect(activeTerminalId(store)).toBe("terminal-live");

		act(() => {
			listed = { sessions: [session("terminal-live", 2)] };
		});
		rerender({ store, isLayoutReady: true });

		expect(attachedTerminalIds(store)).toEqual([
			"terminal-dead",
			"terminal-live",
		]);
		expect(activeTerminalId(store)).toBe("terminal-live");
	});

	// The store is empty until the persisted layout is read back, and an empty
	// store answers "no pane attached" for every session. Adopting then would
	// build a second pane for a session the layout already has one for, so the
	// pass waits even though the session list has already settled.
	test("layout not hydrated: nothing is adopted from a settled list", () => {
		const store = createStore();
		listed = { sessions: [session("terminal-live", 2)] };

		adopt(store, false);

		expect(store.getState().tabs).toHaveLength(0);
	});

	test("hydration lands after the answer: the session keeps its one pane", () => {
		listed = { sessions: [session("terminal-live", 1)] };
		const preHydration = createStore();
		const hydrated = createStore([terminalTab("tab-live", "terminal-live")]);

		const { rerender } = adopt(preHydration, false);
		expect(preHydration.getState().tabs).toHaveLength(0);

		rerender({ store: hydrated, isLayoutReady: true });

		expect(attachedTerminalIds(hydrated)).toEqual(["terminal-live"]);
		expect(hydrated.getState().activeTabId).toBe("tab-live");
	});

	// A cached list being refetched can still name a session the host killed
	// while the workspace was closed; adopting it would hand focus to a pane
	// that can only render as Disconnected.
	test("a cached list still refetching is not acted on until it settles", () => {
		const store = createStore([terminalTab("tab-dead", "terminal-dead")]);
		listed = { sessions: [session("terminal-live", 2)] };
		isFetchingSessions = true;

		const { rerender } = adopt(store);
		expect(store.getState().tabs).toHaveLength(1);

		isFetchingSessions = false;
		rerender({ store, isLayoutReady: true });

		expect(activeTerminalId(store)).toBe("terminal-live");
	});
});
