import fs from "node:fs";
import { cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileIfChanged } from "./agent-wrappers-common";
import { getBundledPluginDir } from "./config";

export const MANAGED_SKILL_MARKER = "<!-- superset-managed-skill v1 -->";

/**
 * Sentinel file marking a directory as Superset-managed (used for the Claude
 * plugin dir, whose manifest is JSON and can't carry the markdown marker).
 */
export const MANAGED_SENTINEL_NAME = ".superset-managed";

/** Namespace subdirectory for managed commands under ~/.agents/commands. */
export const MANAGED_COMMAND_NAMESPACE = "superset";

/**
 * Claude Code loads any ~/.claude/skills/<name> directory containing a
 * .claude-plugin/plugin.json as a "skills-directory plugin" named
 * `<name>@skills-dir`, namespacing its skills as `<name>:<skill>`. One
 * directory per source, so a source's name is the namespace its skills get.
 */
const BUNDLED_SOURCE_NAME = "superset";

/**
 * What of a source directory belongs in its Claude plugin dir. Marketplace
 * plugins also carry `server/`, `src/`, and `versions/`, none of which Claude
 * reads and one of which is a compiled bundle.
 */
const CLAUDE_PLUGIN_CONTENTS = new Set([
	".claude-plugin",
	"commands",
	"plugin.json",
	"skills",
]);

/**
 * Skills exposed as slash commands to the in-app chat. Deliberately a curated
 * allowlist (the chat menu shouldn't mirror every skill); everything else in
 * the bundled plugin is provisioned automatically.
 */
const COMMAND_SKILLS = ["feedback", "10x", "setup", "doctor"] as const;

/**
 * A directory holding a `skills/` folder to provision from. The bundled
 * Superset plugin is one; every installed marketplace plugin is another.
 * `name` namespaces everything written for the source, so two plugins can
 * ship a skill of the same name without colliding.
 */
export interface PluginSkillSource {
	name: string;
	dir: string;
}

export interface ManagedSkillsOptions {
	homeDir?: string;
	templatesDir?: string;
	/**
	 * Skills to withhold provisioning for (and reap if already provisioned). A
	 * bare name disables that skill of the bundled Superset plugin; a qualified
	 * `<plugin>/<skill>` disables one plugin's copy, which is the only form
	 * that can tell apart two plugins shipping the same skill name.
	 */
	disabledSkills?: readonly string[];
	/**
	 * Marketplace plugins to provision alongside the bundled one. Omitted means
	 * bundled-only — exactly the behaviour from before plugins existed.
	 */
	pluginSources?: readonly PluginSkillSource[];
}

/**
 * Inserts the managed marker right after the frontmatter block so both the
 * writer and the reaper can tell managed files apart from user-authored ones.
 */
export function withManagedMarker(content: string): string {
	if (content.includes(MANAGED_SKILL_MARKER)) return content;
	const frontmatterEnd = content.startsWith("---\n")
		? content.indexOf("\n---\n", 4)
		: -1;
	if (frontmatterEnd === -1) return `${MANAGED_SKILL_MARKER}\n${content}`;
	const insertAt = frontmatterEnd + "\n---\n".length;
	return `${content.slice(0, insertAt)}${MANAGED_SKILL_MARKER}\n${content.slice(insertAt)}`;
}

/** Rewrites the frontmatter `name:` so it matches the destination directory. */
export function setFrontmatterName(content: string, name: string): string {
	if (!content.startsWith("---\n")) return content;
	const frontmatterEnd = content.indexOf("\n---\n", 4);
	if (frontmatterEnd === -1) return content;
	const frontmatter = content.slice(0, frontmatterEnd);
	const rewritten = frontmatter.replace(/^name:[^\n]*$/m, `name: ${name}`);
	return rewritten + content.slice(frontmatterEnd);
}

