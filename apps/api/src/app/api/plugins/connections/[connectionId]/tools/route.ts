import { auth } from "@superset/auth/server";
import {
	getConnection,
	installedManifest,
	templateScope,
} from "@/lib/plugins/connections";
import { listTools, PluginDispatchError } from "@/lib/plugins/dispatch";

/** The tools this connection's plugin exposes, called with its credential. */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ connectionId: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { connectionId } = await params;
	const connection = await getConnection(session.user.id, connectionId);
	if (!connection) {
		return Response.json({ error: "Connection not found" }, { status: 404 });
	}

	const manifest = await installedManifest(
		session.user.id,
		connection.pluginName,
	);
	if (!manifest) {
		return Response.json(
			{ error: `Plugin "${connection.pluginName}" is not installed` },
			{ status: 404 },
		);
	}

	try {
		const tools = await listTools(
			manifest,
			await templateScope(connection),
			connection.authMethod,
		);
		return Response.json({ plugin: connection.pluginName, tools });
	} catch (error) {
		if (error instanceof PluginDispatchError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
}
