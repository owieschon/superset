import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BundledSource } from "./connections";
import {
	credentialFetch,
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
	// `headers` carries the connection's bound credential, so this is https-only
	// and does not follow a redirect to a host the manifest did not name.
	const response = await credentialFetch(
		url,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: REQUEST_ID, method, params }),
		},
		"mcp",
	);

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

type BundledRun = (event: {
	event: "get-tools" | "call-tool";
	eventBody: Record<string, unknown>;
	config: Record<string, unknown>;
}) => Promise<unknown> | unknown;

interface ServerRef {
	/** Repo-root relative, stamped by `plugins publish` and version-pinned. */
	path: string;
	/** `sha256-<base64>` of the published artifact. */
	integrity: string;
}

// Keyed by integrity, so a republished server is a different entry rather than
// a stale module the ESM loader would keep serving, and two plugins that ship
// byte-identical servers share one load.
const loaded = new Map<string, Promise<BundledRun>>();

// The specifier is a path that only exists at runtime, so it has to stay opaque
// to the build: a bare `import(file)` is rewritten by the bundler into a lookup
// in its own module map, which then fails to resolve a temp file it never saw.
const importAtRuntime = new Function(
	"specifier",
	"return import(specifier)",
) as (specifier: string) => Promise<{ run?: BundledRun }>;

// A plugin server is a bundle, not an application; anything this size is a
// mistake or an attack, and /tmp is small on the runtimes this deploys to.
const MAX_SERVER_BYTES = 8 * 1024 * 1024;

function serverRef(manifest: PluginManifest): ServerRef | null {
	const server = supersetExtension(manifest)?.server;
	if (!server?.path || !server.integrity) return null;
	return { path: server.path, integrity: server.integrity };
}

function digestOf(source: Buffer): string {
	return `sha256-${createHash("sha256").update(source).digest("base64")}`;
}

async function* streamOf(response: Response): AsyncGenerator<Buffer> {
	const reader = response.body?.getReader();
	if (!reader) return;
	while (true) {
		const { done, value } = await reader.read();
		if (done) return;
		if (value) yield Buffer.from(value);
	}
}

let serverCacheDir: string | undefined;
function cacheDir(): string {
	if (!serverCacheDir) {
		serverCacheDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "superset-plugin-servers-"),
		);
		fs.chmodSync(serverCacheDir, 0o700);
	}
	return serverCacheDir;
}

/**
 * Downloads the exact artifact the installed version published.
 *
 * The digest comes from the manifest the account already trusts, so the
 * download is only a byte source: a force-pushed branch, a swapped CDN
 * response, or a truncated body all fail the comparison instead of reaching
 * `import()`. That check is what makes fetching remote code at request time
 * defensible at all — this runs in the API's own process, with its database
 * handle and every provider secret in scope.
 */
async function fetchServer(
	pluginName: string,
	source: BundledSource,
	ref: ServerRef,
): Promise<Buffer> {
	const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${ref.path}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new PluginDispatchError(
			`Could not download the server for "${pluginName}" (${response.status} from ${url}).`,
			502,
		);
	}

	const chunks: Buffer[] = [];
	let total = 0;
	const tooLarge = () =>
		new PluginDispatchError(
			`Server for "${pluginName}" is over the ${MAX_SERVER_BYTES} byte limit.`,
			502,
		);

	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_SERVER_BYTES) {
		await response.body?.cancel();
		throw tooLarge();
	}

	for await (const chunk of streamOf(response)) {
		total += chunk.byteLength;
		if (total > MAX_SERVER_BYTES) {
			await response.body?.cancel();
			throw tooLarge();
		}
		chunks.push(chunk);
	}
	const body = Buffer.concat(chunks);

	const actual = digestOf(body);
	if (actual !== ref.integrity) {
		throw new PluginDispatchError(
			`Server for "${pluginName}" does not match the published digest; refusing to run it.`,
			502,
		);
	}
	return body;
}