/**
 * Bare names address the bundled plugin only. Qualifying with the source name
 * is what lets two plugins ship the same skill name and be disabled apart.
 */
function isSkillDisabled(
	disabled: ReadonlySet<string>,
	sourceName: string,
	skillName: string,
): boolean {
	if (disabled.has(`${sourceName}/${skillName}`)) return true;
	return sourceName === BUNDLED_SOURCE_NAME && disabled.has(skillName);
}

/**
 * The bundled plugin first, then marketplace plugins. Deduped with the bundled
 * one pinned: a marketplace plugin named "superset" must not be able to take
 * over the directory the bundled skills live in. Sources with no `skills/` are
 */
function resolveSources(
	bundledPluginDir: string,
	pluginSources: readonly PluginSkillSource[] = [],
): PluginSkillSource[] {
	const sources: PluginSkillSource[] = [
		{ name: BUNDLED_SOURCE_NAME, dir: bundledPluginDir },
	];
	const seen = new Set([BUNDLED_SOURCE_NAME]);
	for (const source of pluginSources) {
		if (seen.has(source.name)) {
			console.warn(
				`[agent-setup] Ignoring plugin source "${source.name}": that name is already provisioned`,
			);
			continue;
		}
		seen.add(source.name);
		sources.push(source);
	}
	return sources;
}

function isUserOwnedFile(filePath: string): boolean {
	if (!fs.existsSync(filePath)) return false;
	return !fs.readFileSync(filePath, "utf-8").includes(MANAGED_SKILL_MARKER);
}

function isManagedDir(dirPath: string): boolean {
	if (fs.existsSync(path.join(dirPath, MANAGED_SENTINEL_NAME))) return true;
	const skillMd = path.join(dirPath, "SKILL.md");
	return fs.existsSync(skillMd) && !isUserOwnedFile(skillMd);
}

function listFilesRecursive(root: string, relative = ""): string[] {
	const files: string[] = [];
	const absolute = relative ? path.join(root, relative) : root;
	for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
		const entryRelative = relative
			? path.join(relative, entry.name)
			: entry.name;
		if (entry.isDirectory()) {
			files.push(...listFilesRecursive(root, entryRelative));
		} else if (entry.isFile()) {
			files.push(entryRelative);
		}
	}
	return files;
}

/**
 * Mirrors src into dest file-by-file (writeFileIfChanged semantics), removing
 * previously-managed files that no longer exist in src. Files for which
 * `isExcluded` returns true are treated as absent from src — skipped on the
 * way in, and reaped on the way out if a prior sync already wrote them.
 * `extraFiles` maps a dest-relative path to contents that src does not hold;
 * they count as part of src, so the reaper keeps rather than orphans them.
 */
