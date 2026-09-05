export interface PullRequestTarget {
	owner: string;
	repo: string;
	number: number;
	url: string;
}

export interface SourceAvailability {
	name: string;
	url: string;
	state: "collected" | "unavailable" | "truncated";
	detail?: string;
}

interface Pull {
	title: string;
	body: string | null;
	html_url: string;
	head: { sha: string };
	base: { sha: string };
}

export interface Brief {
	collectionTimestamp: string;
	target: PullRequestTarget;
	title: string;
	headSha: string;
	baseSha: string;
	revisionState: "stable" | "incomplete";
	sources: SourceAvailability[];
	files: Array<{ filename: string; status: string }>;
	checks: Array<{
		name: string;
		kind: "check-run" | "commit-status";
		state: string;
		url: string | null;
		headSha: string;
	}>;
	reviews: Array<{
		id: number;
		state: string;
		commitId: string | null;
		url: string;
	}>;
	authorBody: string | null;
}

export type Api = (path: string) => Promise<unknown>;
const MAX_PAGES = 3;
const PAGE_SIZE = 100;

export function parsePublicPullRequestUrl(value: string): PullRequestTarget {
	const match =
		/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(
			value,
		);
	if (!match) {
		throw new Error(
			"Expected a public URL in the form https://github.com/OWNER/REPO/pull/NUMBER",
		);
	}
	const number = Number(match[3]);
	if (!Number.isSafeInteger(number) || number < 1)
		throw new Error("Pull request number must be positive");
	return {
		owner: match[1],
		repo: match[2],
		number,
		url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`,
	};
}

export async function ghApi(path: string): Promise<unknown> {
	const child = Bun.spawn(
		["gh", "api", "--hostname", "github.com", "--method", "GET", path],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0)
		throw new Error(
			`GitHub API request failed for ${path}: ${stderr.trim() || `exit ${exitCode}`}`,
		);
	try {
		return JSON.parse(stdout) as unknown;
	} catch {
		throw new Error(`GitHub API returned invalid JSON for ${path}`);
	}
}

export async function collectBrief(
	target: PullRequestTarget,
	api: Api = ghApi,
	now = new Date(),
): Promise<Brief> {
	const repoPath = `repos/${target.owner}/${target.repo}`;
	const repo = (await api(repoPath)) as { private?: unknown };
	if (repo.private !== false)
		throw new Error("Refusing to collect a private repository");
	const first = (await api(`${repoPath}/pulls/${target.number}`)) as Pull;
	const sources: SourceAvailability[] = [
		{ name: "pull request", url: target.url, state: "collected" },
	];
	const files = await collectPages<{ filename: string; status: string }>(
		api,
		`${repoPath}/pulls/${target.number}/files`,
		"changed files",
		`${target.url}/files`,
		sources,
	);
	const checks = await collectChecks(
		api,
		repoPath,
		first.head.sha,
		target,
		sources,
	);
	const reviews = await collectPages<{
		id: number;
		state: string;
		commit_id: string | null;
	}>(
		api,
		`${repoPath}/pulls/${target.number}/reviews`,
		"reviews",
		`${target.url}/files`,
		sources,
	);
	const second = (await api(`${repoPath}/pulls/${target.number}`)) as Pull;
	if (first.head.sha !== second.head.sha)
		throw new Error(
			`Pull request head changed during collection (${first.head.sha} → ${second.head.sha}); no complete brief was produced`,
		);
	return {
		collectionTimestamp: now.toISOString(),
		target,
		title: first.title,
		headSha: first.head.sha,
		baseSha: first.base.sha,
		revisionState: sources.every((source) => source.state === "collected")
			? "stable"
			: "incomplete",
		sources,
		files: files.items,
		checks: checks.items,
		reviews: reviews.items.map((review) => ({
			id: review.id,
			state: review.state,
			commitId: review.commit_id,
			url: `${target.url}#pullrequestreview-${review.id}`,
		})),
		authorBody: first.body,
	};
}

async function collectChecks(
	api: Api,
	repoPath: string,
	sha: string,
	target: PullRequestTarget,
	sources: SourceAvailability[],
) {
	const runs = await collectPages<{
		name: string;
		status: string;
		conclusion: string | null;
		details_url: string | null;
	}>(
		api,
		`${repoPath}/commits/${sha}/check-runs`,
		"check runs",
		`${target.url}/checks`,
		sources,
		"check_runs",
	);
	const statuses = await collectPages<{
		context: string;
		state: string;
		target_url: string | null;
	}>(
		api,
		`${repoPath}/commits/${sha}/statuses`,
		"commit statuses",
		`${target.url}/commits/${sha}`,
		sources,
	);
	return {
		items: [
			...runs.items.map((run) => ({
				name: run.name,
				kind: "check-run" as const,
				state: checkRunState(run.status, run.conclusion),
				url: run.details_url ?? `${target.url}/checks`,
				headSha: sha,
			})),
			...statuses.items.map((status) => ({
				name: status.context,
				kind: "commit-status" as const,
				state: status.state || "unknown",
				url: status.target_url ?? `${target.url}/commits/${sha}`,
				headSha: sha,
			})),
		],
	};
}

