import { auth } from "@superset/auth/server";
import { pluginContext } from "@/lib/plugins/connections";
import { listTools, PluginDispatchError } from "@/lib/plugins/dispatch";

/**
 * A plugin's tools, addressed by plugin rather than connection — the only way
 * to reach a plugin that declares no auth, and the ergonomic path when a user
 * has exactly one connection. Several connections are ambiguous and answer 409
 * pointing at the connection-addressed route.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ plugin: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin } = await params;
	const resolved = await pluginContext(session.user.id, plugin);
	if (!resolved.ok) {
		return Response.json(
			{ error: resolved.error },
			{ status: resolved.status },
		);
	}

	try {
		const tools = await listTools(
			resolved.context.manifest,
			resolved.context.scope,
			resolved.context.authMethod,
		);
		return Response.json({ plugin, tools });
	} catch (error) {
		if (error instanceof PluginDispatchError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
}
