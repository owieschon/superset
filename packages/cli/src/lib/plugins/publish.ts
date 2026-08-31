import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLIError } from "@superset/cli-framework";
import {
	buildPlugin,
	isBuildCurrent,
	isPublishedBuildCurrent,
	SERVER_ENTRY,
} from "./build";
import {
	type MarketplaceContext,
	publishedVersions,
	type ResolvedPlugin,
	requiredEnvFor,
	supersetExtension,
	versionDir,
	writeJson,
} from "./marketplace";

const VERSIONED_FILES = ["plugin.json"];
const VERSIONED_DIRS = ["skills", "server"];

function copyTree(from: string, to: string): number {
	let count = 0;
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const src = path.join(from, entry.name);
		const dest = path.join(to, entry.name);
		if (entry.isDirectory()) count += copyTree(src, dest);
		else {
			fs.copyFileSync(src, dest);
			count++;
		}
	}
	return count;
}

export interface PublishResult {
	name: string;
	version: string;
	dir: string;
	files: number;
	rebuilt: boolean;
}

export async function publishPlugin(
	ctx: MarketplaceContext,
	plugin: ResolvedPlugin,
	options: { force?: boolean } = {},
): Promise<PublishResult> {
	const version = plugin.manifest.version;
	if (!version) {
		throw new CLIError(`Plugin "${plugin.manifest.name}" has no version.`);
	}

	const target = versionDir(plugin, version);
	if (fs.existsSync(target) && !options.force) {
		throw new CLIError(
			`Version ${version} of "${plugin.manifest.name}" is already published. ` +
				`Bump the version (--bump patch) or pass --force to overwrite.`,
		);
	}

	const build = await buildPlugin(plugin, { force: options.force });
	if (plugin.hasServerSource && !isBuildCurrent(plugin)) {
		throw new CLIError(
			`Build for "${plugin.manifest.name}" is stale after rebuilding; refusing to publish.`,
		);
	}

	if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
	fs.mkdirSync(target, { recursive: true });

	let files = 0;
	for (const file of VERSIONED_FILES) {
		const src = path.join(plugin.dir, file);
		if (!fs.existsSync(src)) continue;
		fs.copyFileSync(src, path.join(target, file));
		files++;
	}
	for (const dir of VERSIONED_DIRS) {
		const src = path.join(plugin.dir, dir);
		if (!fs.existsSync(src)) continue;
		files += copyTree(src, path.join(target, dir));
	}

	if (
		plugin.hasServerSource &&
		!fs.existsSync(path.join(target, SERVER_ENTRY))
	) {
		throw new CLIError(
			`Published ${plugin.manifest.name}@${version} is missing ${SERVER_ENTRY}.`,
		);
	}

	const entry = ctx.marketplace.plugins.find(
		(p) => p.name === plugin.manifest.name,
	);
	if (!entry) {
		throw new CLIError(
			`"${plugin.manifest.name}" is not listed in the marketplace.`,
		);
	}
	stampServerIntegrity(target, entry.source, version);

	entry.version = version;
	writeJson(ctx.file, ctx.marketplace);

	return {
		name: plugin.manifest.name,
		version,
		dir: path.relative(ctx.root, target),
		files,
		rebuilt: build.built,
	};
}

