import { string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { connectionRequest } from "../../../lib/plugins/api";

interface ToolsResponse {
	plugin: string;
	tools: { name: string; description?: string }[];
}

export default command({
	description: "List the tools a connected plugin exposes",
	options: {
		pluginId: string()
			.required()
			.desc("Plugin id from `superset plugins list`"),
	},
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["plugin", "tool", "description"],
			["PLUGIN", "TOOL", "DESCRIPTION"],
			[16, 30, 70],
		),
	run: async ({ ctx, options }) => {
		const pluginId = options.pluginId as string;

		// The server is dialed by the API, which holds the credential. Nothing
		// here ever sees the token, which is the point of the proxy.
		const { plugin, tools } = await connectionRequest<ToolsResponse>(
			ctx.bearer,
			`/api/plugins/connections/${encodeURIComponent(pluginId)}/tools`,
		);

		return {
			data: tools.map((tool) => ({
				plugin,
				tool: tool.name,
				description: tool.description ?? "",
			})),
			message: `${tools.length} tool${tools.length === 1 ? "" : "s"} on ${plugin}.`,
		};
	},
});
