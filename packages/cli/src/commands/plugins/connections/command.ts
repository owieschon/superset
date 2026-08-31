import { string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";

interface ConnectionsResponse {
	connections: Array<{
		id: string;
		plugin: string;
		account: string | null;
		accountId: string;
		createdAt: string;
	}>;
}

export default command({
	description: "List the plugin accounts connected to your Superset account",
	options: {
		plugin: string().desc("Only this plugin"),
	},
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["plugin", "account", "id"],
			["PLUGIN", "ACCOUNT", "CONNECTION"],
			[18, 36, 38],
		),
	run: async ({ ctx, options }) => {
		const plugin = options.plugin as string | undefined;
		const query = plugin ? `?plugin=${encodeURIComponent(plugin)}` : "";
		const { connections } = await apiRequest<ConnectionsResponse>(
			ctx.bearer,
			`/api/plugins/connections${query}`,
		);

		return {
			data: connections.map((connection) => ({
				plugin: connection.plugin,
				account: connection.account ?? connection.accountId,
				id: connection.id,
				createdAt: connection.createdAt,
			})),
			message: connections.length
				? `${connections.length} connection${connections.length === 1 ? "" : "s"}.`
				: "No connections. Connect one with: superset plugins connect <name>",
		};
	},
});
