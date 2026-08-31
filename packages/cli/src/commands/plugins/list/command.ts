import { boolean, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";

interface CatalogPlugin {
	name: string;
	version: string;
	description: string;
	marketplace: string;
	authType: "oauth2" | "api_key" | null;
	installed: boolean;
	enabled: boolean;
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
			["name", "version", "marketplace", "status"],
			["PLUGIN", "VERSION", "MARKETPLACE", "STATUS"],
			[20, 10, 18, 26],
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
			if (plugin.authType && plugin.accounts.length === 0) {
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
				description: plugin.description,
			})),
			message: visible.length
				? `${visible.length} plugin${visible.length === 1 ? "" : "s"}.`
				: "No plugins installed. See what's available: superset plugins list --available",
		};
	},
});
