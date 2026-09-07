import { afterEach, describe, expect, mock, test } from "bun:test";

let sessionResult: Record<string, unknown> = {
	session: {
		sessionId: "session-1",
		status: "running",
		harness: "claude-code",
	},
	cursor: { epoch: "epoch-1", seq: 3 },
};
let itemsResult: Record<string, unknown> = { ok: true, envelopes: [] };

mock.module("../../../lib/host-target", () => ({
	requireHostTarget: () => "host-1",
	resolveHostTarget: () => ({
		hostId: "host-1",
		chat: {
			getSession: { query: async () => sessionResult },
			getItems: { query: async () => itemsResult },
		},
	}),
}));

const { default: chatStatusCommand } = await import("./command");

function invoke() {
	return chatStatusCommand.run({
		ctx: {
			config: { organizationId: "org-1" },
			bearer: "bearer",
		} as never,
		args: {} as never,
		options: { local: true, session: "session-1" } as never,
		signal: new AbortController().signal,
	});
}

function approvalEnvelope(
	status: "pending" | "answered",
	overrides: Record<string, unknown> = {},
) {
	return {
		event: {
			type: "item",
			turnId: "t1",
			item: {
				id: "ap1",
				kind: "approval_request",
				startedAtMs: 1,
				targetItemId: null,
				title: "Run `rm -rf tmp`?",
				status,
				...overrides,
			},
		},
	};
}

afterEach(() => {
	sessionResult = {
		session: {
			sessionId: "session-1",
			status: "running",
			harness: "claude-code",
		},
		cursor: { epoch: "epoch-1", seq: 3 },
	};
	itemsResult = { ok: true, envelopes: [] };
});

describe("chat status", () => {
	test("reports no pending approval when there is none", async () => {
		const result = await invoke();

		expect(result).toMatchObject({
			data: { pendingApproval: null },
			message: "Session session-1 is running; no pending approval",
		});
	});

	test("surfaces the current pending approval and its id", async () => {
		itemsResult = { ok: true, envelopes: [approvalEnvelope("pending")] };

		const result = await invoke();

		expect(result).toMatchObject({
			data: { pendingApproval: { id: "ap1", title: "Run `rm -rf tmp`?" } },
			message:
				"Session session-1 is running; pending approval ap1: Run `rm -rf tmp`?",
		});
	});

	test("treats an answered approval as no longer pending", async () => {
		itemsResult = {
			ok: true,
			envelopes: [
				approvalEnvelope("pending"),
				approvalEnvelope("answered", { decision: { type: "accept" } }),
			],
		};

		const result = await invoke();

		expect(result).toMatchObject({ data: { pendingApproval: null } });
	});

	test("fails when the session doesn't exist", async () => {
		sessionResult = { session: null, cursor: null };

		await expect(invoke()).rejects.toThrow(/Chat session not found/);
	});
});
