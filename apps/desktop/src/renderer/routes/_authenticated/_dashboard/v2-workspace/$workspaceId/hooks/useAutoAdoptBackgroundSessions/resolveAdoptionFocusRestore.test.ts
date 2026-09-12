import { describe, expect, test } from "bun:test";
import { resolveAdoptionFocusRestore } from "./resolveAdoptionFocusRestore";

/**
 * The focus rule on its own: given the layout as it stands just before
 * adoption adds its panes, which tab should adoption hand focus back to?
 * `null` means "leave focus on the session just adopted".
 */

function terminalPane(terminalId: string, createOnAttach?: boolean) {
	return { kind: "terminal", data: { terminalId, createOnAttach } };
}

function tab(
	id: string,
	panes: Record<string, { kind: string; data: unknown }>,
) {
	return { id, panes };
}

describe("resolveAdoptionFocusRestore", () => {
	// The incident: the persisted active tab names a terminal the host disposed
	// while the app was closed. Restoring it buries the session just adopted,
	// and because only the active tab mounts, that pane never attaches.
	test("active tab holding only a dead terminal releases focus", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [tab("tab-dead", { p1: terminalPane("terminal-dead") })],
			activeTabId: "tab-dead",
			liveTerminalIds: ["terminal-live"],
		});

		expect(restore).toBeNull();
	});

	test("active tab holding a live terminal keeps focus", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [tab("tab-live", { p1: terminalPane("terminal-live") })],
			activeTabId: "tab-live",
			liveTerminalIds: ["terminal-live"],
		});

		expect(restore).toBe("tab-live");
	});

	// An optimistic pane creates its session on attach, so the host not listing
	// it yet is expected — treating it as dead would steal the user's focus
	// out of a terminal they just opened.
	test("optimistic create-on-attach pane keeps focus", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [tab("tab-new", { p1: terminalPane("terminal-pending", true) })],
			activeTabId: "tab-new",
			liveTerminalIds: [],
		});

		expect(restore).toBe("tab-new");
	});

	test("non-terminal pane keeps focus", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [
				tab("tab-file", {
					p1: { kind: "file", data: { filePath: "AGENTS.md" } },
				}),
			],
			activeTabId: "tab-file",
			liveTerminalIds: [],
		});

		expect(restore).toBe("tab-file");
	});

	// Only a tab with nothing usable left in it releases focus, so a split
	// holding one dead and one live terminal is still somewhere to work.
	test("one dead pane beside a live one keeps focus", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [
				tab("tab-split", {
					p1: terminalPane("terminal-dead"),
					p2: terminalPane("terminal-live"),
				}),
			],
			activeTabId: "tab-split",
			liveTerminalIds: ["terminal-live"],
		});

		expect(restore).toBe("tab-split");
	});

	// Unreadable pane data says nothing about the session behind it, and a
	// wrong guess here would move the user's focus for no reason.
	test("unreadable terminal pane data keeps focus", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [tab("tab-odd", { p1: { kind: "terminal", data: null } })],
			activeTabId: "tab-odd",
			liveTerminalIds: [],
		});

		expect(restore).toBe("tab-odd");
	});

	test("an empty workspace has no tab to restore", () => {
		const restore = resolveAdoptionFocusRestore({
			tabs: [],
			activeTabId: null,
			liveTerminalIds: ["terminal-live"],
		});

		expect(restore).toBeNull();
	});
});
