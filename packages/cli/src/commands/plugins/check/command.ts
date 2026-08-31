import { CLIError, positional, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import {
	findMarketplace,
	resolvePlugins,
} from "../../../lib/plugins/marketplace";
import { checkPlugin } from "../../../lib/plugins/publish";

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
		const plugins = resolvePlugins(ctx, args.names as string[] | undefined);
		const issues = plugins.flatMap((plugin) => checkPlugin(ctx, plugin));

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
