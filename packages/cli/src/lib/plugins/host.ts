import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLIError } from "@superset/cli-framework";
import { MARKETPLACE_FILE, type Marketplace } from "./marketplace";

export {
	DEFAULT_MARKETPLACE,
	DEFAULT_MARKETPLACE_REF,
	DEFAULT_MARKETPLACE_REPO,
} from "@superset/shared/plugins";

export interface MarketplaceSource {
	kind: "github" | "path";
	repo?: string;
	/** Branch or tag. Omitted means the repo's default branch. */
	ref?: string;
	path?: string;
}

export interface KnownMarketplace {
	source: MarketplaceSource;
	installLocation: string;
	lastUpdated: string;
}

export interface InstalledPlugin {
	marketplace: string;
	name: string;
	version: string;
	installPath: string;
	installedAt: string;
	enabled: boolean;
}

export function supersetHome(): string {
	return process.env.SUPERSET_HOME ?? path.join(os.homedir(), ".superset");
}

export function pluginsRoot(): string {
	return path.join(supersetHome(), "plugins");
}

/**
 * Where provisioned skills land. This is `~/.agents/skills`, not a Superset
 * directory: it is the path Codex, Vibe, and Kimi discover natively, and the
 * one agent-setup provisions into. A Superset-private directory would be read
 * by nothing.
 */
export function skillsRoot(): string {
	return path.join(os.homedir(), ".agents", "skills");
}

export function marketplacesDir(): string {
	return path.join(pluginsRoot(), "marketplaces");
}

export function cacheDir(): string {
	return path.join(pluginsRoot(), "cache");
}

function knownFile(): string {
	return path.join(pluginsRoot(), "known_marketplaces.json");
}

function installedFile(): string {
	return path.join(pluginsRoot(), "installed_plugins.json");
}

function readJsonFile<T>(file: string, fallback: T): T {
	if (!fs.existsSync(file)) return fallback;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJsonFile(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

export function readKnownMarketplaces(): Record<string, KnownMarketplace> {
	return readJsonFile<Record<string, KnownMarketplace>>(knownFile(), {});
}

export function writeKnownMarketplaces(
	value: Record<string, KnownMarketplace>,
): void {
	writeJsonFile(knownFile(), value);
}

export function readInstalledPlugins(): InstalledPlugin[] {
	const raw = readJsonFile<{ version: number; plugins: InstalledPlugin[] }>(
		installedFile(),
		{ version: 1, plugins: [] },
	);
	return raw.plugins ?? [];
}

export function writeInstalledPlugins(plugins: InstalledPlugin[]): void {
	writeJsonFile(installedFile(), { version: 1, plugins });
}

export function marketplaceManifest(name: string): Marketplace {
	const known = readKnownMarketplaces()[name];
	if (!known) {
		throw new CLIError(
			`Marketplace "${name}" is not installed. Run: superset marketplace install <github-url>`,
		);
	}
	const file = path.join(known.installLocation, MARKETPLACE_FILE);
	if (!fs.existsSync(file)) {
		throw new CLIError(
			`Marketplace "${name}" has no ${MARKETPLACE_FILE} at ${known.installLocation}.`,
		);
	}
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Marketplace;
	} catch (error) {
		throw new CLIError(
			`Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Names that are safe to join into a filesystem path. Marketplace-controlled
 * values reach path.join, and path.join normalizes `..`, so an unvalidated
 * version like "1.0.0/../../../.." escapes the cache root — which then gets
 * rmSync'd recursively. Validate before joining, not after.
 */
const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function assertSafeSegment(value: string, label: string): string {
	if (!SAFE_SEGMENT.test(value) || value.includes("..")) {
		throw new CLIError(
			`Refusing to use ${label} "${value}": it must be alphanumeric with dots, dashes, or underscores, and cannot contain "..".`,
		);
	}
	return value;
}

export function pluginCachePath(
	marketplace: string,
	name: string,
	version: string,
): string {
	return path.join(
		cacheDir(),
		assertSafeSegment(marketplace, "marketplace"),
		assertSafeSegment(name, "plugin name"),
		assertSafeSegment(version, "version"),
	);
}

export function findInstalled(
	plugins: InstalledPlugin[],
	name: string,
	marketplace?: string,
): InstalledPlugin | undefined {
	return plugins.find(
		(p) => p.name === name && (!marketplace || p.marketplace === marketplace),
	);
}

export function parsePluginRef(ref: string): {
	name: string;
	marketplace?: string;
} {
	const at = ref.lastIndexOf("@");
	if (at <= 0) return { name: ref };
	return { name: ref.slice(0, at), marketplace: ref.slice(at + 1) };
}
