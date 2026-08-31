import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CLIError } from "@superset/cli-framework";
import { type InstalledPlugin, readInstalledPlugins } from "./host";
import { type PluginManifest, supersetExtension } from "./marketplace";

export interface McpServerRef {
	plugin: string;
	marketplace: string;
	server: string;
	kind: "remote" | "bundled";
	url?: string;
	modulePath?: string;
	version: string;
	needsAuth: boolean;
}

function readManifest(plugin: InstalledPlugin): PluginManifest | null {
	const file = path.join(plugin.installPath, "plugin.json");
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as PluginManifest;
	} catch {
		return null;
	}
}

export function listServers(): McpServerRef[] {
	const servers: McpServerRef[] = [];

	for (const plugin of readInstalledPlugins()) {
		if (!plugin.enabled) continue;
		const manifest = readManifest(plugin);
		if (!manifest) continue;
		const extension = supersetExtension(manifest);
		const needsAuth = Boolean(extension?.auth);

		if (extension?.mcp?.url) {
			servers.push({
				plugin: plugin.name,
				marketplace: plugin.marketplace,
				server: plugin.name,
				kind: "remote",
				url: extension.mcp.url,
				version: plugin.version,
				needsAuth,
			});
		}

		const bundled = path.join(plugin.installPath, "server", "index.mjs");
		if (fs.existsSync(bundled)) {
			servers.push({
				plugin: plugin.name,
				marketplace: plugin.marketplace,
				server: plugin.name,
				kind: "bundled",
				modulePath: bundled,
				version: plugin.version,
				needsAuth,
			});
		}
	}

	return servers;
}

export function resolveServer(name: string): McpServerRef {
	const servers = listServers();
	const matches = servers.filter((s) => s.server === name || s.plugin === name);
	if (matches.length === 0) {
		throw new CLIError(
			`No installed MCP server named "${name}". Run: superset mcp list`,
		);
	}
	if (matches.length > 1) {
		throw new CLIError(
			`"${name}" matches ${matches.map((m) => `${m.plugin}/${m.server}`).join(", ")}; be more specific.`,
		);
	}
	const found = matches[0];
	if (!found) throw new CLIError(`No installed MCP server named "${name}".`);
	return found;
}

const RPC_REQUEST_ID = 1;

const moduleCache = new Map<
	string,
	{ run: (payload: unknown) => Promise<unknown> }
>();

async function loadModule(modulePath: string) {
	const cached = moduleCache.get(modulePath);
	if (cached) return cached;

	const stat = fs.statSync(modulePath);
	const url = `${pathToFileURL(modulePath).href}?v=${stat.mtimeMs}`;
	const mod = (await import(url)) as {
		run?: (payload: unknown) => Promise<unknown>;
	};
	if (typeof mod.run !== "function") {
		throw new CLIError(`${modulePath} does not export a run() function.`);
	}
	const loaded = { run: mod.run };
	moduleCache.set(modulePath, loaded);
	return loaded;
}

async function rpc(
	url: string,
	method: string,
	params: unknown,
	token?: string,
): Promise<unknown> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	if (token) headers.authorization = `Bearer ${token}`;

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: RPC_REQUEST_ID,
			method,
			params,
		}),
	});

	if (response.status === 401 || response.status === 403) {
		throw new CLIError(
			`${url} rejected the request (${response.status}). Pass --token, or wait for the credential proxy.`,
		);
	}
	if (!response.ok) {
		throw new CLIError(
			`${url} returned ${response.status} ${response.statusText}`,
		);
	}

	// Same framing rule as the server proxy: streamable-http may answer as JSON
	// or SSE, and a stream can carry notifications before the result. Match on
	// the request id rather than assuming the last frame is the response.
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
		if (payload.id !== RPC_REQUEST_ID) continue;
		if (payload.error) throw new CLIError(payload.error.message);
		return payload.result;
	}

	throw new CLIError(`${url} returned no JSON-RPC response for this request.`);
}

export async function serverTools(
	server: McpServerRef,
	token?: string,
): Promise<Array<{ name: string; description?: string }>> {
	if (server.kind === "bundled") {
		const mod = await loadModule(server.modulePath as string);
		const result = await mod.run({
			event: "get-tools",
			eventBody: {},
			config: { access_token: token ?? "" },
		});
		return result as Array<{ name: string; description?: string }>;
	}

	const result = (await rpc(server.url as string, "tools/list", {}, token)) as {
		tools?: Array<{ name: string; description?: string }>;
	};
	return result.tools ?? [];
}

export async function serverCallTool(
	server: McpServerRef,
	tool: string,
	args: Record<string, unknown>,
	token?: string,
): Promise<unknown> {
	if (server.kind === "bundled") {
		const mod = await loadModule(server.modulePath as string);
		return await mod.run({
			event: "call-tool",
			eventBody: { name: tool, arguments: args },
			config: { access_token: token ?? "" },
		});
	}

	return await rpc(
		server.url as string,
		"tools/call",
		{ name: tool, arguments: args },
		token,
	);
}
