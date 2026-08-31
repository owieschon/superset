import { auth } from "@superset/auth/server";
import { db } from "@superset/db/client";
import { pluginConnections, pluginInstalls } from "@superset/db/schema";
import { FIRST_PARTY_MANIFESTS } from "@superset/shared/plugins";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { PluginManifest } from "@/lib/plugins/manifest";
import { supersetExtension } from "@/lib/plugins/manifest";

const FIRST_PARTY = "superset";

/**
 * What this user has installed, and what the built-in marketplace offers.
 *
 * Both the CLI and the desktop app read the catalog from here so a plugin
 * installed on one machine is installed everywhere; local disk holds only the
 * content, reconciled to match this.
 */
export async function GET(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const [installs, connections] = await Promise.all([
		db
			.select()
			.from(pluginInstalls)
			.where(eq(pluginInstalls.userId, session.user.id))
			.orderBy(asc(pluginInstalls.pluginName)),
		db
			.select({
				pluginName: pluginConnections.pluginName,
				account: pluginConnections.externalAccountLabel,
			})
			.from(pluginConnections)
			.where(
				and(
					eq(pluginConnections.userId, session.user.id),
					isNull(pluginConnections.disconnectedAt),
				),
			),
	]);

	const accounts = new Map<string, string[]>();
	for (const row of connections) {
		const list = accounts.get(row.pluginName) ?? [];
		if (row.account) list.push(row.account);
		accounts.set(row.pluginName, list);
	}

	const describe = (
		manifest: PluginManifest & {
			skills?: { name: string; description: string }[];
		},
		marketplace: string,
	) => {
		const extension = supersetExtension(manifest);
		return {
			name: manifest.name,
			version: manifest.version,
			description: manifest.description ?? "",
			marketplace,
			displayName: extension?.interface?.displayName ?? manifest.name,
			category: extension?.interface?.category ?? "Developer tools",
			icon: extension?.interface?.icon,
			// The full list: a plugin can offer several, and the picker needs
			// every one plus its own inputs.
			authMethods: (extension?.auth ?? []).map((method) => ({
				type: method.type,
				label: method.label ?? null,
				inputs: method.inputs ?? [],
			})),
			mcpUrl: extension?.mcp?.url ?? null,
			skills: manifest.skills ?? [],
			homepage: (manifest as { homepage?: string }).homepage ?? null,
			author: (manifest as { author?: { name?: string } }).author?.name ?? null,
			license: (manifest as { license?: string }).license ?? null,
		};
	};

	const installed = installs.map((row) => ({
		...describe(row.manifest as PluginManifest, row.marketplace),
		installed: true,
		enabled: row.enabled,
		installedAt: row.installedAt,
		accounts: accounts.get(row.pluginName) ?? [],
	}));

	const installedKeys = new Set(
		installs.map((row) => `${row.marketplace}/${row.pluginName}`),
	);

	// The built-in marketplace ships compiled in, so the catalog is populated
	// before anything has been cloned or installed.
	const available = Object.values(FIRST_PARTY_MANIFESTS)
		.filter((manifest) => !installedKeys.has(`${FIRST_PARTY}/${manifest.name}`))
		.map((manifest) => ({
			...describe(manifest as unknown as PluginManifest, FIRST_PARTY),
			installed: false,
			enabled: false,
			accounts: [] as string[],
		}));

	return Response.json({ plugins: [...installed, ...available] });
}
