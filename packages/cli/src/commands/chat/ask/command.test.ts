import { afterEach, describe, expect, mock, test } from "bun:test";

let promptInput: Record<string, unknown> | undefined;
let queued = false;

mock.module("../../../lib/host-target", () => ({
	requireHostTarget: () => "host-1",
	resolveHostTarget: () => ({
		hostId: "host-1",
		chat: {
			prompt: {
				mutate: async (input: Record<string, unknown>) => {
					promptInput = input;
					return { itemId: "item-1", queued };
				},
			},
		},
	}),
}));

const { default: chatAskCommand } = await import("./command");

function invoke(overrides: Record<string, unknown> = {}) {
	return chatAskCommand.run({
		ctx: {
			config: { organizationId: "org-1" },
			bearer: "bearer",
		} as never,
		args: {} as never,
		options: {
			local: true,
			session: "session-1",
			text: "clean up tmp",
			...overrides,
		} as never,
		signal: new AbortController().signal,
	});
}

afterEach(() => {
	promptInput = undefined;
	queued = false;
});

describe("chat ask", () => {
	test("sends the message to the session", async () => {
		const result = await invoke();

		expect(promptInput).toMatchObject({
			sessionId: "session-1",
			content: [{ type: "text", text: "clean up tmp" }],
		});
		expect(result).toMatchObject({
			data: { itemId: "item-1", queued: false },
			message: "Sent to chat session session-1",
		});
	});

	test("reports a queued prompt distinctly from a sent one", async () => {
		queued = true;

		const result = await invoke();

		expect(result).toMatchObject({
			message: "Queued for chat session session-1",
		});
	});
});