function checkRunState(status: string, conclusion: string | null): string {
	if (status !== "completed") return status || "unknown";
	if (conclusion === "success") return "success";
	if (
		["failure", "timed_out", "action_required", "startup_failure"].includes(
			conclusion ?? "",
		)
	)
		return "failure";
	if (["neutral", "skipped"].includes(conclusion ?? "")) return "skipped";
	if (conclusion === "cancelled") return "cancelled";
	return conclusion || "unknown";
}

async function collectPages<T>(
	api: Api,
	base: string,
	name: string,
	url: string,
	sources: SourceAvailability[],
	property?: string,
): Promise<{ items: T[] }> {
	const items: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		try {
			const raw = (await api(
				`${base}?per_page=${PAGE_SIZE}&page=${page}`,
			)) as unknown;
			const value = property ? (raw as Record<string, unknown>)[property] : raw;
			if (!Array.isArray(value)) throw new Error("response was not a list");
			items.push(...(value as T[]));
			if (value.length < PAGE_SIZE) {
				sources.push({ name, url, state: "collected" });
				return { items };
			}
		} catch (error) {
			sources.push({
				name,
				url,
				state: "unavailable",
				detail: error instanceof Error ? error.message : String(error),
			});
			return { items };
		}
	}
	sources.push({
		name,
		url,
		state: "truncated",
		detail: `Stopped after ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} records maximum)`,
	});
	return { items };
}

export function renderMarkdown(brief: Brief): string {
	const e = escapeMarkdown;
	const link = (text: string, url: string | null) =>
		url ? `[${e(text)}](${url})` : e(text);
	const sourceLines = brief.sources.map(
		(source) =>
			`- ${link(source.name, source.url)} — **${source.state}**${source.detail ? `: ${e(source.detail)}` : ""}`,
	);
	const fileLines = brief.files.length
		? brief.files.map(
				(file) =>
					`- ${link(file.filename, `${brief.target.url}/files`)} — ${e(file.status)}${isTestFile(file.filename) ? " (test file changed; this does not show execution or coverage)" : ""}`,
			)
		: ["- No changed-file records were collected."];
	const checkLines = brief.checks.length
		? brief.checks.map(
				(check) =>
					`- ${link(check.name, check.url)} — **${e(check.state)}** (${check.kind}; recorded for head \`${check.headSha}\`)`,
			)
		: ["- No check/status records were collected."];
	const reviewLines = brief.reviews.length
		? brief.reviews.map(
				(review) =>
					`- ${link(`review ${review.id}`, review.url)} — **${e(review.state)}**; commit ${review.commitId ? `\`${review.commitId}\`` : "not recorded"}${review.commitId !== brief.headSha ? " (not confirmed for collected head)" : ""}`,
			)
		: ["- No review records were collected."];
	const body =
		brief.authorBody === null
			? "> _No author body was provided._"
			: brief.authorBody
					.split("\n")
					.map((line) => `> ${escapeMarkdown(line).replaceAll(">", "\\>")}`)
					.join("\n");
	return `# PR review brief: ${e(brief.title)}\n\n[Pull request #${brief.target.number}](${brief.target.url}) · collected ${brief.collectionTimestamp}\n\n- Base: \`${brief.baseSha}\`\n- Head: \`${brief.headSha}\`\n- Revision collection: **${brief.revisionState}**. Checks/statuses are recorded for this head; they do not describe a merge result.\n\n## Collection sources\n\n${sourceLines.join("\n")}\n\n## Changed files\n\n${fileLines.join("\n")}\n\n## Checks and statuses\n\n${checkLines.join("\n")}\n\n## Human reviews\n\n${reviewLines.join("\n")}\n\n## Author-provided description (untrusted source)\n\n${body}\n\nAuthor statements, including test claims or statements that work was not run, are quoted above as unverified source material. Changed test files indicate files changed only—not tests executed or coverage. This brief reports records and gaps; it provides no overall readiness, safety, correctness, or pass verdict.\n`;
}

function isTestFile(path: string): boolean {
	return /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/.test(
		path,
	);
}
function escapeMarkdown(value: string): string {
	return value.replaceAll("\\", "\\\\").replace(/[[\]`*_]/g, "\\$&");
}