async function syncDir(
	src: string,
	dest: string,
	isExcluded?: (relativePath: string) => boolean,
	extraFiles: Readonly<Record<string, string>> = {},
): Promise<void> {
	const sourceFiles = listFilesRecursive(src).filter(
		(file) => !isExcluded?.(file),
	);
	for (const file of sourceFiles) {
		const source = path.join(src, file);
		const target = path.join(dest, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		// Skills may bundle scripts/; keep them runnable after provisioning.
		const executable = (fs.statSync(source).mode & 0o111) !== 0;
		writeFileIfChanged(
			target,
			fs.readFileSync(source, "utf-8"),
			executable ? 0o755 : 0o644,
		);
	}
	for (const [file, contents] of Object.entries(extraFiles)) {
		const target = path.join(dest, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		writeFileIfChanged(target, contents, 0o644);
	}
	const wanted = new Set(
		[...sourceFiles, ...Object.keys(extraFiles)].map((f) => path.join(dest, f)),
	);
	if (fs.existsSync(dest)) {
		for (const file of listFilesRecursive(dest)) {
			const absolute = path.join(dest, file);
			if (file === MANAGED_SENTINEL_NAME || wanted.has(absolute)) continue;
			await rm(absolute);
			let parent = path.dirname(absolute);
			while (
				parent !== dest &&
				fs.existsSync(parent) &&
				fs.readdirSync(parent).length === 0
			) {
				await rm(parent, { recursive: true });
				parent = path.dirname(parent);
			}
		}
	}
}

/**
 * The manifest Claude Code needs before it will load a directory as a plugin.
 * Marketplace plugins carry a root `plugin.json` in Superset's own format and
 * no `.claude-plugin/`; the fields line up, so synthesize Claude's copy rather
 * than making plugin authors learn a second layout. Returns null when the
 * source already ships one.
 */
function claudePluginManifest(source: PluginSkillSource): string | null {
	if (fs.existsSync(path.join(source.dir, ".claude-plugin", "plugin.json"))) {
		return null;
	}
	let declared: Record<string, unknown> = {};
	try {
		declared = JSON.parse(
			fs.readFileSync(path.join(source.dir, "plugin.json"), "utf-8"),
		) as Record<string, unknown>;
	} catch {
		// Unreadable or absent: a name and a version are all Claude requires.
	}
	const manifest: Record<string, unknown> = {
		name: source.name,
		version: typeof declared.version === "string" ? declared.version : "0.0.0",
	};
	for (const field of [
		"description",
		"author",
		"homepage",
		"repository",
		"license",
		"keywords",
	]) {
		if (declared[field] !== undefined) manifest[field] = declared[field];
	}
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}

/**
 * Provisions one source as a Claude Code skills-directory plugin inside one
 * Claude config dir — `~/.claude` for the default account, or a profile dir
 * whose own `skills/` the user owns (a shared profile links `skills/` at the
 * default account instead, and gets it that way).
 */
async function provisionClaudePlugin(
	source: PluginSkillSource,
	claudeDir: string,
	disabledSkills: ReadonlySet<string>,
): Promise<void> {
	const target = path.join(claudeDir, "skills", source.name);
	const sentinel = path.join(target, MANAGED_SENTINEL_NAME);
	if (fs.existsSync(target) && !fs.existsSync(sentinel)) {
		console.log(`[agent-setup] Skipping user-owned plugin dir at ${target}`);
		return;
	}
	const synthesized = claudePluginManifest(source);
	await syncDir(
		source.dir,
		target,
		(relativePath) => {
			const [dir, skillName] = relativePath.split(path.sep);
			if (!CLAUDE_PLUGIN_CONTENTS.has(dir ?? "")) return true;
			return (
				dir === "skills" &&
				isSkillDisabled(disabledSkills, source.name, skillName ?? "")
			);
		},
		synthesized
			? { [path.join(".claude-plugin", "plugin.json")]: synthesized }
			: {},
	);
	writeFileIfChanged(sentinel, `${MANAGED_SKILL_MARKER}\n`, 0o644);
}

function readPluginSkill(
	sourceDir: string,
	pluginSkill: string,
): string | null {
	const sourcePath = path.join(sourceDir, "skills", pluginSkill, "SKILL.md");
	if (!fs.existsSync(sourcePath)) return null;
	return fs.readFileSync(sourcePath, "utf-8");
}

/**
 * Every skill in a source ships everywhere automatically unless the user
 * disabled it — adding a skill to plugins/superset/skills/ requires no code
 * change here. Returns null on enumeration failure, which the caller must
 * treat as "keep whatever this source already provisioned": an empty desired
 * set would hand every one of its directories to the reaper.
 */
function listSourceSkills(sourceDir: string): string[] | null {
	// A missing source directory is one we cannot see — the marketplace clone
	// is gone, or was never fetched on this machine — and must not read as
	// "ships nothing", which would reap skills that are still installed. A
	// source that exists and has no skills/ genuinely ships none, so its stale
	// directories should go.
	if (!fs.existsSync(sourceDir)) return null;
	const skillsDir = path.join(sourceDir, "skills");
	if (!fs.existsSync(skillsDir)) return [];
	try {
		return fs
			.readdirSync(skillsDir, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md")),
			)
			.map((entry) => entry.name);
	} catch (error) {
		console.warn(`[agent-setup] Failed to enumerate ${skillsDir}:`, error);
		return null;
	}
}

/** Copies a bundled skill's extra files (anything besides SKILL.md) verbatim. */
async function copyBundledExtras(
	sourceDir: string,
	targetDir: string,
): Promise<void> {
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === "SKILL.md") continue;
		await cp(
			path.join(sourceDir, entry.name),
			path.join(targetDir, entry.name),
			{ recursive: true },
		);
	}
}

