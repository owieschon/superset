import { auth } from "@superset/auth/server";
import { listConnections } from "@/lib/plugins/connections";

/** Connections the caller holds. Tokens are never returned. */
export async function GET(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const plugin = new URL(request.url).searchParams.get("plugin") ?? undefined;
	const connections = await listConnections(session.user.id, plugin);

	return Response.json({
		connections: connections.map((connection) => ({
			id: connection.id,
			plugin: connection.pluginName,
			account: connection.externalAccountLabel,
			accountId: connection.externalAccountId,
			scopes: connection.scopes,
			createdAt: connection.createdAt,
		})),
	});
}
