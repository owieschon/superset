import { table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { apiRequest } from "../../../lib/plugins/api";

interface Marketplace {
	name: string;
	builtin: boolean;
	sourceKind: string;
	repo?: string | null;
	ref?: string | null;
	path?: string | null;
	plugins?: number;
}

export default command({
	description: "List the marketplaces on your account",
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["name", "source"],
			["MARKETPLACE", "SOURCE"],
			[24, 60],
		),
	run: async ({ ctx }) => {
		const { marketplaces } = await apiRequest<{ marketplaces: Marketplace[] }>(
			ctx.bearer,
			"/api/plugins/marketplaces",
		);

		const describe = (entry: Marketplace) => {
			if (entry.builtin) return "built in";
			if (entry.sourceKind === "path") return `path:${entry.path}`;
			return `github:${entry.repo}${entry.ref ? `#${entry.ref}` : ""}`;
		};

		return {
			data: marketplaces.map((entry) => ({
				name: entry.name,
				source: describe(entry),
				builtin: entry.builtin,
			})),
			message: `${marketplaces.length} marketplace${marketplaces.length === 1 ? "" : "s"}.`,
		};
	},
});
