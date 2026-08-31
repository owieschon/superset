import { auth } from "@superset/auth/server";
import { pluginContext } from "@/lib/plugins/connections";
import { callTool, PluginDispatchError } from "@/lib/plugins/dispatch";

/** Invoke one tool, addressed by plugin. Body is the tool's arguments object. */
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ plugin: string; tool: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { plugin, tool } = await params;
	const resolved = await pluginContext(session.user.id, plugin);
	if (!resolved.ok) {
		return Response.json(
			{ error: resolved.error },
			{ status: resolved.status },
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
			resolved.context.manifest,
			resolved.context.scope,
			tool,
			args,
			resolved.context.authMethod,
			resolved.context.bundled,
		);
		return Response.json({ result });
	} catch (error) {
		if (error instanceof PluginDispatchError) {
			return Response.json({ error: error.message }, { status: error.status });
		}
		throw error;
	}
}
