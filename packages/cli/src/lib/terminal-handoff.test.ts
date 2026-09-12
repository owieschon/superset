import { describe, expect, test } from "bun:test";
import type { HostServiceClient } from "./host-target";
import { buildHandoffPromptFromTerminal } from "./terminal-handoff";

describe("terminal handoff context", () => {
	test.each([
		["harness", "Provider-recorded conversation text"],
		["stream", "Reconstructed retained terminal output"],
		["screen", "Current terminal screen only"],
		[undefined, "The extent of the recorded context is unknown."],
	] as const)("carries host source %s into the destination prompt", async (source, description) => {
		const client = {
			terminal: {
				transcript: {
					query: async () => ({
						text: "[earlier output omitted]\nUser: Preserve the API.",
						source,
						streamBytes: 0,
					}),
				},
			},
			terminalAgents: { listByWorkspace: { query: async () => [] } },
		} as unknown as HostServiceClient;
		const prompt = await buildHandoffPromptFromTerminal(client, {
			workspaceId: "workspace",
			terminalId: "source",
		});
		expect(prompt).toContain(description);
		expect(prompt).toContain("Source terminal: source");
		expect(prompt).toContain("[earlier output omitted]");
		expect(prompt).toContain("User: Preserve the API.");
	});
});
