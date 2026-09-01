import { positional, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";
import { resolvePluginRef } from "../../../lib/plugins/host";
import { removePlugin } from "../../../lib/plugins/install";

export default command({
	description: "Uninstall a plugin and drop its skills",
	args: [
		positional("plugin")
			.required()
			.desc("Plugin name, or name@marketplace to disambiguate"),
	],
	options: {
		marketplace: string().desc(
			"Which marketplace's install to remove, when several offer this name",
		),
	},
	run: async ({ ctx, args, options }) => {
		const { name, marketplace } = resolvePluginRef(
			args.plugin as string,
			options.marketplace as string | undefined,
		);

		// The account first, because it holds the credential: removing the
		// install also disconnects anything authorized for the plugin. Deleting
		// local files first would, on a failed request, leave a plugin the user
		// believes is gone still holding a live token. The reverse failure only
		// leaves stale files, which the next sync reaps.
		//
		// The marketplace goes with it: the account deletion is scoped to one
		// install, and without it a name carried by two marketplaces would
		// uninstall and disconnect both while only one local copy went away.
		const query = marketplace
			? `?marketplace=${encodeURIComponent(marketplace)}`
			: "";
		await apiRequest(ctx.bearer, `/api/plugins/${name}/install${query}`, {
			method: "DELETE",
		});

		const removed = await removePlugin(name, marketplace);

		return {
			data: { name: removed.name, marketplace: removed.marketplace },
			message: `Removed ${removed.name}@${removed.version} (${removed.marketplace}).`,
		};
	},
});
