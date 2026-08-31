import { positional } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";

export default command({
	description: "Remove a marketplace from your account",
	args: [positional("name").required().desc("Marketplace name")],
	run: async ({ ctx, args }) => {
		const name = args.name as string;
		await apiRequest(
			ctx.bearer,
			`/api/plugins/marketplaces/${encodeURIComponent(name)}`,
			{ method: "DELETE" },
		);
		return { data: { name }, message: `Removed marketplace "${name}".` };
	},
});