function checkAuth(plugin: ResolvedPlugin): CheckIssue[] {
	const name = plugin.manifest.name;
	const methods = supersetExtension(plugin.manifest)?.auth;
	if (!methods) return [];

	const issues: CheckIssue[] = [];
	if (!Array.isArray(methods)) {
		issues.push({ name, problem: "auth must be a list of methods" });
		return issues;
	}

	const seen = new Set<string>();
	for (const auth of methods) {
		if (seen.has(auth.type)) {
			issues.push({ name, problem: `auth declares ${auth.type} twice` });
		}
		seen.add(auth.type);

		const inputs = new Set((auth.inputs ?? []).map((input) => input.name));

		if (auth.type === "oauth2") {
			if (!auth.authorization_url || !auth.token_url) {
				issues.push({
					name,
					problem: "oauth2 auth needs both authorization_url and token_url",
				});
			}

			// An oauth2 connection starts with a GET whose params travel in the URL
			// and the signed state, so a secret there would land in browser history
			// and proxy logs. The credential comes from the provider anyway.
			const secrets = (auth.inputs ?? []).filter((input) => input.secret);
			if (secrets.length) {
				issues.push({
					name,
					problem: `oauth2 inputs cannot be secret (${secrets.map((i) => i.name).join(", ")}); they travel in the authorize URL`,
				});
			}

			const expected = requiredEnvFor(name);
			const declared = auth.requires_env ?? [];
			const foreign = declared.filter(
				(variable) => !variable.startsWith("PLUGIN_"),
			);
			if (foreign.length) {
				issues.push({
					name,
					problem: `requires_env may only name PLUGIN_* variables; found ${foreign.join(", ")}`,
				});
			} else if (declared.join(",") !== expected.join(",")) {
				issues.push({
					name,
					problem: `requires_env must be exactly ${expected.join(", ")}; it documents deployment setup and is never read to resolve a value`,
				});
			}
		} else if (auth.type === "api_key") {
			const credential = auth.credential_input ?? "api_key";
			if (!inputs.has(credential)) {
				issues.push({
					name,
					problem: `api_key auth names credential_input "${credential}" but no input declares it`,
				});
			}
		} else {
			issues.push({ name, problem: `unknown auth type "${auth.type}"` });
		}

		for (const template of templatedStrings(auth)) {
			for (const reference of template.matchAll(/\$\{inputs\.([\w.-]+)\}/g)) {
				const key = reference[1];
				if (key && !inputs.has(key)) {
					issues.push({
						name,
						problem: `references \${inputs.${key}} but no input declares it`,
					});
				}
			}
		}

		if (auth.identity && !auth.identity.url) {
			issues.push({ name, problem: "identity needs a url" });
		}
		if (auth.identity && !auth.identity.id) {
			issues.push({ name, problem: "identity needs an id path" });
		}
	}

	return issues;
}

function templatedStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(templatedStrings);
	if (value && typeof value === "object") {
		return Object.values(value).flatMap(templatedStrings);
	}
	return [];
}

export interface CheckIssue {
	name: string;
	problem: string;
}

export function checkPlugin(
	ctx: MarketplaceContext,
	plugin: ResolvedPlugin,
): CheckIssue[] {
	const issues: CheckIssue[] = [];
	const name = plugin.manifest.name;
	const version = plugin.manifest.version;

	if (!version) {
		issues.push({ name, problem: "plugin.json has no version" });
		return issues;
	}

	const entry = ctx.marketplace.plugins.find((p) => p.name === name);
	if (entry && entry.version !== version) {
		issues.push({
			name,
			problem: `marketplace records ${entry.version ?? "no version"} but plugin.json says ${version}; publish to reconcile`,
		});
	}

	if (!fs.existsSync(versionDir(plugin, version))) {
		issues.push({
			name,
			problem: `version ${version} is not published (no versions/${version})`,
		});
	}

	if (plugin.hasServerSource) {
		const published = isPublishedBuildCurrent(
			plugin,
			versionDir(plugin, version),
		);
		if (published === null) {
			issues.push({
				name,
				problem: `versions/${version} has no build stamp; run \`superset plugins publish ${name} --force\``,
			});
		} else if (!published) {
			issues.push({
				name,
				problem: `src/ has changed since ${version} was published; bump and publish, or republish with --force`,
			});
		}
	}

	if (!plugin.hasServerSource && !plugin.hasRemoteServer && !plugin.hasSkills) {
		issues.push({
			name,
			problem: "plugin has no skills, mcp server, or server source",
		});
	}

	if (plugin.hasServerSource && plugin.hasRemoteServer) {
		issues.push({
			name,
			problem:
				"plugin declares both an mcp url and src/index.ts; tools come from exactly one server",
		});
	}

	issues.push(...checkAuth(plugin));

	const published = publishedVersions(plugin);
	if (published.length && published[published.length - 1] !== version) {
		issues.push({
			name,
			problem: `plugin.json says ${version} but ${published[published.length - 1]} is the newest published version`,
		});
	}

	return issues;
}