/** Directories under `root` that this source provisioned on an earlier run. */
function provisionedDirsFor(root: string, sourceName: string): string[] {
	if (!fs.existsSync(root)) return [];
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && entry.name.startsWith(`${sourceName}-`),
			)
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function reapStaleSkillDirs(
	root: string,
	desiredNames: Set<string>,
): Promise<void> {
	if (!fs.existsSync(root)) return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || desiredNames.has(entry.name)) continue;
		const dirPath = path.join(root, entry.name);
		if (!isManagedDir(dirPath)) continue;
		await rm(dirPath, { recursive: true });
		console.log(`[agent-setup] Reaped stale managed skill ${entry.name}`);
	}
}

async function reapStaleCommands(
	namespaceDir: string,
	desiredFiles: Set<string>,
): Promise<void> {
	if (!fs.existsSync(namespaceDir)) return;
	for (const entry of fs.readdirSync(namespaceDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		if (desiredFiles.has(entry.name)) continue;
		const filePath = path.join(namespaceDir, entry.name);
		if (isUserOwnedFile(filePath)) continue;
		await rm(filePath);
		console.log(`[agent-setup] Reaped stale managed command ${entry.name}`);
	}
}

export async function createManagedSkills(
	options: ManagedSkillsOptions = {},
): Promise<void> {
	const homeDir = options.homeDir ?? os.homedir();
	const bundledPluginDir = options.templatesDir
		? path.join(options.templatesDir, "plugin")
		: getBundledPluginDir();
	const disabledSkills = new Set(options.disabledSkills ?? []);

	if (!fs.existsSync(path.join(bundledPluginDir, "skills"))) {
		console.warn(
			`[agent-setup] Bundled plugin missing at ${bundledPluginDir}; skipping managed skills`,
		);
		return;
	}

	const agentsSkillsRoot = path.join(homeDir, ".agents", "skills");
	const commandNamespaceDir = path.join(
		homeDir,
		".agents",
		"commands",
		MANAGED_COMMAND_NAMESPACE,
	);

	const sources = resolveSources(bundledPluginDir, options.pluginSources);
	const desiredClaudeDirs = new Set<string>();
	const desiredAgentsDirs = new Set<string>();

	for (const source of sources) {
		// Claimed before anything is written, and kept even when provisioning
		// fails below: a half-written directory is still this source's, and
		// reaping it would delete a plugin the user still has installed.
		desiredClaudeDirs.add(source.name);

		const sourceSkills = listSourceSkills(source.dir);
		if (sourceSkills === null) {
			for (const existing of provisionedDirsFor(
				agentsSkillsRoot,
				source.name,
			)) {
				desiredAgentsDirs.add(existing);
			}
			console.warn(
				`[agent-setup] Skipping ${source.name}: source unreadable, keeping what it already provisioned`,
			);
			continue;
		}

		try {
			await provisionClaudePlugin(
				source,
				path.join(homeDir, ".claude"),
				disabledSkills,
			);
		} catch (error) {
			console.warn(
				`[agent-setup] Failed to provision Claude plugin ${source.name}:`,
				error,
			);
		}

		for (const pluginSkill of sourceSkills) {
			if (isSkillDisabled(disabledSkills, source.name, pluginSkill)) continue;
			// Prefixed dir name carries the namespace for agents without plugin
			// support; frontmatter `name` is rewritten to match because the skill
			// spec requires name == parent directory.
			const dirName = `${source.name}-${pluginSkill}`;
			try {
				const raw = readPluginSkill(source.dir, pluginSkill);
				if (raw === null) continue;
				desiredAgentsDirs.add(dirName);
				const targetDir = path.join(agentsSkillsRoot, dirName);
				const skillMdPath = path.join(targetDir, "SKILL.md");
				if (isUserOwnedFile(skillMdPath)) {
					console.log(
						`[agent-setup] Skipping user-owned skill at ${skillMdPath}`,
					);
					continue;
				}
				fs.mkdirSync(targetDir, { recursive: true });
				writeFileIfChanged(
					skillMdPath,
					withManagedMarker(setFrontmatterName(raw, dirName)),
					0o644,
				);
				await copyBundledExtras(
					path.join(source.dir, "skills", pluginSkill),
					targetDir,
				);
			} catch (error) {
				console.warn(
					`[agent-setup] Failed to provision skill ${dirName}:`,
					error,
				);
			}
		}
	}

	const desiredCommandFiles = new Set<string>();
	for (const pluginSkill of COMMAND_SKILLS) {
		if (isSkillDisabled(disabledSkills, BUNDLED_SOURCE_NAME, pluginSkill)) {
			continue;
		}
		const fileName = `${pluginSkill}.md`;
		try {
			const raw = readPluginSkill(bundledPluginDir, pluginSkill);
			if (raw === null) continue;
			desiredCommandFiles.add(fileName);
			const filePath = path.join(commandNamespaceDir, fileName);
			if (isUserOwnedFile(filePath)) {
				console.log(`[agent-setup] Skipping user-owned command at ${filePath}`);
				continue;
			}
			fs.mkdirSync(commandNamespaceDir, { recursive: true });
			writeFileIfChanged(filePath, withManagedMarker(raw), 0o644);
		} catch (error) {
			console.warn(
				`[agent-setup] Failed to provision command ${fileName}:`,
				error,
			);
		}
	}

	try {
		// ~/.claude/skills holds one directory per source; anything else
		// marker-bearing there — a dir from an earlier version of this
		// mechanism, or a plugin since uninstalled — is stale.
		await reapStaleSkillDirs(
			path.join(homeDir, ".claude", "skills"),
			desiredClaudeDirs,
		);
		await reapStaleSkillDirs(agentsSkillsRoot, desiredAgentsDirs);
		await reapStaleCommands(commandNamespaceDir, desiredCommandFiles);
	} catch (error) {
		console.warn("[agent-setup] Failed to reap stale managed skills:", error);
	}

	console.log("[agent-setup] Managed skills provisioned");
}

/**
 * Provisions the bundled Superset plugin into one Claude config dir. Used for
 * a secondary account whose `skills/` directory the user owns, so it can't be
 * linked at the default account's — the plugin is written into it directly
 * instead of being shared.
 */
export async function provisionManagedClaudePluginAt(
	claudeDir: string,
	options: ManagedSkillsOptions = {},
): Promise<void> {
	const bundledPluginDir = options.templatesDir
		? path.join(options.templatesDir, "plugin")
		: getBundledPluginDir();
	if (!fs.existsSync(path.join(bundledPluginDir, "skills"))) {
		console.warn(
			`[agent-setup] Bundled plugin missing at ${bundledPluginDir}; skipping plugin provisioning for ${claudeDir}`,
		);
		return;
	}
	const disabledSkills = new Set(options.disabledSkills ?? []);
	for (const source of resolveSources(
		bundledPluginDir,
		options.pluginSources,
	)) {
		await provisionClaudePlugin(source, claudeDir, disabledSkills);
	}
}
