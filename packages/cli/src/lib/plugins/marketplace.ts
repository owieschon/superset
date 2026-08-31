import fs from "node:fs";
import path from "node:path";
import { CLIError } from "@superset/cli-framework";

export const MARKETPLACE_FILE = ".agent-marketplace.json";
export const SUPERSET_EXTENSION = "superset";

export interface MarketplaceEntry {
	name: string;
	description?: string;
	author?: { name: string; url?: string };
	category?: string;
	source: string;
	version?: string;
}

export interface Marketplace {
	name: string;
	description?: string;
	owner?: { name: string; url?: string };
	plugins: MarketplaceEntry[];
	featured?: string[];
	renames?: Record<string, string>;
}

export interface AuthInput {
	name: string;
	label?: string;
	placeholder?: string;
	description?: string;
	required?: boolean;
	secret?: boolean;
}

/**
 * How to resolve which external account a connection belongs to, right after
 * auth completes. Optional: without it a connection gets a generated id and no
 * label, which is fine until one user needs two connections to one plugin.
 */
export interface AuthIdentity {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: unknown;
	/** JSONPath-lite ($.a.b[0].c) to the stable account id. */
	id: string;
	/** JSONPath-lite to a human-readable name. */
	label?: string;
}

/**
 * One way to authenticate a plugin. A plugin may offer several — Linear takes
 * both an OAuth token and a personal API key — and they are not
 * interchangeable: Linear sends OAuth tokens as `Bearer <token>` and API keys
 * raw, so `identity` and `bind` belong to the method, not the plugin.
 */
export interface PluginAuthMethod {
	type: "oauth2" | "api_key";
	/** Shown in the picker when a plugin offers more than one method. */
	label?: string;
	provider?: string;
	inputs?: AuthInput[];
	/** api_key only: which input becomes the connection's access token. */
	credential_input?: string;
	authorization_url?: string;
	token_url?: string;
	scopes?: string[];
	scope_separator?: string;
	token_request_auth_method?: string;
	token_expiration_buffer?: number;
	/**
	 * Documentation only: the deployment-level variables an operator must set
	 * before this plugin's OAuth flow can run. Never read to resolve a value —
	 * the host derives variable names from the plugin name, so a manifest can
	 * never point the credential lookup at an unrelated secret. `check`
	 * verifies these match what the host would derive.
	 */
	requires_env?: string[];
	identity?: AuthIdentity;
	bind?: PluginBind;
}

export type PluginAuth = PluginAuthMethod[];

/** The variables a deployment must set for `name`'s OAuth flow. */
export function requiredEnvFor(name: string): string[] {
	const slug = name.toUpperCase().replace(/[.-]/g, "_");
	return [`PLUGIN_${slug}_CLIENT_ID`, `PLUGIN_${slug}_CLIENT_SECRET`];
}

export interface PluginMcp {
	type: "streamable-http";
	url: string;
	headers?: Record<string, string>;
}

export interface PluginBind {
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export interface SupersetExtension {
	interface?: { displayName: string; category?: string; icon?: string };
	auth?: PluginAuth;
	/** Fallback when a method declares no bind of its own. */
	bind?: PluginBind;
	mcp?: PluginMcp;
}

export interface PluginManifest {
	name: string;
	version: string;
	description?: string;
	extensions?: Record<string, SupersetExtension>;
}

export function supersetExtension(
	manifest: PluginManifest,
): SupersetExtension | undefined {
	return manifest.extensions?.[SUPERSET_EXTENSION];
}

export interface ResolvedPlugin {
	entry: MarketplaceEntry;
	dir: string;
	manifest: PluginManifest;
	hasServerSource: boolean;
	hasSkills: boolean;
	hasRemoteServer: boolean;
}

export interface MarketplaceContext {
	root: string;
	file: string;
	marketplace: Marketplace;
}

function readJson<T>(file: string): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (error) {
		throw new CLIError(
			`Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function writeJson(file: string, value: unknown): void {
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

export function findMarketplace(from = process.cwd()): MarketplaceContext {
	let dir = path.resolve(from);
	for (;;) {
		const candidate = path.join(dir, MARKETPLACE_FILE);
		if (fs.existsSync(candidate)) {
			return {
				root: dir,
				file: candidate,
				marketplace: readJson<Marketplace>(candidate),
			};
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new CLIError(
				`No ${MARKETPLACE_FILE} found in ${from} or any parent directory.`,
			);
		}
		dir = parent;
	}
}

export function resolvePlugin(
	ctx: MarketplaceContext,
	entry: MarketplaceEntry,
): ResolvedPlugin {
	if (typeof entry.source !== "string") {
		throw new CLIError(
			`Plugin "${entry.name}" uses a non-string source; only "./path" sources are supported.`,
		);
	}

	const dir = path.resolve(ctx.root, entry.source);
	if (!dir.startsWith(`${ctx.root}${path.sep}`)) {
		throw new CLIError(
			`Plugin "${entry.name}" resolves outside the marketplace root.`,
		);
	}

	const manifestPath = path.join(dir, "plugin.json");
	if (!fs.existsSync(manifestPath)) {
		throw new CLIError(`Plugin "${entry.name}" has no plugin.json at ${dir}.`);
	}

	const manifest = readJson<PluginManifest>(manifestPath);
	if (manifest.name !== entry.name) {
		throw new CLIError(
			`Plugin "${entry.name}" declares name "${manifest.name}" in plugin.json; they must match.`,
		);
	}

	return {
		entry,
		dir,
		manifest,
		hasServerSource: fs.existsSync(path.join(dir, "src", "index.ts")),
		hasSkills: fs.existsSync(path.join(dir, "skills")),
		hasRemoteServer: Boolean(supersetExtension(manifest)?.mcp),
	};
}

export function resolvePlugins(
	ctx: MarketplaceContext,
	names?: string[],
): ResolvedPlugin[] {
	const wanted = names?.length ? new Set(names) : null;
	if (wanted) {
		const known = new Set(ctx.marketplace.plugins.map((p) => p.name));
		for (const name of wanted) {
			if (!known.has(name)) {
				throw new CLIError(
					`Unknown plugin "${name}". Known: ${[...known].sort().join(", ")}`,
				);
			}
		}
	}
	return ctx.marketplace.plugins
		.filter((entry) => !wanted || wanted.has(entry.name))
		.map((entry) => resolvePlugin(ctx, entry));
}

export function versionDir(plugin: ResolvedPlugin, version: string): string {
	return path.join(plugin.dir, "versions", version);
}

export function publishedVersions(plugin: ResolvedPlugin): string[] {
	const dir = path.join(plugin.dir, "versions");
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort(compareVersions);
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function bumpVersion(
	version: string,
	level: "major" | "minor" | "patch",
): string {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
		throw new CLIError(`Version "${version}" is not semver.`);
	}
	if (level === "major") return `${major + 1}.0.0`;
	if (level === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}
