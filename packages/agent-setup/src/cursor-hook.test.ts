import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCursorHookScriptContent } from "./agent-wrappers-cursor";

const emptyHome = mkdtempSync(path.join(tmpdir(), "cursor-hook-identity-"));
afterAll(() => rmSync(emptyHome, { recursive: true, force: true }));

describe("Cursor hook identity", () => {
	const cases: Array<{
		name: string;
		env: Record<string, string>;
		agentId: string;
	}> = [
		{
			name: "direct cursor-agent launch",
			env: { CURSOR_INVOKED_AS: "cursor-agent" },
			agentId: "cursor-agent",
		},
		{
			name: "direct agent alias launch",
			env: { CURSOR_INVOKED_AS: "agent" },
			agentId: "cursor-agent",
		},
		{
			name: "explicit wrapper identity",
			env: {
				SUPERSET_AGENT_ID: "cursor-custom",
				CURSOR_INVOKED_AS: "cursor-agent",
			},
			agentId: "cursor-custom",
		},
		{
			name: "legacy CURSOR_AGENT marker",
			env: { CURSOR_AGENT: "1" },
			agentId: "cursor-agent",
		},
		{
			name: "legacy CURSOR_CLI marker",
			env: { CURSOR_CLI: "1" },
			agentId: "cursor-agent",
		},
		{ name: "no CLI marker", env: {}, agentId: "cursor-composer" },
		{
			name: "unrelated invocation name",
			env: { CURSOR_INVOKED_AS: "other-agent" },
			agentId: "cursor-composer",
		},
	];

	for (const { name, env, agentId } of cases) {
		it(`reports the correct recipient for ${name}`, async () => {
			const requests: unknown[] = [];
			const server = Bun.serve({
				port: 0,
				async fetch(request) {
					requests.push(await request.json());
					return Response.json({ ignored: false });
				},
			});
			try {
				const proc = Bun.spawn({
					cmd: [
						"bash",
						"-c",
						getCursorHookScriptContent(),
						"hook",
						"SessionStart",
					],
					env: {
						...process.env,
						CURSOR_AGENT: "",
						CURSOR_CLI: "",
						CURSOR_INVOKED_AS: "",
						SUPERSET_AGENT_ID: "",
						SUPERSET_HOME_DIR: emptyHome,
						SUPERSET_TERMINAL_ID: "cursor-terminal",
						SUPERSET_HOST_AGENT_HOOK_URL: `http://127.0.0.1:${server.port}/trpc/notifications.hook`,
						...env,
					},
					stdin: Buffer.from(
						JSON.stringify({ session_id: "cursor-conversation" }),
					),
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(await proc.exited).toBe(0);
				expect(requests).toEqual([
					{
						json: {
							terminalId: "cursor-terminal",
							eventType: "SessionStart",
							agent: { agentId, sessionId: "cursor-conversation" },
						},
					},
				]);
			} finally {
				server.stop(true);
			}
		});
	}
});
