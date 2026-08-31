import { auth } from "@superset/auth/server";
import {
	getConnection,
	installedManifest,
	templateScope,
} from "@/lib/plugins/connections";
import { callTool, PluginDispatchError } from "@/lib/plugins/dispatch";

/** Invoke one tool. Body is the tool's arguments object. */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ connectionId: string; tool: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { connectionId, tool } = await params;
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

	let args: Record<string, unknown> = {};
	try {
		const body = await request.text();
		if (body.trim()) args = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Body must be JSON" }, { status: 400 });
	}

	try {
		const result = await callTool(
			manifest,
			await templateScope(connection),
			tool,
			args,
			connection.authMethod,
		);
		return Response.json({ result });
	} catch (error) {
		if (error instanceof PluginDispatchError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
}
