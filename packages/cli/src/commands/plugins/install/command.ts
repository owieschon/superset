import fs from "node:fs";
import path from "node:path";
import { boolean, positional, string, table } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import {
	type AuthInputSpec,
	apiRequest,
	missingInputsError,
	parseInputs,
	readStdin,
} from "../../../lib/plugins/api";
import { resolvePluginRef } from "../../../lib/plugins/host";
import {
	ensureDefaultMarketplace,
	installPlugin,
} from "../../../lib/plugins/install";
import { supersetExtension } from "../../../lib/plugins/marketplace";

interface InstallResponse {
	install: { plugin: string; version: string; marketplace: string };
	needsConnection: boolean;
}

interface ConnectionsResponse {
	connections: Array<{ id: string; account: string | null }>;
}

export default command({
	description:
		"Install a plugin: materialize its skills locally and record it on your account",
	args: [
		positional("plugin")
			.required()
			.desc("Plugin name, or name@marketplace to disambiguate"),
	],
	options: {
		marketplace: string().desc(
			"Which marketplace to install from, when several offer this name",
		),
		inputs: string().desc(
			'Credential inputs as JSON, or "-" to read them from stdin',
		),
		update: boolean().desc(
			"Replace an existing install with the marketplace's current version, and re-sync its skills",
		),
	},
	display: (data) =>
		table(
			(data ?? []) as Record<string, unknown>[],
			["name", "version", "skills", "connection"],
			["PLUGIN", "VERSION", "SKILLS", "CONNECTION"],
			[20, 10, 8, 40],
		),
	run: async ({ ctx, args, options }) => {
		await ensureDefaultMarketplace();
		const { name, marketplace } = resolvePluginRef(
			args.plugin as string,
			options.marketplace as string | undefined,
		);

		// Local first: skills on disk and agent config are what the machine
		// needs, and they work whether or not the account call succeeds.
		const local = await installPlugin(name, marketplace, {
			update: Boolean(options.update),
		});

		// The local install already succeeded, so a failure here is partial, not
		// total: report it rather than throwing away that fact. Same split the
		// UI makes — on disk but not on your account, so tools will not work.
		let account: InstallResponse | null = null;
		let accountError: string | null = null;
		try {
			account = await apiRequest<InstallResponse>(
				ctx.bearer,
				`/api/plugins/${name}/install`,
				{ method: "POST" },
			);
		} catch (error) {
			accountError = error instanceof Error ? error.message : String(error);
		}

		// Only auto-connect when there is exactly one way in; a choice belongs to
		// the user, surfaced by `superset plugins connect`.
		const methods =
			supersetExtension(
				JSON.parse(
					fs.readFileSync(path.join(local.installPath, "plugin.json"), "utf8"),
				),
			)?.auth ?? [];
		const auth = methods.length === 1 ? methods[0] : undefined;

		let connection = accountError ? "account sync failed" : "not required";

		if (account?.needsConnection && methods.length > 1) {
			connection = `needs connection: superset plugins connect ${name} --method <${methods.map((m) => m.type).join("|")}>`;
		} else if (account?.needsConnection && auth) {
			const { connections } = await apiRequest<ConnectionsResponse>(
				ctx.bearer,
				`/api/plugins/connections?plugin=${encodeURIComponent(name)}`,
			);

			if (connections.length > 0) {
				connection = `connected as ${connections[0]?.account ?? "unknown"}`;
			} else if (auth.type === "api_key") {
				const declared = (auth.inputs ?? []) as AuthInputSpec[];
				const provided = parseInputs(
					options.inputs as string | undefined,
					await readStdin(),
				);
				const missing = declared.filter(
					(input) => input.required !== false && !provided[input.name],
				);
				if (missing.length) {
					throw missingInputsError(name, missing, declared);
				}
				// POST with a JSON body, never a query string: these are credential
				// values, and a URL reaches browser history, proxy logs, and the
				// Referer header. The route rejects api_key over GET for the same
				// reason, so this is also the only shape it accepts.
				const created = await apiRequest<{ account: string | null }>(
					ctx.bearer,
					`/api/plugins/${encodeURIComponent(name)}/connect`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(provided),
					},
				);
				connection = `connected as ${created.account ?? "unknown"}`;
			} else {
				connection = "authorize in a browser";
			}
		}

		const next =
			connection === "authorize in a browser"
				? ` Authorize it: superset plugins connect ${name}`
				: accountError
					? ` Its skills work, but tools will not until the account install succeeds: ${accountError}`
					: "";

		return {
			data: [
				{
					name: local.name,
					version: local.version,
					marketplace: local.marketplace,
					skills: local.skills,
					connection,
				},
			],
			message: `Installed ${local.name}@${local.version}. ${local.skills} skill${local.skills === 1 ? "" : "s"} synced.${next}`,
		};
	},
});
