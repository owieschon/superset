import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MarketplaceContext, ResolvedPlugin } from "./marketplace";
import { checkPlugin, generatedManifestDrift } from "./publish";

let root = "";

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function writeSkill(dir: string, name: string, body: string): void {
	fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "skills", name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`,
	);
}

/**
 * A plugin whose versions/<version> snapshot is a faithful copy of its source,
 * which is the state `publish` leaves behind and the only state `check` should
 * accept.
 */
function publishedPlugin(
	name: string,
	version: string,
	skills: Record<string, string> = { "file-issue": "File an issue" },
): { ctx: MarketplaceContext; plugin: ResolvedPlugin } {
	const dir = path.join(root, "plugins", name);
	const manifest = {
		name,
		version,
		description: `${name} plugin`,
		extensions: {
			superset: {
				interface: { displayName: name, category: "Productivity" },
				mcpServers: { [name]: { type: "http", url: `https://${name}.test` } },
			},
		},
	};

	writeJson(path.join(dir, "plugin.json"), manifest);
	for (const [skill, body] of Object.entries(skills))
		writeSkill(dir, skill, body);

	// What `publish` copies out: plugin.json plus the skills tree.
	const target = path.join(dir, "versions", version);
	fs.mkdirSync(target, { recursive: true });
	fs.copyFileSync(
		path.join(dir, "plugin.json"),
		path.join(target, "plugin.json"),
	);
	fs.cpSync(path.join(dir, "skills"), path.join(target, "skills"), {
		recursive: true,
	});

	const entry = { name, source: `plugins/${name}`, version };
	return {
		ctx: {
			root,
			file: path.join(root, ".agent-marketplace.json"),
			marketplace: { name: "test", plugins: [entry] } as never,
		},
		plugin: {
			entry: entry as never,
			dir,
			manifest: manifest as never,
			hasServerSource: false,
			hasSkills: true,
			hasRemoteServer: true,
		},
	};
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "superset-publish-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("checkPlugin", () => {
	test("a faithfully published plugin has no problems", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		expect(checkPlugin(ctx, plugin)).toEqual([]);
	});

	// The gap this closes: a plugin with no server source passed every other
	// check as long as versions/<v> merely existed, so editing a SKILL.md in
	// place shipped a snapshot — and a bundled manifest, and every install —
	// describing skills the repo no longer contained.
	test("catches a skill edited in place after publishing", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		writeSkill(plugin.dir, "file-issue", "File an issue, but rewritten");

		const [issue] = checkPlugin(ctx, plugin);
		expect(issue?.problem).toContain("no longer matches source");
		expect(issue?.problem).toContain("skills/file-issue/SKILL.md");
	});

	test("catches a skill added without publishing", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		writeSkill(plugin.dir, "duplicate-sweep", "Sweep duplicates");

		expect(checkPlugin(ctx, plugin)[0]?.problem).toContain(
			"skills/duplicate-sweep/SKILL.md",
		);
	});

	test("catches a skill removed without publishing", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		fs.rmSync(path.join(plugin.dir, "skills", "file-issue"), {
			recursive: true,
		});

		expect(checkPlugin(ctx, plugin)[0]?.problem).toContain(
			"skills/file-issue/SKILL.md",
		);
	});

	test("catches a manifest edited in place after publishing", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		writeJson(path.join(plugin.dir, "plugin.json"), {
			...(plugin.manifest as object),
			description: "rewritten without republishing",
		});

		expect(checkPlugin(ctx, plugin)[0]?.problem).toContain("plugin.json");
	});

	// publish stamps the server digest into the published manifest *after*
	// copying it, so this one field is legitimately not byte-identical.
	test("the server integrity stamp is not drift", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		const published = path.join(plugin.dir, "versions", "1.3.0", "plugin.json");
		const manifest = JSON.parse(fs.readFileSync(published, "utf8"));
		manifest.extensions.superset.server = {
			path: "plugins/linear/versions/1.3.0/server/index.js",
			integrity: "sha256-abc",
		};
		writeJson(published, manifest);

		expect(checkPlugin(ctx, plugin)).toEqual([]);
	});

	test("catches a marketplace entry left on the old version", () => {
		const { ctx, plugin } = publishedPlugin("linear", "1.3.0");
		ctx.marketplace.plugins[0]!.version = "1.2.0";

		expect(checkPlugin(ctx, plugin)[0]?.problem).toContain(
			"publish to reconcile",
		);
	});
});

describe("generatedManifestDrift", () => {
	function sharedPluginsDir(): string {
		const dir = path.join(root, "packages", "shared", "src", "plugins");
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	test("is silent when the repo has no bundle to keep in step", () => {
		const { ctx } = publishedPlugin("linear", "1.3.0");
		expect(generatedManifestDrift(ctx)).toEqual([]);
	});

	test("reports a missing bundle", () => {
		const { ctx } = publishedPlugin("linear", "1.3.0");
		sharedPluginsDir();

		expect(generatedManifestDrift(ctx)[0]?.problem).toContain("missing");
	});

	test("reports a bundle a publish would rewrite", () => {
		const { ctx } = publishedPlugin("linear", "1.3.0");
		fs.writeFileSync(
			path.join(sharedPluginsDir(), "manifests.generated.ts"),
			"export const FIRST_PARTY_MANIFESTS = {} as const;\n",
		);

		expect(generatedManifestDrift(ctx)[0]?.problem).toContain("stale");
	});
});
