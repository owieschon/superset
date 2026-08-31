import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
	createManagedSkills,
	resolveDisabledSkillIds,
	syncManagedMcpServers,
	writeSharedDisabledSkillIds,
} from "@superset/agent-setup";
import { getBundledPluginDir } from "@superset/agent-setup/config";
import { settings } from "@superset/local-db";
import {
	getPluginByName,
	type InstalledPlugin,
	type PluginMcpServerConfig,
	SUPERSET_MANAGED_SKILLS,
} from "@superset/shared/plugins";
import log from "electron-log/main";
import { resolveBundledCliPath } from "main/lib/bundled-cli";
import { localDb } from "main/lib/local-db";
import { createSerialQueue } from "main/lib/serial-queue";

/**
 * Installed-plugin state and its materialization into agent configs. State
 * lives on the local-db settings singleton (not renderer localStorage)
 * because the boot-time sync below runs in main before any renderer exists.
 * Sync is declarative: every call converges agent configs on the full
 * installed set, so installs and uninstalls both land on app restart even if
 * a mid-session sync was missed.
 */

const execFileAsync = promisify(execFile);

/**
 * One CLI run at a time, in call order.
 *
 * install and remove both provision declaratively — each writes the desired set
 * and reaps the rest — so two overlapping runs race on the same directories. A
 * remove that starts while an install is still reading its source finishes
 * first, and the install then re-provisions the skills the remove just took
 * away. Serializing is what makes the last call the one that wins.
 */
const pluginCliQueue = createSerialQueue();

function queuePluginCli(args: string[]): Promise<void> {
	return pluginCliQueue(() => runPluginCli(args));
}

/**
 * Materializes a plugin's content and skills by running the bundled CLI.
 *
 * The CLI already resolves a plugin from its marketplace, caches the published
 * version, and provisions its skills out to every directory an agent reads —
 * reaping the ones whose plugin is gone. Reimplementing that here is how the two
 * paths drifted in the first place: the app wrote MCP config and nothing else,
 * so a plugin installed from the UI never got its skills at all.
 *
 * Failure is reported, not thrown. The install record and MCP config are already
 * written by then, and a plugin whose servers work but whose skills are missing
 * is worth surfacing rather than rolling back.
 */
async function runPluginCli(args: string[]): Promise<void> {
	const cli = resolveBundledCliPath();
	if (!cli) {
		log.warn("[plugins] no bundled CLI; skills were not provisioned");
		return;
	}

	try {
		await execFileAsync(cli, ["plugins", ...args, "--json"], {
			timeout: 60_000,
		});
	} catch (error) {
		log.warn(
			`[plugins] ${args.join(" ")} failed; skills may be stale:`,
			error instanceof Error ? error.message : error,
		);
	}
}

export function getInstalledPlugins(): InstalledPlugin[] {
	return localDb.select().from(settings).get()?.installedPlugins ?? [];
}

function saveInstalledPlugins(next: InstalledPlugin[]): void {
	localDb
		.insert(settings)
		.values({ id: 1, installedPlugins: next })
		.onConflictDoUpdate({
			target: settings.id,
			set: { installedPlugins: next },
		})
		.run();
}

function desiredMcpServers(
	installed: InstalledPlugin[],
): Record<string, PluginMcpServerConfig> {
	const desired: Record<string, PluginMcpServerConfig> = {};
	for (const install of installed) {
		// Disabled installs and unknown names (a catalog entry removed after
		// install) contribute nothing, so their servers reap on the next sync.
		// Per-agent skipping of servers the user configured themselves happens
		// inside syncManagedMcpServers, scoped to each agent's own config.
		if (install.enabled === false) continue;
		const plugin = getPluginByName(install.name);
		if (!plugin) continue;
		Object.assign(desired, plugin.mcpServers);
	}
	return desired;
}

export function syncInstalledPluginMcpServers(): void {
	syncManagedMcpServers(desiredMcpServers(getInstalledPlugins()));
}

/** Returns the updated install list; unknown plugin names return null. */
export function installPlugin(name: string): InstalledPlugin[] | null {
	const plugin = getPluginByName(name);
	if (!plugin) return null;

	// Re-running over an existing install is an update, not a no-op: it is how
	// the version moves and how a plugin's new skills arrive. Keeping the
	// original installedAt keeps "when did I add this" answerable.
	const installed = getInstalledPlugins();
	const existing = installed.find((entry) => entry.name === name);
	const record: InstalledPlugin = {
		name: plugin.name,
		version: plugin.version,
		installedAt: existing?.installedAt ?? new Date().toISOString(),
		...(existing?.enabled === false ? { enabled: false } : {}),
	};
	const next = existing
		? installed.map((entry) => (entry.name === name ? record : entry))
		: [...installed, record];

	saveInstalledPlugins(next);
	syncInstalledPluginMcpServers();
	// --update because the CLI refuses a second install otherwise, which is the
	// gate that exists so a manifest change is asked for rather than applied.
	void queuePluginCli(["install", name, "--update"]);
	return next;
}

export function uninstallPlugin(name: string): InstalledPlugin[] {
	const next = getInstalledPlugins().filter((entry) => entry.name !== name);
	saveInstalledPlugins(next);
	syncInstalledPluginMcpServers();
	// Reaps the skill folders this plugin provisioned, leaving hand-written
	// ones alone — the same removal the CLI does.
	void queuePluginCli(["remove", name]);
	return next;
}

/**
 * Allowlisted against the shipped skill set — the name never touches the
 * filesystem unless it's one of ours.
 */
