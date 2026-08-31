import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CLIError } from "@superset/cli-framework";
import {
	assertSafeSegment,
	DEFAULT_MARKETPLACE,
	DEFAULT_MARKETPLACE_REF,
	DEFAULT_MARKETPLACE_REPO,
	type InstalledPlugin,
	type KnownMarketplace,
	type MarketplaceSource,
	marketplaceManifest,
	marketplacesDir,
	pluginCachePath,
	readInstalledPlugins,
	readKnownMarketplaces,
	skillsRoot,
	writeInstalledPlugins,
	writeKnownMarketplaces,
} from "./host";
import { MARKETPLACE_FILE, type MarketplaceEntry } from "./marketplace";

const git = promisify(execFile);

export function parseMarketplaceSource(input: string): MarketplaceSource {
	if (input.startsWith(".") || input.startsWith("/") || input.startsWith("~")) {
		return {
			kind: "path",
			path: path.resolve(input.replace(/^~/, process.env.HOME ?? "~")),
		};
	}
	// owner/repo, a GitHub URL, or either with #branch appended.
	const [target, ref] = input.split("#");
	const github = target?.match(
		/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
	);
	if (github?.[1]) {
		return { kind: "github", repo: github[1], ...(ref ? { ref } : {}) };
	}
	throw new CLIError(
		`Could not read "${input}" as a marketplace. Use owner/repo, a GitHub URL, or a local path.`,
	);
}

export interface InstallMarketplaceResult {
	name: string;
	source: MarketplaceSource;
	location: string;
	plugins: number;
	updated: boolean;
}

