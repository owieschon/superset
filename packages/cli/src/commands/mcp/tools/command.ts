import { positional, string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import {
	listServers,
	resolveServer,
	serverTools,
} from "../../../lib/plugins/mcp";

export default command({
	description:
		"List the tools a server exposes (default: every installed server)",
	args: [positional("server").desc("Server or plugin name")],
	options: {
		token: string()
			.env("SUPERSET_MCP_TOKEN")
			.desc("Bearer token for servers that require auth"),
	},
	skipMiddleware: true,
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["server", "tool", "description"],
			["SERVER", "TOOL", "DESCRIPTION"],
			[16, 30, 70],
		),
	run: async ({ args, options }) => {
		const token = options.token as string | undefined;
		const servers = args.server
			? [resolveServer(args.server as string)]
			: listServers();

		const rows: Array<Record<string, unknown>> = [];
		let failures = 0;

		for (const server of servers) {
			try {
				const tools = await serverTools(server, token);
				for (const tool of tools) {
					rows.push({
						server: server.server,
						tool: tool.name,
						description: tool.description ?? "",
					});
				}
			} catch (error) {
				failures++;
				rows.push({
					server: server.server,
					tool: "(unavailable)",
					description: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const listed = rows.length - failures;
		const note = failures
			? ` ${failures} server${failures === 1 ? "" : "s"} could not be reached.`
			: "";

		return {
			data: rows,
			message: `${listed} tool${listed === 1 ? "" : "s"} across ${servers.length} server${servers.length === 1 ? "" : "s"}.${note}`,
		};
	},
});
