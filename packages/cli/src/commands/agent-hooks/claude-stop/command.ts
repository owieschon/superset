import { readSync } from "node:fs";
import { command } from "../../../lib/command";

export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
export const CLAUDE_STOP_RUNNING = "superset-claude-stop-running-v1";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasRunningClaudeSubagent(input: string): boolean {
	if (Buffer.byteLength(input) > MAX_HOOK_INPUT_BYTES) return false;
	let payload: unknown;
	try {
		payload = JSON.parse(input);
	} catch {
		return false;
	}
	if (
		!isRecord(payload) ||
		payload.hook_event_name !== "Stop" ||
		"agent_id" in payload ||
		"agentId" in payload
	) {
		return false;
	}
	const tasks = payload.background_tasks;
	if (
		!Array.isArray(tasks) ||
		!tasks.every(
			(task) =>
				isRecord(task) &&
				typeof task.type === "string" &&
				typeof task.status === "string",
		)
	) {
		return false;
	}
	return tasks.some(
		(task) => task.type === "subagent" && task.status === "running",
	);
}

export default command({
	description: "Classify a local Claude Stop hook without sending its contents",
	skipMiddleware: true,
	run: async () => {
		// One extra byte distinguishes a complete bounded input from truncation.
		const buffer = Buffer.alloc(MAX_HOOK_INPUT_BYTES + 1);
		let length = 0;
		try {
			while (length < buffer.length) {
				const count = readSync(0, buffer, length, buffer.length - length, null);
				if (count === 0) break;
				length += count;
			}
		} catch {
			return;
		}
		if (
			length <= MAX_HOOK_INPUT_BYTES &&
			hasRunningClaudeSubagent(buffer.toString("utf8", 0, length))
		) {
			process.stdout.write(CLAUDE_STOP_RUNNING);
		}
	},
});