export async function installMarketplace(
	source: MarketplaceSource,
	options: { name?: string } = {},
): Promise<InstallMarketplaceResult> {
	let location: string;
	let updated = false;

	if (source.kind === "path") {
		location = source.path as string;
		if (!fs.existsSync(path.join(location, MARKETPLACE_FILE))) {
			throw new CLIError(`No ${MARKETPLACE_FILE} in ${location}.`);
		}
	} else {
		const repo = source.repo as string;
		const slug = assertSafeSegment(
			options.name ?? repo.split("/")[1] ?? repo.replace("/", "-"),
			"marketplace name",
		);
		location = path.join(marketplacesDir(), slug);

		const ref = source.ref;

		if (fs.existsSync(path.join(location, ".git"))) {
			// Reset to FETCH_HEAD rather than origin/HEAD: with a single-branch
			// shallow clone, origin/HEAD is not necessarily the branch we track.
			await git("git", [
				"-C",
				location,
				"fetch",
				"--depth",
				"1",
				"origin",
				ref ?? "HEAD",
			]);
			await git("git", ["-C", location, "reset", "--hard", "FETCH_HEAD"]);
			updated = true;
		} else {
			fs.mkdirSync(path.dirname(location), { recursive: true });
			try {
				await git("git", [
					"clone",
					"--depth",
					"1",
					...(ref ? ["--branch", ref] : []),
					`https://github.com/${repo}.git`,
					location,
				]);
			} catch (error) {
				throw new CLIError(
					`Could not clone ${repo}${ref ? `#${ref}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (!fs.existsSync(path.join(location, MARKETPLACE_FILE))) {
			throw new CLIError(
				`${repo} has no ${MARKETPLACE_FILE} at its root; it is not a marketplace.`,
			);
		}
	}

	const manifest = JSON.parse(
		fs.readFileSync(path.join(location, MARKETPLACE_FILE), "utf8"),
	) as { name?: string; plugins?: MarketplaceEntry[] };

	const name = options.name ?? manifest.name;
	if (!name) throw new CLIError(`${MARKETPLACE_FILE} has no name.`);

	const known = readKnownMarketplaces();
	known[name] = {
		source,
		installLocation: location,
		lastUpdated: new Date().toISOString(),
	} satisfies KnownMarketplace;
	writeKnownMarketplaces(known);

	return {
		name,
		source,
		location,
		plugins: manifest.plugins?.length ?? 0,
		updated,
	};
}

/**
 * Registers the first-party marketplace on first use.
 *
 * SUPERSET_DEFAULT_MARKETPLACE_PATH overrides the source, which is how you
 * point at a working tree while developing a plugin.
 */
export async function ensureDefaultMarketplace(): Promise<void> {
	const known = readKnownMarketplaces();
	if (known[DEFAULT_MARKETPLACE]) return;

	const override = process.env.SUPERSET_DEFAULT_MARKETPLACE_PATH;
	if (override) {
		await installMarketplace(
			{ kind: "path", path: override },
			{ name: DEFAULT_MARKETPLACE },
		);
		return;
	}

	await installMarketplace(
		{
			kind: "github",
			repo: DEFAULT_MARKETPLACE_REPO,
			ref: DEFAULT_MARKETPLACE_REF,
		},
		{ name: DEFAULT_MARKETPLACE },
	);
}

export interface AvailablePlugin {
	marketplace: string;
	entry: MarketplaceEntry;
	installed: boolean;
	installedVersion?: string;
}

export function listAvailable(): AvailablePlugin[] {
	const installed = readInstalledPlugins();
	const out: AvailablePlugin[] = [];
	for (const name of Object.keys(readKnownMarketplaces())) {
		let manifest: ReturnType<typeof marketplaceManifest>;
		try {
			manifest = marketplaceManifest(name);
		} catch {
			continue;
		}
		for (const entry of manifest.plugins ?? []) {
			const match = installed.find(
				(p) => p.name === entry.name && p.marketplace === name,
			);
			out.push({
				marketplace: name,
				entry,
				installed: Boolean(match),
				installedVersion: match?.version,
			});
		}
	}
	return out;
}

function sourceDir(marketplace: string, entry: MarketplaceEntry): string {
	const known = readKnownMarketplaces()[marketplace];
	if (!known)
		throw new CLIError(`Marketplace "${marketplace}" is not installed.`);
	if (typeof entry.source !== "string") {
		throw new CLIError(
			`Plugin "${entry.name}" uses a non-string source, which is not supported.`,
		);
	}
	const root = path.resolve(known.installLocation);
	const dir = path.resolve(root, entry.source);
	// The separator matters: without it "../foo-evil/payload" against root
	// ".../foo" resolves to ".../foo-evil/payload", which string-prefixes the
	// root and passes.
	if (dir !== root && !dir.startsWith(`${root}${path.sep}`)) {
		throw new CLIError(
			`Plugin "${entry.name}" resolves outside its marketplace.`,
		);
	}
	return dir;
}

function copyTree(from: string, to: string): void {
	fs.mkdirSync(to, { recursive: true });
	for (const item of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, item.name);
		const dest = path.join(to, item.name);
		if (item.isDirectory()) copyTree(src, dest);
		else fs.copyFileSync(src, dest);
	}
}

export interface InstallPluginResult {
	name: string;
	marketplace: string;
	version: string;
	installPath: string;
	skills: number;
}

export function installPlugin(
	name: string,
	marketplace?: string,
): InstallPluginResult {
	const candidates = listAvailable().filter(
		(a) =>
			a.entry.name === name && (!marketplace || a.marketplace === marketplace),
	);

	if (candidates.length === 0) {
		throw new CLIError(
			`No plugin "${name}" in any installed marketplace. Run: superset plugins list --available`,
		);
	}
	if (candidates.length > 1) {
		throw new CLIError(
			`"${name}" exists in ${candidates.map((c) => c.marketplace).join(", ")}. Disambiguate with ${name}@<marketplace>.`,
		);
	}

	const found = candidates[0];
	if (!found) throw new CLIError(`No plugin "${name}".`);
	const { entry } = found;
	const dir = sourceDir(found.marketplace, entry);

	const manifestPath = path.join(dir, "plugin.json");
	if (!fs.existsSync(manifestPath)) {
		throw new CLIError(`Plugin "${name}" has no plugin.json.`);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
		version: string;
	};
	const version = assertSafeSegment(
		entry.version ?? manifest.version,
		"version",
	);

	const versioned = path.join(dir, "versions", version);
	const payload = fs.existsSync(versioned) ? versioned : dir;

	const target = pluginCachePath(found.marketplace, name, version);
	if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
	fs.mkdirSync(path.dirname(target), { recursive: true });

	if (payload === dir) {
		fs.mkdirSync(target, { recursive: true });
		for (const item of ["plugin.json"]) {
			const src = path.join(dir, item);
			if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, item));
		}
		for (const item of ["skills", "server"]) {
			const src = path.join(dir, item);
			if (fs.existsSync(src)) copyTree(src, path.join(target, item));
		}
	} else {
		copyTree(payload, target);
	}

	const plugins = readInstalledPlugins().filter(
		(p) => !(p.name === name && p.marketplace === found.marketplace),
	);
	plugins.push({
		marketplace: found.marketplace,
		name,
		version,
		installPath: target,
		installedAt: new Date().toISOString(),
		enabled: true,
	} satisfies InstalledPlugin);
	writeInstalledPlugins(plugins);

	const skills = syncPlugins().skills;
	return {
		name,
		marketplace: found.marketplace,
		version,
		installPath: target,
		skills,
	};
}

