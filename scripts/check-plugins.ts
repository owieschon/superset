#!/usr/bin/env bun
import {
	findMarketplace,
	resolvePlugins,
} from "../packages/cli/src/lib/plugins/marketplace";
import {
	checkPlugin,
	generatedManifestDrift,
} from "../packages/cli/src/lib/plugins/publish";

/**
 * The CI half of `superset plugins check`.
 *
 * Everything the marketplace ships is a build artifact of `plugins/<name>/`:
 * the `versions/<v>/` snapshot the host downloads, and the manifests bundled
 * into @superset/shared for the API to resolve against. Nothing regenerates
 * them on the way into CI, so without this an edit that skipped `publish`
 * merges quietly and the API keeps serving a manifest — token_url, proxy
 * target, skill list — that no longer matches the repo.
 */
const ctx = findMarketplace();
const issues = [
	...resolvePlugins(ctx).flatMap((plugin) => checkPlugin(ctx, plugin)),
	...generatedManifestDrift(ctx),
];

if (issues.length) {
	console.error(
		`${issues.length} plugin problem${issues.length === 1 ? "" : "s"}:`,
	);
	for (const issue of issues)
		console.error(`  ${issue.name}: ${issue.problem}`);
	process.exit(1);
}

console.log(`All plugins are valid and published.`);
