import { boolean, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";

interface CatalogPlugin {
	name: string;
	version: string;
	description: string;
	marketplace: string;
	authMethods: { type: "oauth2" | "api_key" }[];
	installed: boolean;
	enabled: boolean;
	connections: { id: string; account: string | null }[];
	accounts: string[];
}

export default command({
	description:
		"List installed plugins, or everything available with --available",
	options: {
		available: boolean().desc("Include plugins you have not installed"),
	},
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["name", "version", "status", "pluginId"],
			["PLUGIN", "VERSION", "STATUS", "PLUGIN ID"],
			[16, 9, 30, 38],
		),
	run: async ({ ctx, options }) => {
		// The account is the source of truth, so a plugin installed on another
		// machine appears here too; local disk only caches the content.
		const { plugins } = await apiRequest<{ plugins: CatalogPlugin[] }>(
			ctx.bearer,
			"/api/plugins",
		);

		const visible = options.available
			? plugins
			: plugins.filter((plugin) => plugin.installed);

		const status = (plugin: CatalogPlugin) => {
			if (!plugin.installed) return "available";
			if (!plugin.enabled) return "disabled";
			if (plugin.authMethods.length > 0 && plugin.connections.length === 0) {
				return "needs connection";
			}
			return plugin.accounts.length
				? `connected: ${plugin.accounts.join(", ")}`
				: "installed";
		};

		return {
			data: visible.map((plugin) => ({
				name: plugin.name,
				version: plugin.version,
				marketplace: plugin.marketplace,
				status: status(plugin),
				// What `mcp tools` and `mcp call-tool` address a plugin by. One
				// per connected account, so a plugin with two accounts lists two.
				pluginId: plugin.connections.map((connection) => connection.id),
				connections: plugin.connections,
				description: plugin.description,
			})),
			message: visible.length
				? `${visible.length} plugin${visible.length === 1 ? "" : "s"}.`
				: "No plugins installed. See what's available: superset plugins list --available",
		};
	},
});
