import {
	collectBrief,
	parsePublicPullRequestUrl,
	renderMarkdown,
} from "./pr-review-brief";

const args = process.argv.slice(2);
const json = args[0] === "--json";
const input = args[json ? 1 : 0];
if (!input || args.length !== (json ? 2 : 1)) {
	console.error(
		"Usage: bun scripts/pr-review-brief/cli.ts [--json] https://github.com/OWNER/REPO/pull/NUMBER",
	);
	process.exit(2);
}
try {
	const brief = await collectBrief(parsePublicPullRequestUrl(input));
	console.log(json ? JSON.stringify(brief, null, 2) : renderMarkdown(brief));
	if (brief.revisionState === "incomplete") process.exitCode = 2;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
