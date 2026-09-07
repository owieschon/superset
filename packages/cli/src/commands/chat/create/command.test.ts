import { afterEach, describe, expect, mock, test } from "bun:test";

let createSessionInput: Record<string, unknown> | undefined;
let workspaceFound = true;

mock.module("../../../lib/host-workspaces", () => ({
	findWorkspaceOnHost: async () => ({
		hostId: "host-1",
		workspace: workspaceFound
			? { id: "00000000-0000-4000-8000-000000000001" }
			: undefined,
	}),
}));

mock.module("../../../lib/host-target", () => ({
	resolveHostTarget: () => ({
		hostId: "host-1",
		chat: {
			createSession: {
				mutate: async (input: Record<string, unknown>) => {
					createSessionInput = input;
					return { sessionId: "session-1", epoch: "epoch-1" };
				},
			},
		},
	}),
}));

const { default: createChatSessionCommand } = await import("./command");

function invoke(overrides: Record<string, unknown> = {}) {
	return createChatSessionCommand.run({
		ctx: {
			config: { organizationId: "org-1" },
			bearer: "bearer",
		} as never,
		args: {} as never,
		options: {
			workspace: "00000000-0000-4000-8000-000000000001",
			host: "host-1",
			harness: "claude-code",
			...overrides,
		} as never,
		signal: new AbortController().signal,
	});
}

afterEach(() => {
	createSessionInput = undefined;
	workspaceFound = true;
});

describe("chat create", () => {
	test("creates a chat-v3 session in the given workspace", async () => {
		const result = await invoke();

		expect(createSessionInput).toMatchObject({
			workspaceId: "00000000-0000-4000-8000-000000000001",
			harness: "claude-code",
		});
		expect(result).toMatchObject({
			data: { sessionId: "session-1", epoch: "epoch-1" },
			message:
				"Created chat session session-1 in workspace 00000000-0000-4000-8000-000000000001",
		});
	});

	test("passes optional modeId/modelId through", async () => {
		await invoke({ modeId: "plan", modelId: "sonnet" });

		expect(createSessionInput).toMatchObject({
			modeId: "plan",
			modelId: "sonnet",
		});
	});

	test("fails when the workspace isn't found on the host", async () => {
		workspaceFound = false;

		await expect(invoke()).rejects.toThrow(/Workspace not found on host/);
		expect(createSessionInput).toBeUndefined();
	});
});
