import { table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { listServers } from "../../../lib/plugins/mcp";

export default command({
	description: "List MCP servers provided by installed plugins",
	skipMiddleware: true,
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["server", "plugin", "kind", "auth", "target"],
			["SERVER", "PLUGIN", "KIND", "AUTH", "TARGET"],
			[18, 16, 10, 8, 48],
		),
	run: async () => {
		const servers = listServers();

		return {
			data: servers.map((server) => ({
				server: server.server,
				plugin: server.plugin,
				marketplace: server.marketplace,
				kind: server.kind,
				auth: server.needsAuth ? "required" : "none",
				target: server.url ?? server.modulePath ?? "",
			})),
			message: servers.length
				? `${servers.length} MCP server${servers.length === 1 ? "" : "s"} from installed plugins.`
				: "No MCP servers. Install a plugin with: superset plugins install <name>",
		};
	},
});
