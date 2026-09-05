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

	test("fails when the base moves while collecting", async () => {
		let pullCalls = 0;
		const api = apiWith();
		const movingBase: Api = async (path) => {
			if (path === "repos/acme/widgets/pulls/8" && ++pullCalls === 2)
				return {
					title: "x",
					body: null,
					html_url: target.url,
					head: { sha: head },
					base: { sha: "base-later" },
				};
			return api(path);
		};
		await expect(collectBrief(target, movingBase)).rejects.toThrow(
			"base changed during collection",
		);
	});

	test("retains raw check provenance and status history without inferring a verdict", async () => {
		const api = apiWith();
		const provenanceApi: Api = async (path) => {
			if (path.includes("/check-runs?"))
				return {
					check_runs: [
						{
							name: "mismatch",
							status: "completed",
							conclusion: "neutral",
							head_sha: "other-head",
							details_url: null,
						},
						{
							name: "missing",
							status: "completed",
							conclusion: "skipped",
							details_url: null,
						},
						{
							name: "failure",
							status: "completed",
							conclusion: "failure",
							head_sha: head,
							details_url: null,
						},
						{
							name: "pending",
							status: "in_progress",
							conclusion: null,
							head_sha: head,
							details_url: null,
						},
						{
							name: "unknown",
							status: "completed",
							conclusion: "mystery",
							head_sha: head,
							details_url: null,
						},
					],
				};
			if (path.includes("/statuses?"))
				return [
					{
						context: "legacy",
						state: "pending",
						target_url: null,
						created_at: "2026-09-01T00:00:00Z",
						updated_at: "2026-09-01T00:00:00Z",
					},
					{
						context: "legacy",
						state: "success",
						target_url: null,
						created_at: "2026-09-02T00:00:00Z",
						updated_at: "2026-09-02T00:00:00Z",
					},
				];
			return api(path);
		};
		const brief = (await collectBrief(target, provenanceApi)) as unknown as {
			checks: Array<Record<string, unknown>>;
		};
		expect(brief.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "mismatch",
					headSha: "other-head",
					status: "completed",
					conclusion: "neutral",
					headShaConfirmation: "mismatch",
				}),
				expect.objectContaining({
					name: "missing",
					headSha: null,
					conclusion: "skipped",
					headShaConfirmation: "missing",
				}),
				expect.objectContaining({ name: "failure", conclusion: "failure" }),
				expect.objectContaining({
					name: "pending",
					status: "in_progress",
					conclusion: null,
				}),
				expect.objectContaining({ name: "unknown", conclusion: "mystery" }),
				expect.objectContaining({
					name: "legacy",
					state: "pending",
					historical: true,
					createdAt: "2026-09-01T00:00:00Z",
				}),
				expect.objectContaining({
					name: "legacy",
					state: "success",
					historical: true,
					updatedAt: "2026-09-02T00:00:00Z",
				}),
			]),
		);
	});

	test("renders all remote text literally and restricts link destinations", () => {
		const markdown = renderMarkdown({
			collectionTimestamp: "2026-09-05T00:00:00Z",
			target,
			title: "<img src=x onerror=alert(1)> [x](javascript:alert(1))",
			headSha: head,
			baseSha: "base",
			revisionState: "stable",
			sources: [
				{
					name: "<b>source</b>",
					url: "javascript:alert(1)",
					state: "collected",
				},
			],
			files: [
				{ filename: "x](https://attacker)", status: "<em>modified</em>" },
			],
			checks: [
				{
					name: "<img>",
					kind: "check-run",
					state: "unknown",
					url: "https://ci/x) [injected](https://attacker",
					headSha: head,
				},
			],
			reviews: [
				{
					id: 1,
					state: "APPROVED",
					commitId: head,
					url: "data:text/html,boom",
				},
			],
			authorBody:
				"<script>alert(1)</script>\r\n[x](javascript:alert(1))\r\n```\r\n> quoted",
		} as never);
		expect(markdown).not.toContain("<img");
		expect(markdown).not.toContain("<script>");
		expect(markdown).toContain(
			"[&lt;b&gt;source&lt;/b&gt;](https://github.com/acme/widgets/pull/8)",
		);
		expect(markdown).toContain(
			"[review 1](https://github.com/acme/widgets/pull/8)",
		);
		expect(markdown).not.toContain("\r");
		expect(markdown).toContain(
			"https://ci/x%29%20%5Binjected%5D%28https://attacker",
		);
		expect(markdown).toContain("\\[x\\]\\(javascript:alert\\(1\\)\\)");
	});

	test("identifies reviewer actors and documents the excluded comment scope", async () => {
		const api = apiWith();
		const reviewsApi: Api = async (path) =>
			path.includes("/reviews?")
				? [
						{
							id: 12,
							state: "APPROVED",
							commit_id: "old-head",
							user: { login: "dependabot[bot]", type: "Bot" },
						},
					]
				: api(path);
		const brief = await collectBrief(target, reviewsApi);
		const review = (brief.reviews[0] ?? {}) as Record<string, unknown>;
		expect(review).toMatchObject({
			actorLogin: "dependabot[bot]",
			actorType: "Bot",
			actorKind: "bot",
		});
		const markdown = renderMarkdown(brief);
		expect(markdown).toContain("Formal review history (actors may be bots)");
		expect(markdown).toContain(
			"Issue conversation comments and inline review comments are not collected",
		);
	});

	test("uses the selectively reused native-review-evidence test patterns", () => {
		const markdown = renderMarkdown({
			collectionTimestamp: "2026-09-05T00:00:00Z",
			target,
			title: "x",
			headSha: head,
			baseSha: "base",
			revisionState: "stable",
			sources: [],
			files: [
				"a/__tests__/x.ts",
				"a/x.test.tsx",
				"test_widget.py",
				"widget_test.go",
				"spec/models/user_spec.rb",
			].map((filename) => ({ filename, status: "modified" })),
			checks: [],
			reviews: [],
			authorBody: null,
		} as never);
		expect((markdown.match(/test file changed/g) ?? []).length).toBe(5);
	});
});
