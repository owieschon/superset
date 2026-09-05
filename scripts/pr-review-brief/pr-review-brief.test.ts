import { describe, expect, test } from "bun:test";
import {
	type Api,
	collectBrief,
	parsePublicPullRequestUrl,
	renderMarkdown,
} from "./pr-review-brief";

const target = parsePublicPullRequestUrl(
	"https://github.com/acme/widgets/pull/8",
);
const head = "head-new";
function apiWith(overrides: Record<string, unknown> = {}): Api {
	let pullCalls = 0;
	return async (path) => {
		if (path === "repos/acme/widgets") return { private: false };
		if (path === "repos/acme/widgets/pulls/8")
			return overrides.moving && ++pullCalls === 2
				? {
						title: "x",
						body: null,
						html_url: target.url,
						head: { sha: "head-later" },
						base: { sha: "base" },
					}
				: {
						title: "Unsafe [title]",
						body: "- Tests not run: `manual QA`\n- ran tests for src/a.test.ts",
						html_url: target.url,
						head: { sha: head },
						base: { sha: "base" },
					};
		if (path.includes("/files?"))
			return [{ filename: "src/a.test.ts", status: "modified" }];
		if (path.includes("/check-runs?"))
			return {
				check_runs: [
					{
						name: "green",
						status: "completed",
						conclusion: "success",
						details_url: "https://ci/green",
					},
					{
						name: "red",
						status: "completed",
						conclusion: "failure",
						details_url: null,
					},
					{
						name: "wait",
						status: "in_progress",
						conclusion: null,
						details_url: null,
					},
					{
						name: "skip",
						status: "completed",
						conclusion: "skipped",
						details_url: null,
					},
					{
						name: "odd",
						status: "completed",
						conclusion: "mystery",
						details_url: null,
					},
				],
			};
		if (path.includes("/statuses?"))
			return [{ context: "legacy", state: "pending", target_url: null }];
		if (path.includes("/reviews?"))
			return [{ id: 12, state: "APPROVED", commit_id: "old-head" }];
		throw new Error(`unexpected ${path}`);
	};
}

describe("pr-review-brief", () => {
	test("accepts only canonical public github pull URLs", () => {
		expect(
			parsePublicPullRequestUrl("https://github.com/acme/widgets/pull/8")
				.number,
		).toBe(8);
		for (const value of [
			"http://github.com/acme/widgets/pull/8",
			"https://github.com/acme/widgets/issues/8",
			"https://github.com/acme/widgets/pull/8?x=$(rm)",
			"https://evil.test/acme/widgets/pull/8",
		])
			expect(() => parsePublicPullRequestUrl(value)).toThrow();
	});

	test("refuses private repositories before requesting their pull data", async () => {
		const privateApi: Api = async () => ({ private: true });
		await expect(collectBrief(target, privateApi)).rejects.toThrow(
			"Refusing to collect a private repository",
		);
	});

	test("keeps check states and old review provenance without a verdict", async () => {
		const brief = await collectBrief(
			target,
			apiWith(),
			new Date("2026-09-05T00:00:00Z"),
		);
		expect(brief.checks.map((check) => check.state)).toEqual([
			"success",
			"failure",
			"in_progress",
			"skipped",
			"mystery",
			"pending",
		]);
		const markdown = renderMarkdown(brief);
		expect(markdown).toContain(
			"commit `old-head` (not confirmed for collected head)",
		);
		expect(markdown).toContain("Tests not run");
		expect(markdown).toContain("\\`manual QA\\`");
		expect(markdown).toContain(
			"test file changed; this does not show execution or coverage",
		);
		expect(markdown).toContain("\\[title\\]");
		expect(markdown).toContain("[green](https://ci/green)");
	});

	test("marks unavailable source data incomplete", async () => {
		const api = apiWith();
		const unavailable: Api = async (path) =>
			path.includes("/reviews?")
				? Promise.reject(new Error("forbidden"))
				: api(path);
		const brief = await collectBrief(target, unavailable);
		expect(brief.revisionState).toBe("incomplete");
		expect(
			brief.sources.find((source) => source.name === "reviews")?.state,
		).toBe("unavailable");
	});

	test("marks bounded pagination truncated instead of treating it as complete", async () => {
		const api = apiWith();
		const paged: Api = async (path) =>
			path.includes("/files?")
				? Array.from({ length: 100 }, (_, index) => ({
						filename: `src/${index}.ts`,
						status: "modified",
					}))
				: api(path);
		const brief = await collectBrief(target, paged);
		expect(brief.revisionState).toBe("incomplete");
		expect(
			brief.sources.find((source) => source.name === "changed files")?.state,
		).toBe("truncated");
	});

	test("fails when the head moves while collecting", async () => {
		await expect(
			collectBrief(target, apiWith({ moving: true })),
		).rejects.toThrow("head changed during collection");
	});
});
