import { positional, string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";
import {
	installMarketplace,
	parseMarketplaceSource,
} from "../../../lib/plugins/install";

export default command({
	description: "Add a marketplace from a GitHub repo or local path",
	args: [
		positional("source")
			.required()
			.desc("owner/repo, owner/repo#branch, a GitHub URL, or a local path"),
	],
	options: {
		name: string().desc("Register under this name instead of the manifest's"),
	},
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["name", "plugins", "location"],
			["MARKETPLACE", "PLUGINS", "LOCATION"],
			[22, 10, 56],
		),
	run: async ({ ctx, args, options }) => {
		const source = parseMarketplaceSource(args.source as string);

		// Fetch first: the account should only record a marketplace that
		// resolved to a real manifest, so a typo fails here rather than
		// leaving an entry that never works on any machine.
		const local = await installMarketplace(source, {
			name: options.name as string | undefined,
		});

		await apiRequest(ctx.bearer, "/api/plugins/marketplaces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: local.name,
				sourceKind: source.kind,
				repo: source.repo,
				ref: source.ref,
				path: source.path,
			}),
		});

		return {
			data: [
				{
					name: local.name,
					plugins: local.plugins,
					location: local.location,
				},
			],
			message: `${local.updated ? "Updated" : "Added"} marketplace "${local.name}" with ${local.plugins} plugin${local.plugins === 1 ? "" : "s"}. Install one with: superset plugins install <name>`,
		};
	},
});
