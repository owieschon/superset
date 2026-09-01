import { auth } from "@superset/auth/server";
import { db } from "@superset/db/client";
import { pluginConnections, pluginInstalls } from "@superset/db/schema";
import { firstPartyManifest } from "@superset/shared/plugins";
import { and, eq, isNull, or } from "drizzle-orm";
import { installRecord, pluginErrorResponse } from "@/lib/plugins/connections";

const FIRST_PARTY_MARKETPLACE = "superset";

async function resolveInstall(
	userId: string,
	plugin: string,
	request: Request,
): Promise<
	| {
			ok: true;
			install: NonNullable<Awaited<ReturnType<typeof installRecord>>>;
	  }
	| { ok: false; response: Response }
> {
	const marketplace =
		new URL(request.url).searchParams.get("marketplace") ?? undefined;

	let install: Awaited<ReturnType<typeof installRecord>>;
	try {
		install = await installRecord(userId, plugin, marketplace);
	} catch (error) {
		const response = pluginErrorResponse(error);
		if (!response) throw error;
		return { ok: false, response };
	}

	if (!install) {
		return {
			ok: false,
			response: Response.json(
				{
					error: marketplace
						? `"${plugin}" is not installed from "${marketplace}"`
						: `"${plugin}" is not installed`,
				},
				{ status: 404 },
			),
		};
	}
	return { ok: true, install };
}

/**
 * Records that a user installed a plugin, storing the manifest the proxy and
 * OAuth flow read.
 *
 * The manifest is resolved here rather than accepted from the request: it
 * carries token_url and the proxy target, so a client-supplied one would let
 * a caller point our credential exchange anywhere.
 */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ plugin: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin } = await params;
	const manifest = firstPartyManifest(plugin);
	if (!manifest) {
		return Response.json(
			{ error: `Unknown plugin "${plugin}"` },
			{ status: 404 },
		);
	}

	const organizationId =
		new URL(request.url).searchParams.get("organizationId") ?? null;

	const [row] = await db
		.insert(pluginInstalls)
		.values({
			userId: session.user.id,
			organizationId,
			marketplace: FIRST_PARTY_MARKETPLACE,
			pluginName: plugin,
			version: manifest.version,
			manifest,
			enabled: true,
		})
		.onConflictDoUpdate({
			target: [
				pluginInstalls.userId,
				pluginInstalls.marketplace,
				pluginInstalls.pluginName,
			],
			set: {
				version: manifest.version,
				manifest,
				enabled: true,
				organizationId,
			},
		})
		.returning();

	return Response.json({
		install: {
			id: row?.id,
			plugin,
			version: manifest.version,
			marketplace: FIRST_PARTY_MARKETPLACE,
		},
		// The client shows a connect prompt when this is true and no connection
		// exists yet; tools stay unavailable until one does.
		needsConnection: Boolean(manifest.extensions?.superset?.auth),
	});
}

/**
 * Enable or disable an install. The record stays; `enabled` is what the
 * catalog reports and what each machine reconciles its local materialization
 * against, so the account stays the source of truth for both.
 */
export async function PATCH(
	request: Request,
	{ params }: { params: Promise<{ plugin: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin } = await params;
	// `JSON.parse("null")` succeeds and yields null, which then throws on
	// property access — a 500 for what is a malformed request.
	const body = ((await request.json().catch(() => ({}))) ?? {}) as {
		enabled?: unknown;
	};
	if (typeof body.enabled !== "boolean") {
		return Response.json(
			{ error: "`enabled` must be a boolean" },
			{ status: 400 },
		);
	}

	const resolved = await resolveInstall(session.user.id, plugin, request);
	if (!resolved.ok) return resolved.response;

	const [row] = await db
		.update(pluginInstalls)
		.set({ enabled: body.enabled })
		.where(eq(pluginInstalls.id, resolved.install.id))
		.returning();

	if (!row) {
		return Response.json(
			{ error: `"${plugin}" is not installed` },
			{ status: 404 },
		);
	}

	return Response.json({
		plugin,
		marketplace: row.marketplace,
		enabled: row.enabled,
	});
}

/** Uninstall, and disconnect anything authorized for the plugin. */
export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ plugin: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin } = await params;

	const resolved = await resolveInstall(session.user.id, plugin, request);
	if (!resolved.ok) return resolved.response;
	const { id, marketplace, siblings } = resolved.install;

	await db
		.update(pluginConnections)
		.set({ disconnectedAt: new Date(), disconnectReason: "plugin_uninstalled" })
		.where(
			and(
				eq(pluginConnections.userId, session.user.id),
				isNull(pluginConnections.disconnectedAt),
				siblings === 1
					? or(
							eq(pluginConnections.installId, id),
							and(
								isNull(pluginConnections.installId),
								eq(pluginConnections.pluginName, plugin),
							),
						)
					: eq(pluginConnections.installId, id),
			),
		);

	await db.delete(pluginInstalls).where(eq(pluginInstalls.id, id));

	return Response.json({ uninstalled: plugin, marketplace });
}
