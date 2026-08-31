import { CLIError, positional, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { connectionRequest, readStdin } from "../../../lib/plugins/api";

export default command({
	description: "Call a tool on a connected plugin",
	args: [
		positional("tool").required().desc("Tool name"),
		positional("arguments").desc(
			"Tool arguments as JSON (default: {}, or piped on stdin)",
		),
	],
	options: {
		pluginId: string()
			.required()
			.desc("Plugin id from `superset plugins list`"),
	},
	run: async ({ ctx, args, options }) => {
		const pluginId = options.pluginId as string;
		const tool = args.tool as string;

		// A bare `-` cannot mean stdin here: the framework parses a positional
		// starting with `-` as a flag. Piping with the argument omitted does.
		const raw = args.arguments as string | undefined;
		const source = raw ?? (await readStdin()) ?? "{}";
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(source) as Record<string, unknown>;
		} catch (error) {
			throw new CLIError(
				`Arguments must be JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const { result } = await connectionRequest<{ result: unknown }>(
			ctx.bearer,
			`/api/plugins/connections/${encodeURIComponent(pluginId)}/tools/${encodeURIComponent(tool)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(parsed),
			},
		);

		return {
			data: result,
			message: JSON.stringify(result, null, 2),
		};
	},
});
