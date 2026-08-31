import {
	type PluginManifest,
	resolveTemplate,
	resolveTemplateDeep,
	supersetExtension,
	type TemplateScope,
} from "./manifest";

export interface ToolDefinition {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: Record<string, unknown>;
}

// Every call is one request/response round trip, so a fixed id is enough —
// and it is what identifies our response among frames that may also carry
// notifications.
const REQUEST_ID = 1;

export class PluginDispatchError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function rpc(
	url: string,
	headers: Record<string, string>,
	method: string,
	params: unknown,
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: REQUEST_ID, method, params }),
	});

	if (response.status === 401 || response.status === 403) {
		throw new PluginDispatchError(
			`Upstream rejected the credential (${response.status}); reconnect the plugin.`,
			401,
		);
	}
	if (!response.ok) {
		throw new PluginDispatchError(
			`Upstream returned ${response.status} ${response.statusText}`,
			502,
		);
	}

	// Streamable HTTP answers either as application/json or as an SSE-framed
	// stream — GitHub's server does the latter, and 400s unless text/event-stream
	// is in Accept. A stream can carry progress notifications before the result,
	// and notifications have no `id`, so match the response by request id rather
	// than taking the last line.
	const text = await response.text();
	const frames = text
		.split("\n")
		.map((line) =>
			line.startsWith("data:") ? line.slice(5).trim() : line.trim(),
		)
		.filter(Boolean);

	for (const frame of frames.reverse()) {
		let payload: {
			id?: unknown;
			result?: unknown;
			error?: { message: string };
		};
		try {
			payload = JSON.parse(frame);
		} catch {
			continue;
		}
		if (payload.id !== REQUEST_ID) continue;
		if (payload.error) {
			throw new PluginDispatchError(payload.error.message, 502);
		}
		return payload.result;
	}

	throw new PluginDispatchError(
		"Upstream returned no JSON-RPC response for this request",
		502,
	);
}

function remoteTarget(
	manifest: PluginManifest,
	scope: TemplateScope,
	method?: string | null,
) {
	const extension = supersetExtension(manifest);
	const mcp = extension?.mcp;
	if (!mcp?.url) return null;

	// The method's own bind wins: two methods on one plugin can need different
	// headers — Linear sends OAuth tokens as `Bearer <token>` and personal API
	// keys raw, so using the wrong one fails authentication outright.
	const methodBind = method
		? extension?.auth?.find((entry) => entry.type === method)?.bind
		: undefined;

	const headers: Record<string, string> = {
		...resolveTemplateDeep(mcp.headers ?? {}, scope),
		...resolveTemplateDeep(methodBind ?? extension?.bind ?? {}, scope).headers,
	};
	// Resolved like the auth URLs are: a per-tenant server such as
	// https://${inputs.site}/mcp would otherwise be fetched literally.
	return { url: resolveTemplate(mcp.url, scope), headers };
}

/**
 * Bundled servers are JS modules the host imports and calls run() on. They are
 * not yet reachable from this deployment: the module has to be fetched to a
 * writable filesystem and dynamically imported, which a serverless runtime
 * cannot do. Remote plugins work today; this fails loudly rather than
 * pretending.
 */
function bundledUnsupported(pluginName: string): never {
	throw new PluginDispatchError(
		`Plugin "${pluginName}" ships a bundled server, which this deployment cannot run yet. Remote (streamable-http) plugins are supported.`,
		501,
	);
}

export async function listTools(
	manifest: PluginManifest,
	scope: TemplateScope,
	method?: string | null,
): Promise<ToolDefinition[]> {
	const target = remoteTarget(manifest, scope, method);
	if (!target) bundledUnsupported(manifest.name);

	const result = (await rpc(target.url, target.headers, "tools/list", {})) as {
		tools?: ToolDefinition[];
	};
	return result.tools ?? [];
}

export async function callTool(
	manifest: PluginManifest,
	scope: TemplateScope,
	tool: string,
	args: Record<string, unknown>,
	method?: string | null,
): Promise<unknown> {
	const target = remoteTarget(manifest, scope, method);
	if (!target) bundledUnsupported(manifest.name);

	return await rpc(target.url, target.headers, "tools/call", {
		name: tool,
		arguments: args,
	});
}
