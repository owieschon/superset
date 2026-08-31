import { auth } from "@superset/auth/server";
import { db } from "@superset/db/client";
import { pluginInstalls, pluginMarketplaces } from "@superset/db/schema";
import { and, eq } from "drizzle-orm";

const FIRST_PARTY = "superset";

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { name } = await params;
	if (name === FIRST_PARTY) {
		return Response.json(
			{ error: `"${FIRST_PARTY}" is built in and cannot be removed` },
			{ status: 400 },
		);
	}

	// Removing a marketplace whose plugins are still installed would leave
	// installs that can never be resolved again.
	const dependents = await db
		.select({ pluginName: pluginInstalls.pluginName })
		.from(pluginInstalls)
		.where(
			and(
				eq(pluginInstalls.userId, session.user.id),
				eq(pluginInstalls.marketplace, name),
			),
		);
	if (dependents.length) {
		return Response.json(
			{
				error: `${dependents.length} installed plugin${dependents.length === 1 ? "" : "s"} came from "${name}": ${dependents.map((d) => d.pluginName).join(", ")}. Remove them first.`,
			},
			{ status: 409 },
		);
	}

	const removed = await db
		.delete(pluginMarketplaces)
		.where(
			and(
				eq(pluginMarketplaces.userId, session.user.id),
				eq(pluginMarketplaces.name, name),
			),
		)
		.returning({ id: pluginMarketplaces.id });

	if (!removed.length) {
		return Response.json({ error: `"${name}" is not added` }, { status: 404 });
	}
	return Response.json({ removed: name });
}
