import { afterEach, describe, expect, mock, test } from "bun:test";

let respondInput: Record<string, unknown> | undefined;
let respondFails: string | undefined;

mock.module("../../../lib/host-target", () => ({
	requireHostTarget: () => "host-1",
	resolveHostTarget: () => ({
		hostId: "host-1",
		chat: {
			respondToApproval: {
				mutate: async (input: Record<string, unknown>) => {
					respondInput = input;
					if (respondFails) throw new Error(respondFails);
				},
			},
		},
	}),
}));

const { default: chatRespondCommand } = await import("./command");

function invoke(overrides: Record<string, unknown> = {}) {
	return chatRespondCommand.run({
		ctx: {
			config: { organizationId: "org-1" },
			bearer: "bearer",
		} as never,
		args: {} as never,
		options: {
			local: true,
			session: "session-1",
			approval: "ap1",
			decision: "accept",
			...overrides,
		} as never,
		signal: new AbortController().signal,
	});
}

afterEach(() => {
	respondInput = undefined;
	respondFails = undefined;
});

describe("chat respond", () => {
	test("answers the approval by id", async () => {
		const result = await invoke();

		expect(respondInput).toMatchObject({
			sessionId: "session-1",
			approvalId: "ap1",
			decision: { type: "accept" },
		});
		expect(result).toMatchObject({
			message: "Answered approval ap1 in session session-1 (accept)",
		});
	});

	test("builds an option decision from --option", async () => {
		await invoke({ decision: "option", option: "opt-2" });

		expect(respondInput).toMatchObject({
			decision: { type: "option", optionId: "opt-2" },
		});
	});

	test("rejects --decision option without --option", async () => {
		await expect(invoke({ decision: "option" })).rejects.toThrow(
			/Missing --option/,
		);
		expect(respondInput).toBeUndefined();
	});

	test("rejects an unknown decision type before calling the host", async () => {
		await expect(invoke({ decision: "nope" })).rejects.toThrow(
			/Unknown --decision/,
		);
		expect(respondInput).toBeUndefined();
	});

	test("propagates a stale/mismatched approval id rejection from the host", async () => {
		respondFails = "unknown approval ap1";

		await expect(invoke()).rejects.toThrow(/unknown approval ap1/);
	});
});
