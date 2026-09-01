import { auth } from "@superset/auth/server";
import {
	bundledSource,
	getConnection,
	installForConnection,
	pluginErrorResponse,
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

	let install: Awaited<ReturnType<typeof installForConnection>>;
	try {
		install = await installForConnection(session.user.id, connection);
	} catch (error) {
		const response = pluginErrorResponse(error);
		if (!response) throw error;
		return response;
	}
	if (!install) {
		return Response.json(
			{ error: `Plugin "${connection.pluginName}" is not installed` },
			{ status: 404 },
		);
	}

	let args: Record<string, unknown> = {};
	const source = await bundledSource(session.user.id, install.marketplace);

	try {
		const body = await request.text();
		if (body.trim()) args = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Body must be JSON" }, { status: 400 });
	}

	try {
		const result = await callTool(
			install.manifest,
			await templateScope(connection),
			tool,
			args,
			connection.authMethod,
			source,
		);
		return Response.json({ result });
	} catch (error) {
		if (error instanceof PluginDispatchError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
}
