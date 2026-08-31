import { CLIError, positional, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { resolveServer, serverCallTool } from "../../../lib/plugins/mcp";

export default command({
	description: "Call a tool on an installed MCP server",
	args: [
		positional("server").required().desc("Server or plugin name"),
		positional("tool").required().desc("Tool name"),
		positional("arguments").desc("Tool arguments as JSON (default: {})"),
	],
	options: {
		token: string()
			.env("SUPERSET_MCP_TOKEN")
			.desc("Bearer token for servers that require auth"),
	},
	skipMiddleware: true,
	run: async ({ args, options }) => {
		const raw = (args.arguments as string | undefined) ?? "{}";
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch (error) {
			throw new CLIError(
				`Arguments must be JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const server = resolveServer(args.server as string);
		const result = await serverCallTool(
			server,
			args.tool as string,
			parsed,
			options.token as string | undefined,
		);

		return {
			data: result,
			message: JSON.stringify(result, null, 2),
		};
	},
});
