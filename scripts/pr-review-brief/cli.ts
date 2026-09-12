import { parseCliOptions } from "./cli-options";
import {
	collectBrief,
	parsePublicPullRequestUrl,
	renderCompactMarkdown,
	renderMarkdown,
} from "./pr-review-brief";

const options = parseCliOptions(process.argv.slice(2));
if (options.mode === "help") {
	console.log(
		"Usage: bun scripts/pr-review-brief/cli.ts [--full | --json] https://github.com/OWNER/REPO/pull/NUMBER\n\nDefault output is a compact review note. --full prints the complete Markdown record; --json prints the unchanged collected JSON.",
	);
	process.exit(0);
}
if (options.mode === "invalid") {
	console.error(
		"Usage: bun scripts/pr-review-brief/cli.ts [--full | --json] https://github.com/OWNER/REPO/pull/NUMBER",
	);
	process.exit(2);
}
try {
	const brief = await collectBrief(parsePublicPullRequestUrl(options.input));
	console.log(
		options.mode === "json"
			? JSON.stringify(brief, null, 2)
			: options.mode === "full"
				? renderMarkdown(brief)
				: renderCompactMarkdown(brief),
	);
	if (brief.revisionState === "incomplete") process.exitCode = 2;
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