/**
 * Skill name and description from each published SKILL.md, so clients can list
 * a plugin's skills without the files. Frontmatter is read with a narrow regex
 * rather than a YAML parser: only these two fields are needed, and a malformed
 * skill should drop itself, not fail the publish.
 */
function publishedSkills(
	versionPath: string,
): { name: string; description: string }[] {
	const dir = path.join(versionPath, "skills");
	if (!fs.existsSync(dir)) return [];

	const skills: { name: string; description: string }[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const file = path.join(dir, entry.name, "SKILL.md");
		if (!fs.existsSync(file)) continue;
		const contents = fs.readFileSync(file, "utf8");
		skills.push({
			name: contents.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry.name,
			description: contents.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "",
		});
	}
	return skills;
}

/**
 * Records the published server's digest in the published manifest.
 *
 * The host downloads this artifact at tool-call time and imports it into its
 * own process, so the bytes have to be pinned to the version that was
 * published: the manifest is what the account already trusts, and a digest in
 * it means a rewritten branch or a compromised CDN yields a mismatch instead of
 * code execution. Written only into the snapshot, never the working manifest,
 * which stays hand-authored.
 */
function stampServerIntegrity(
	target: string,
	source: string,
	version: string,
): void {
	const serverPath = path.join(target, SERVER_ENTRY);
	if (!fs.existsSync(serverPath)) return;

	const manifestPath = path.join(target, "plugin.json");
	if (!fs.existsSync(manifestPath)) return;

	const digest = createHash("sha256")
		.update(fs.readFileSync(serverPath))
		.digest("base64");

	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	manifest.extensions ??= {};
	manifest.extensions.superset ??= {};
	// Repo-root relative, so a host that knows only the marketplace's repo and
	// ref can address the artifact without also parsing the marketplace file.
	const dir = source.replace(/^\.\//, "").replace(/\/$/, "");
	manifest.extensions.superset.server = {
		path: `${dir}/versions/${version}/${SERVER_ENTRY}`,
		integrity: `sha256-${digest}`,
	};
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
}

const GENERATED_HEADER = `// Generated by \`superset plugins publish\`. Do not edit.
//
// The first-party marketplace's published manifests, bundled so the API can
// resolve a plugin without fetching anything. This is deliberately not
// client-supplied: a manifest drives token_url and the proxy target, so
// trusting one from a request would be an exfiltration path.
`;

/**
 * Mirrors the published manifests into a module the API imports. Called from
 * publish so the bundle can never describe a version that was not published.
 */
export function writeGeneratedManifests(
	ctx: MarketplaceContext,
): string | null {
	const target = path.join(
		ctx.root,
		"packages",
		"shared",
		"src",
		"plugins",
		"manifests.generated.ts",
	);
	if (!fs.existsSync(path.dirname(target))) return null;

	const entries: string[] = [];
	for (const entry of ctx.marketplace.plugins) {
		const version = entry.version;
		if (!version) continue;
		const manifestPath = path.join(
			ctx.root,
			entry.source,
			"versions",
			version,
			"plugin.json",
		);
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		manifest.skills = publishedSkills(
			path.join(ctx.root, entry.source, "versions", version),
		);
		entries.push(
			`\t${JSON.stringify(entry.name)}: ${JSON.stringify(manifest, null, "\t")
				.split("\n")
				.join("\n\t")} as const,`,
		);
	}

	const contents = `${GENERATED_HEADER}
export const FIRST_PARTY_MANIFESTS = {
${entries.join("\n")}
} as const;

export type FirstPartyPluginName = keyof typeof FIRST_PARTY_MANIFESTS;

export function firstPartyManifest(
	name: string,
): (typeof FIRST_PARTY_MANIFESTS)[FirstPartyPluginName] | null {
	return (
		(FIRST_PARTY_MANIFESTS as Record<string, unknown>)[name] as
			| (typeof FIRST_PARTY_MANIFESTS)[FirstPartyPluginName]
			| undefined
	) ?? null;
}
`;
	fs.writeFileSync(target, contents);
	return target;
}
