import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createManagedSkills } from "./managed-skills";

/**
 * Packaged-artifact integrity of provisioned skill bundles. These reproduce
 * what installed 1.25.1 lost: referenced nested extras must survive
 * byte-for-byte, executables must stay runnable when the source mode is
 * flattened the way Electron's ASAR shim flattens it, and a second
 * provisioner's in-flight staged write must not be reaped.
 */

const TEST_ROOT = path.join(
	os.tmpdir(),
	`superset-skill-integrity-${process.pid}-${Date.now()}`,
);
const HOME_DIR = path.join(TEST_ROOT, "home");
const TEMPLATES_DIR = path.join(TEST_ROOT, "templates");
const BUNDLED_PLUGIN = path.join(TEMPLATES_DIR, "plugin");
const SUPERSET_HOME = path.join(TEST_ROOT, "superset");
const REAL_PLUGIN = path.resolve(import.meta.dir, "../../../plugins/superset");

const agentsSkills = path.join(HOME_DIR, ".agents", "skills");

function skillMd(name: string): string {
	return `---\nname: ${name}\ndescription: test ${name} skill\n---\n\n# ${name} body\n`;
}

function seedBundledPlugin(): void {
	mkdirSync(path.join(BUNDLED_PLUGIN, ".claude-plugin"), { recursive: true });
	writeFileSync(
		path.join(BUNDLED_PLUGIN, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "superset", version: "0.3.0" }),
	);
	for (const name of ["feedback", "10x", "orchestrate"]) {
		const dir = path.join(BUNDLED_PLUGIN, "skills", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "SKILL.md"), skillMd(name));
	}
	const agentsExtra = path.join(
		BUNDLED_PLUGIN,
		"skills",
		"orchestrate",
		"agents",
	);
	mkdirSync(agentsExtra, { recursive: true });
	writeFileSync(path.join(agentsExtra, "openai.yaml"), "model: test\n");
	writeFileSync(
		path.join(BUNDLED_PLUGIN, "skills", "orchestrate", "asset.bin"),
		Buffer.from([0x00, 0x80, 0xff, 0x0a]),
	);
}

async function run(): Promise<void> {
	await createManagedSkills({
		homeDir: HOME_DIR,
		templatesDir: TEMPLATES_DIR,
		pluginSources: [],
	});
}

beforeEach(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
	seedBundledPlugin();
	mkdirSync(HOME_DIR, { recursive: true });
	process.env.SUPERSET_HOME_DIR = SUPERSET_HOME;
});

afterEach(() => {
	rmSync(TEST_ROOT, { recursive: true, force: true });
	process.env.SUPERSET_HOME_DIR = undefined;
});

describe("provisioned skill bundle integrity", () => {
	it("preserves a nested binary extra byte-for-byte", async () => {
		await run();
		expect(
			readFileSync(
				path.join(agentsSkills, "superset-orchestrate", "asset.bin"),
			),
		).toEqual(Buffer.from([0x00, 0x80, 0xff, 0x0a]));
	});

	it("mirrors packaged extras from the real bundled plugin on install and reprovision", async () => {
		const packagedTemplates = path.join(TEST_ROOT, "packaged-templates");
		cpSync(REAL_PLUGIN, path.join(packagedTemplates, "plugin"), {
			recursive: true,
		});
		// Electron's ASAR fs shim does not expose the source executable bit.
		chmodSync(
			path.join(
				packagedTemplates,
				"plugin",
				"skills",
				"10x",
				"scripts",
				"audit.sh",
			),
			0o644,
		);
		const provisionPackagedPlugin = () =>
			createManagedSkills({
				homeDir: HOME_DIR,
				templatesDir: packagedTemplates,
				pluginSources: [],
			});

		await provisionPackagedPlugin();
		const auditScript = path.join(
			agentsSkills,
			"superset-10x",
			"scripts",
			"audit.sh",
		);
		expect(readFileSync(auditScript, "utf-8")).toContain(
			"run_json auth whoami",
		);
		expect(statSync(auditScript).mode & 0o111).not.toBe(0);

		const staleExtra = path.join(
			agentsSkills,
			"superset-10x",
			"scripts",
			"removed.sh",
		);
		writeFileSync(staleExtra, "stale\n");

		await provisionPackagedPlugin();

		expect(existsSync(staleExtra)).toBe(false);
		expect(existsSync(auditScript)).toBe(true);
	});

	it("leaves another provisioner's staged write alone while reaping stale files", async () => {
		await run();
		const agentsDir = path.join(agentsSkills, "superset-orchestrate", "agents");
		// A second provisioner on this machine (a CLI host-service alongside the
		// desktop) stages its replacement under a pid that is not ours.
		const staged = path.join(agentsDir, `openai.yaml.${process.pid + 1}.tmp`);
		writeFileSync(staged, "model: staged\n");
		const stale = path.join(agentsDir, "gemini.yaml");
		writeFileSync(stale, "model: stale\n");

		await run();

		expect(existsSync(staged)).toBe(true);
		expect(existsSync(stale)).toBe(false);
	});
});
