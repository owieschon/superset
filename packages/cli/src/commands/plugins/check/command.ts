import { CLIError, positional, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import {
	findMarketplace,
	resolvePlugins,
} from "../../../lib/plugins/marketplace";
import {
	checkPlugin,
	generatedManifestDrift,
} from "../../../lib/plugins/publish";

export default command({
	description:
		"Validate every plugin: manifest, published version, and whether the built server matches its source",
	args: [
		positional("names")
			.variadic()
			.desc("Plugin names to check (default: every plugin in the marketplace)"),
	],
	skipMiddleware: true,
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["name", "problem"],
			["PLUGIN", "PROBLEM"],
			[20, 80],
		),
	run: async ({ args }) => {
		const ctx = findMarketplace();
		const names = args.names as string[] | undefined;
		const plugins = resolvePlugins(ctx, names);
		const issues = plugins.flatMap((plugin) => checkPlugin(ctx, plugin));

		// Only when checking the whole marketplace: the bundle is generated from
		// every published plugin, so a subset can never say whether it is current.
		if (!names?.length) issues.push(...generatedManifestDrift(ctx));

		if (issues.length) {
			throw new CLIError(
				`${issues.length} problem${issues.length === 1 ? "" : "s"} found:\n` +
					issues.map((i) => `  ${i.name}: ${i.problem}`).join("\n"),
			);
		}

		return {
			data: [],
			message: `All ${plugins.length} plugin${plugins.length === 1 ? "" : "s"} are valid and published.`,
		};
	},
});
