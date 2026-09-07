import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	CLAUDE_STOP_RUNNING,
	hasRunningClaudeSubagent,
	MAX_HOOK_INPUT_BYTES,
} from "./command";

const running = { type: "subagent", status: "running" };
const stop = { hook_event_name: "Stop", background_tasks: [running] };

describe("Claude parent Stop classification", () => {
	it("recognizes a running subagent among completed and unrelated tasks", () => {
		expect(
			hasRunningClaudeSubagent(
				JSON.stringify({
					...stop,
					background_tasks: [
						{ type: "subagent", status: "completed" },
						{ type: "shell", status: "running" },
						running,
					],
				}),
			),
		).toBe(true);
	});

	it("reads top-level fields despite nested keys and escaped message content", () => {
		expect(
			hasRunningClaudeSubagent(
				JSON.stringify({
					message: 'private "agent_id":"nested"\nsecond line\\tail',
					nested: { agent_id: "nested", hook_event_name: "PermissionRequest" },
					...stop,
				}),
			),
		).toBe(true);
		expect(hasRunningClaudeSubagent(JSON.stringify({ nested: stop }))).toBe(
			false,
		);
	});

	for (const payload of [
		{ ...stop, agent_id: "child" },
		{ ...stop, agent_id: null },
		{ ...stop, agentId: "child" },
		{ ...stop, hook_event_name: "PermissionRequest" },
		{ ...stop, hook_event_name: "SessionEnd" },
		{ ...stop, background_tasks: [] },
		{ hook_event_name: "Stop" },
		{ ...stop, background_tasks: [running, null] },
		{ ...stop, background_tasks: "running" },
		{ ...stop, background_tasks: [{ type: "subagent" }] },
		{
			...stop,
			background_tasks: ["shell", "server", "daemon", "cron", "unknown"].map(
				(type) => ({ type, status: "running" }),
			),
		},
		{
			...stop,
			background_tasks: ["completed", "failed", "pending"].map((status) => ({
				type: "subagent",
				status,
			})),
		},
	]) {
		it(`leaves existing behavior for ${JSON.stringify(payload)}`, () => {
			expect(hasRunningClaudeSubagent(JSON.stringify(payload))).toBe(false);
		});
	}

	it("does not classify invalid or oversized JSON", () => {
		for (const input of ["{", "null", "[]", '{"message":"raw\nnewline"}']) {
			expect(hasRunningClaudeSubagent(input)).toBe(false);
		}
		expect(
			hasRunningClaudeSubagent(
				JSON.stringify({ ...stop, message: "x".repeat(MAX_HOOK_INPUT_BYTES) }),
			),
		).toBe(false);
	});
});

describe("Claude Stop CLI invocation", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "claude-stop-command-"));
	const entryPath = path.join(dir, "entry.ts");
	writeFileSync(
		entryPath,
		`import { run } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../../../cli-framework/src/runner.ts"))};
import command from ${JSON.stringify(path.join(import.meta.dir, "command.ts"))};
await run({ name: "superset", version: "test", tree: {
  commands: [{ path: ["agent-hooks", "claude-stop"], command }], groups: [],
  middleware: async () => { throw new Error("Authentication and telemetry middleware must not run"); }
} });`,
	);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	for (const [name, input, expected] of [
		["running parent", JSON.stringify(stop), CLAUDE_STOP_RUNNING],
		["ordinary completion", '{"hook_event_name":"Stop"}', ""],
		["invalid input", "private invalid input", ""],
		[
			"oversized input",
			JSON.stringify({ ...stop, message: "x".repeat(MAX_HOOK_INPUT_BYTES) }),
			"",
		],
	]) {
		it(`emits only the fixed token or nothing for ${name}, bypassing middleware`, () => {
			const result = Bun.spawnSync({
				cmd: [process.execPath, entryPath, "agent-hooks", "claude-stop"],
				stdin: Buffer.from(input ?? ""),
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toBe(expected ?? "");
			expect(result.stderr.toString()).toBe("");
		});
	}
});
