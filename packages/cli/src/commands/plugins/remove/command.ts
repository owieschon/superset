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

		// The account first, because it holds the credential: removing the
		// install also disconnects anything authorized for the plugin. Deleting
		// local files first would, on a failed request, leave a plugin the user
		// believes is gone still holding a live token. The reverse failure only
		// leaves stale files, which the next sync reaps.
		await apiRequest(ctx.bearer, `/api/plugins/${name}/install`, {
			method: "DELETE",
		});

		const removed = await removePlugin(name, marketplace);

		return {
			data: { name: removed.name, marketplace: removed.marketplace },
			message: `Removed ${removed.name}@${removed.version} (${removed.marketplace}).`,
		};
	},
});