/**
 * Resolves the plugin's server to a module, downloading it once per version.
 *
 * `import()` needs a real path and the deployed bundle is read-only, so the
 * verified bytes are written to the temp dir. A file already there was written
 * by this deployment under its own digest, so it is reused without a round
 * trip; a runtime that recycles that directory just downloads again on the next
 * cold start. That is the whole cache: first call per version pays the fetch,
 * every later one is a map hit.
 */
async function bundledRun(
	pluginName: string,
	manifest: PluginManifest,
	source: BundledSource | null,
): Promise<BundledRun> {
	const ref = serverRef(manifest);
	if (!ref) {
		throw new PluginDispatchError(
			`Plugin "${pluginName}" declares no mcp url and no published server.`,
			501,
		);
	}
	if (!source) {
		throw new PluginDispatchError(
			`Plugin "${pluginName}" came from a marketplace this server cannot reach, so its bundled server cannot be downloaded.`,
			501,
		);
	}

	const cached = loaded.get(ref.integrity);
	if (cached) return await cached;

	const load = (async () => {
		// Base64url of the digest: it is the cache key, and it cannot contain a
		// path separator the way the raw base64 can.
		const key = Buffer.from(ref.integrity).toString("base64url");
		const dir = cacheDir();
		const file = path.join(dir, `${key}.mjs`);

		let usable = false;
		try {
			usable = digestOf(await fs.promises.readFile(file)) === ref.integrity;
		} catch {
			usable = false;
		}

		if (!usable) {
			const body = await fetchServer(pluginName, source, ref);
			// Written then renamed: two concurrent requests on a cold start would
			// otherwise let one import a half-written module.
			const staging = `${file}.${process.pid}.partial`;
			await fs.promises.writeFile(staging, body);
			await fs.promises.rename(staging, file);
		}

		const module = await importAtRuntime(pathToFileURL(file).href);
		if (typeof module.run !== "function") {
			throw new PluginDispatchError(
				`Plugin "${pluginName}" server exports no run().`,
				500,
			);
		}
		return module.run;
	})();

	loaded.set(ref.integrity, load);
	try {
		return await load;
	} catch (error) {
		// A failed load must not be cached, or every later request inherits it.
		loaded.delete(ref.integrity);
		throw error;
	}
}

/** The plugin's own config shape: inputs alongside the resolved credential. */
function bundledConfig(scope: TemplateScope): Record<string, unknown> {
	return { ...(scope.inputs ?? {}), ...(scope.config ?? {}) };
}

async function bundledDispatch(
	manifest: PluginManifest,
	scope: TemplateScope,
	source: BundledSource | null,
	event: "get-tools" | "call-tool",
	eventBody: Record<string, unknown>,
): Promise<unknown> {
	const pluginName = manifest.name;
	const run = await bundledRun(pluginName, manifest, source);
	try {
		return await run({ event, eventBody, config: bundledConfig(scope) });
	} catch (error) {
		throw new PluginDispatchError(
			`Bundled server for "${pluginName}" failed: ${error instanceof Error ? error.message : String(error)}`,
			502,
		);
	}
}

export async function listTools(
	manifest: PluginManifest,
	scope: TemplateScope,
	method?: string | null,
	source?: BundledSource | null,
): Promise<ToolDefinition[]> {
	const target = remoteTarget(manifest, scope, method);
	if (!target) {
		const tools = await bundledDispatch(
			manifest,
			scope,
			source ?? null,
			"get-tools",
			{},
		);
		return Array.isArray(tools) ? (tools as ToolDefinition[]) : [];
	}

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
	source?: BundledSource | null,
): Promise<unknown> {
	const target = remoteTarget(manifest, scope, method);
	if (!target) {
		return await bundledDispatch(manifest, scope, source ?? null, "call-tool", {
			name: tool,
			arguments: args,
		});
	}

	return await rpc(target.url, target.headers, "tools/call", {
		name: tool,
		arguments: args,
	});
}