function resolveBundledSkillPath(name: string): string | null {
	if (!SUPERSET_MANAGED_SKILLS.some((skill) => skill.name === name)) {
		return null;
	}
	return path.join(getBundledPluginDir(), "skills", name, "SKILL.md");
}

/**
 * Raw SKILL.md content (including frontmatter) of a bundled managed skill,
 * for the preview modal. Frontmatter must stay in — the in-app editor's
 * markdown view splits/reattaches it around edits, so a stripped read here
 * would delete it on the next save.
 */
export function getBundledSkillContent(name: string): string | null {
	const skillPath = resolveBundledSkillPath(name);
	if (!skillPath) return null;
	try {
		return fs.readFileSync(skillPath, "utf-8");
	} catch {
		return null;
	}
}

/** Absolute path to a bundled skill's SKILL.md, for Open/Reveal in Finder. */
export function getBundledSkillPath(name: string): string | null {
	const skillPath = resolveBundledSkillPath(name);
	if (!skillPath || !fs.existsSync(skillPath)) return null;
	return skillPath;
}

const SKILL_ICON_FILES = [
	{ file: "icon.svg", mime: "image/svg+xml" },
	{ file: "icon.png", mime: "image/png" },
] as const;

/**
 * Data URIs of per-skill icons distributed inside the skill folders
 * (`skills/<name>/icon.svg|png`) — the Superset convention for skill authors
 * to ship artwork with their skill, mirroring how Codex plugins carry
 * `interface` icons. Skills without one fall back to a default glyph in the
 * renderer.
 */
export function getBundledSkillIcons(): Record<string, string> {
	const icons: Record<string, string> = {};
	for (const skill of SUPERSET_MANAGED_SKILLS) {
		for (const { file, mime } of SKILL_ICON_FILES) {
			const iconPath = path.join(
				getBundledPluginDir(),
				"skills",
				skill.name,
				file,
			);
			try {
				const data = fs.readFileSync(iconPath);
				icons[skill.name] = `data:${mime};base64,${data.toString("base64")}`;
				break;
			} catch {
				// No icon in this format; try the next or fall through.
			}
		}
	}
	return icons;
}

/**
 * Toggling re-syncs immediately: disable reaps, enable rewrites. A plugin
 * present only via the user's own config has no record yet — toggling adopts
 * it (creates the record) so the choice has somewhere to live.
 */
export function setPluginEnabled(
	name: string,
	enabled: boolean,
): InstalledPlugin[] {
	const installed = getInstalledPlugins();
	const hasRecord = installed.some((entry) => entry.name === name);
	const plugin = getPluginByName(name);
	const next = hasRecord
		? installed.map((entry) =>
				entry.name === name ? { ...entry, enabled } : entry,
			)
		: plugin
			? [
					...installed,
					{
						name: plugin.name,
						version: plugin.version,
						installedAt: new Date().toISOString(),
						enabled,
					},
				]
			: installed;
	saveInstalledPlugins(next);
	syncInstalledPluginMcpServers();
	return next;
}

export function getDisabledSkills(): string[] {
	return localDb.select().from(settings).get()?.disabledSkills ?? [];
}

// Serializes the createManagedSkills resyncs triggered by setSkillEnabled and
// writeBundledSkillContent so overlapping calls can't interleave:
// createManagedSkills does multi-await fs work, and without this a second
// call's resync could finish before the first's, leaving disk state
// contradicting whichever write actually happened last.
let managedSkillsSyncQueue: Promise<void> = Promise.resolve();
function queueManagedSkillsSync(disabledSkills: readonly string[]): void {
	managedSkillsSyncQueue = managedSkillsSyncQueue
		.catch(() => {}) // a prior failure must not stall later syncs
		.then(() => createManagedSkills({ disabledSkills }));
}

/**
 * Overwrites a bundled skill's SKILL.md, then re-provisions it out to
 * ~/.agents/skills, the Claude plugin mirror, and the slash-command file —
 * same convention as setSkillEnabled below.
 */
export function writeBundledSkillContent(name: string, content: string): void {
	const skillPath = resolveBundledSkillPath(name);
	if (!skillPath) {
		throw new Error(`Unknown skill: ${name}`);
	}
	fs.writeFileSync(skillPath, content, "utf-8");
	queueManagedSkillsSync(resolveDisabledSkillIds(getDisabledSkills()));
}

/**
 * Toggling re-syncs immediately: disable reaps the skill from every agent
 * (and the Claude plugin mirror), enable rewrites it. Mirrored to the shared
 * disabled-skills file so CLI-launched host-services on this machine honor
 * the choice instead of re-provisioning a skill the user just disabled.
 * Returns null for a name outside SUPERSET_MANAGED_SKILLS.
 */
export function setSkillEnabled(
	name: string,
	enabled: boolean,
): string[] | null {
	if (!SUPERSET_MANAGED_SKILLS.some((skill) => skill.name === name)) {
		return null;
	}
	const current = new Set(getDisabledSkills());
	if (enabled) {
		current.delete(name);
	} else {
		current.add(name);
	}
	const next = [...current];
	localDb
		.insert(settings)
		.values({ id: 1, disabledSkills: next })
		.onConflictDoUpdate({
			target: settings.id,
			set: { disabledSkills: next },
		})
		.run();
	writeSharedDisabledSkillIds(next);
	// resolveDisabledSkillIds folds in SUPERSET_DISABLED_SKILLS — passing
	// `next` straight through would silently re-enable an env-disabled skill
	// on the next unrelated toggle.
	queueManagedSkillsSync(resolveDisabledSkillIds(next));
	return next;
}
