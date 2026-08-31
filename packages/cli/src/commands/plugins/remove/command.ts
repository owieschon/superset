import { positional } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";
import { parsePluginRef } from "../../../lib/plugins/host";
import { removePlugin } from "../../../lib/plugins/install";

export default command({
	description: "Uninstall a plugin and drop its skills",
	args: [
		positional("plugin")
			.required()
			.desc("Plugin name, or name@marketplace to disambiguate"),
	],
	run: async ({ ctx, args }) => {
		const { name, marketplace } = parsePluginRef(args.plugin as string);
		const removed = await removePlugin(name, marketplace);

		// Mirrors the UI: removing the account install also disconnects live
		// credentials, so an uninstalled plugin cannot still be authorized.
		await apiRequest(ctx.bearer, `/api/plugins/${name}/install`, {
			method: "DELETE",
		});

		return {
			data: { name: removed.name, marketplace: removed.marketplace },
			message: `Removed ${removed.name}@${removed.version} (${removed.marketplace}).`,
		};
	},
});
