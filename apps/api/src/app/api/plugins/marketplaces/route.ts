import { auth } from "@superset/auth/server";
import { db } from "@superset/db/client";
import { pluginMarketplaces } from "@superset/db/schema";
import { FIRST_PARTY_MANIFESTS } from "@superset/shared/plugins";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

const FIRST_PARTY = "superset";

const addSchema = z.object({
	name: z.string().min(1),
	sourceKind: z.enum(["github", "path"]),
	repo: z.string().min(1).optional(),
	ref: z.string().min(1).optional(),
	path: z.string().min(1).optional(),
});

/**
 * The marketplaces this user has. The first-party one is always present and is
 * not a row: it is compiled into the clients, so it exists before any request
 * succeeds and cannot be removed.
 */
export async function GET(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const rows = await db
		.select()
		.from(pluginMarketplaces)
		.where(eq(pluginMarketplaces.userId, session.user.id))
		.orderBy(asc(pluginMarketplaces.name));

	return Response.json({
		marketplaces: [
			{
				name: FIRST_PARTY,
				builtin: true,
				sourceKind: "builtin",
				plugins: Object.keys(FIRST_PARTY_MANIFESTS).length,
			},
			...rows
				.filter((row) => row.name !== FIRST_PARTY)
				.map((row) => ({
					name: row.name,
					builtin: false,
					sourceKind: row.sourceKind,
					repo: row.repo,
					ref: row.ref,
					path: row.path,
					addedAt: row.addedAt,
				})),
		],
	});
}

/** Add a marketplace. Adding one that exists updates its source. */
export async function POST(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const parsed = addSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid body" },
			{ status: 400 },
		);
	}
	if (parsed.data.name === FIRST_PARTY) {
		return Response.json(
			{ error: `"${FIRST_PARTY}" is built in and cannot be replaced` },
			{ status: 400 },
		);
	}

	const organizationId =
		new URL(request.url).searchParams.get("organizationId") ?? null;

	const [row] = await db
		.insert(pluginMarketplaces)
		.values({
			userId: session.user.id,
			organizationId,
			name: parsed.data.name,
			sourceKind: parsed.data.sourceKind,
			repo: parsed.data.repo ?? null,
			ref: parsed.data.ref ?? null,
			path: parsed.data.path ?? null,
		})
		.onConflictDoUpdate({
			target: [pluginMarketplaces.userId, pluginMarketplaces.name],
			set: {
				sourceKind: parsed.data.sourceKind,
				repo: parsed.data.repo ?? null,
				ref: parsed.data.ref ?? null,
				path: parsed.data.path ?? null,
				organizationId,
			},
		})
		.returning();

	return Response.json({
		marketplace: { id: row?.id, name: parsed.data.name },
	});
}