export function removePlugin(
	name: string,
	marketplace?: string,
): InstalledPlugin {
	const plugins = readInstalledPlugins();
	const match = plugins.find(
		(p) => p.name === name && (!marketplace || p.marketplace === marketplace),
	);
	if (!match) throw new CLIError(`"${name}" is not installed.`);

	writeInstalledPlugins(plugins.filter((p) => p !== match));
	if (fs.existsSync(match.installPath)) {
		fs.rmSync(match.installPath, { recursive: true });
	}
	syncPlugins();
	return match;
}

export interface SkillEntry {
	plugin: string;
	marketplace: string;
	skill: string;
	directory: string;
	path: string;
	description: string;
}

const MANAGED_MARKER = ".superset-plugin-skill";

function rewriteSkillName(contents: string, dirName: string): string {
	if (!contents.startsWith("---")) return contents;
	const end = contents.indexOf("\n---", 3);
	if (end === -1) return contents;
	const front = contents.slice(0, end);
	const rest = contents.slice(end);
	if (!/^name:\s*/m.test(front)) return contents;
	return front.replace(/^name:\s*.*$/m, `name: ${dirName}`) + rest;
}

function readDescription(contents: string): string {
	const match = contents.match(/^description:\s*(.+)$/m);
	return match?.[1]?.trim() ?? "";
}

export interface SyncResult {
	plugins: number;
	skills: number;
	removed: number;
	entries: SkillEntry[];
}

export function syncPlugins(): SyncResult {
	const installed = readInstalledPlugins().filter((p) => p.enabled);
	const root = skillsRoot();
	fs.mkdirSync(root, { recursive: true });

	const wanted = new Set<string>();
	const entries: SkillEntry[] = [];

	for (const plugin of installed) {
		const skillsDir = path.join(plugin.installPath, "skills");
		if (!fs.existsSync(skillsDir)) continue;

		for (const item of fs.readdirSync(skillsDir, { withFileTypes: true })) {
			if (!item.isDirectory()) continue;
			const source = path.join(skillsDir, item.name);
			if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;

			const dirName = `${plugin.name}-${item.name}`;
			const target = path.join(root, dirName);
			wanted.add(dirName);

			if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
			copyTree(source, target);
			fs.writeFileSync(
				path.join(target, MANAGED_MARKER),
				`${plugin.marketplace}\n`,
			);

			const skillFile = path.join(target, "SKILL.md");
			const contents = fs.readFileSync(skillFile, "utf8");
			fs.writeFileSync(skillFile, rewriteSkillName(contents, dirName));

			entries.push({
				plugin: plugin.name,
				marketplace: plugin.marketplace,
				skill: item.name,
				directory: dirName,
				path: target,
				description: readDescription(contents),
			});
		}
	}

	let removed = 0;
	for (const item of fs.readdirSync(root, { withFileTypes: true })) {
		if (!item.isDirectory() || wanted.has(item.name)) continue;
		const dir = path.join(root, item.name);
		if (!fs.existsSync(path.join(dir, MANAGED_MARKER))) continue;
		fs.rmSync(dir, { recursive: true });
		removed++;
	}

	return {
		plugins: installed.length,
		skills: entries.length,
		removed,
		entries,
	};
}

export function listSkills(): SkillEntry[] {
	const root = skillsRoot();
	if (!fs.existsSync(root)) return [];

	const installed = readInstalledPlugins();
	const entries: SkillEntry[] = [];

	for (const item of fs.readdirSync(root, { withFileTypes: true })) {
		if (!item.isDirectory()) continue;
		const dir = path.join(root, item.name);
		const skillFile = path.join(dir, "SKILL.md");
		if (!fs.existsSync(skillFile)) continue;

		const marker = path.join(dir, MANAGED_MARKER);
		const marketplace = fs.existsSync(marker)
			? fs.readFileSync(marker, "utf8").trim()
			: "";
		const owner = installed.find((p) => item.name.startsWith(`${p.name}-`));

		entries.push({
			plugin: owner?.name ?? "",
			marketplace,
			skill: owner ? item.name.slice(owner.name.length + 1) : item.name,
			directory: item.name,
			path: dir,
			description: readDescription(fs.readFileSync(skillFile, "utf8")),
		});
	}

	return entries.sort((a, b) => a.directory.localeCompare(b.directory));
}
