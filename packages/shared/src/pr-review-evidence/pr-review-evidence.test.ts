import { describe, expect, test } from "bun:test";
import { collectPullRequestEvidence } from "./collect-evidence";
import { SAMPLE_CHECKS, SAMPLE_DIFF, SOURCE_ONLY_DIFF } from "./fixtures";
import { parsePullRequestDiff } from "./parse-pr-diff";
import { toReviewTabEvidenceItems } from "./review-tab-adapter";

describe("parsePullRequestDiff", () => {
	test("reads path, change type, line counts and test-file facts", () => {
		const files = parsePullRequestDiff(SAMPLE_DIFF);
		expect(files.map((f) => f.path)).toEqual([
			"packages/shared/src/format-tokens.ts",
			"packages/shared/src/format-tokens.test.ts",
			"packages/shared/src/legacy-format.test.ts",
		]);

		const [source, addedTest, deletedTest] = files;
		expect(source).toMatchObject({
			changeType: "modified",
			additions: 2,
			deletions: 1,
			isTestFile: false,
		});
		expect(addedTest).toMatchObject({
			changeType: "added",
			additions: 4,
			deletions: 0,
			isTestFile: true,
		});
		expect(deletedTest).toMatchObject({
			changeType: "deleted",
			additions: 0,
			deletions: 3,
			isTestFile: true,
		});
	});

	test("returns nothing for empty or non-diff input", () => {
		expect(parsePullRequestDiff("")).toEqual([]);
		expect(parsePullRequestDiff("not a diff at all\n")).toEqual([]);
	});

	test("records a rename under its new path and keeps the old one", () => {
		const patch = [
			"diff --git a/src/old-name.ts b/src/new-name.ts",
			"similarity index 98%",
			"rename from src/old-name.ts",
			"rename to src/new-name.ts",
		].join("\n");
		expect(parsePullRequestDiff(patch)).toEqual([
			{
				path: "src/new-name.ts",
				previousPath: "src/old-name.ts",
				changeType: "renamed",
				additions: 0,
				deletions: 0,
				isTestFile: false,
			},
		]);
	});
});

describe("collectPullRequestEvidence — present evidence", () => {
	test("emits settled checks and changed test files as machine evidence", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: SAMPLE_DIFF,
			body: null,
			reviewDecision: null,
		});

		const checkItems = evidence.machine.filter((i) => i.kind === "check");
		expect(checkItems).toEqual([
			{
				id: "machine:check:test",
				kind: "check",
				confirmation: "machine",
				status: "satisfied",
				label: "test",
				detail: "Check concluded: success",
				sourceRef: "https://example.invalid/checks/1",
			},
			{
				id: "machine:check:typecheck",
				kind: "check",
				confirmation: "machine",
				status: "failed",
				label: "typecheck",
				detail: "Check concluded: failure",
				sourceRef: undefined,
			},
		]);

		const testItems = evidence.machine.filter((i) => i.kind === "test-file");
		expect(testItems.map((i) => [i.label, i.status, i.detail])).toEqual([
			[
				"packages/shared/src/format-tokens.test.ts",
				"satisfied",
				"Test file added in this pull request (+4 / -0 lines)",
			],
			[
				"packages/shared/src/legacy-format.test.ts",
				"neutral",
				"Test file deleted in this pull request (+0 / -3 lines)",
			],
		]);
	});

	test("drops checks that have not settled, and says why", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: null,
			body: null,
			reviewDecision: null,
		});
		expect(evidence.dropped).toContainEqual({
			reason: "check-unsettled",
			detail: 'Check "e2e" has not concluded (status: in_progress)',
		});
	});
});

describe("collectPullRequestEvidence — absent evidence", () => {
	test("produces no items when there is nothing settled to report", () => {
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: SOURCE_ONLY_DIFF,
			body: null,
			reviewDecision: null,
		});
		expect(evidence.machine).toEqual([]);
		expect(evidence.human).toEqual([]);
	});

	test("an empty input is not an error", () => {
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: null,
			body: null,
			reviewDecision: null,
		});
		expect(evidence).toEqual({ machine: [], human: [], dropped: [] });
	});
});

describe("collectPullRequestEvidence — missing or invalid provider fields", () => {
	test("skips checks whose name or conclusion is missing or the wrong type", () => {
		const evidence = collectPullRequestEvidence({
			checks: [
				{ name: "", status: "completed", conclusion: "success" },
				{ name: "   ", status: "completed", conclusion: "success" },
				{ name: "lint", status: "completed", conclusion: null },
				{ name: "build", status: "completed", conclusion: "banana" },
				// A provider that sends the wrong types entirely.
				{ name: 7, status: "completed", conclusion: "success" },
				{ name: "audit", status: null, conclusion: "success" },
			] as never,
			diffPatch: null,
			body: null,
			reviewDecision: null,
		});

		expect(evidence.machine).toEqual([]);
		expect(evidence.dropped.map((d) => d.reason)).toEqual([
			"check-invalid",
			"check-invalid",
			"check-unsettled",
			"check-invalid",
			"check-invalid",
			"check-unsettled",
		]);
	});

	test("keeps ids unique when a matrix repeats a check name", () => {
		const evidence = collectPullRequestEvidence({
			checks: [
				{ name: "test", status: "completed", conclusion: "success" },
				{ name: "test", status: "completed", conclusion: "failure" },
			],
			diffPatch: null,
			body: null,
			reviewDecision: null,
		});
		expect(evidence.machine.map((i) => i.id)).toEqual([
			"machine:check:test",
			"machine:check:test#2",
		]);
	});

	test("tolerates a truncated diff without inventing files", () => {
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch:
				"diff --git a/src/a.test.ts b/src/a.test.ts\nnew file mode 100",
			body: null,
			reviewDecision: null,
		});
		expect(evidence.machine.map((i) => i.label)).toEqual(["src/a.test.ts"]);
	});
});

describe("collectPullRequestEvidence — human confirmation stays separate", () => {
	test("an approval is human evidence and never machine evidence", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: null,
			body: null,
			reviewDecision: "approved",
		});
		expect(evidence.human).toEqual([
			{
				id: "human:review-approval",
				kind: "review-approval",
				confirmation: "human",
				status: "satisfied",
				label: "Approved by a reviewer",
				detail: "GitHub review decision: approved",
				sourceRef: undefined,
			},
		]);
		expect(evidence.machine.every((i) => i.confirmation === "machine")).toBe(
			true,
		);
	});

	test("changes requested is recorded, other decisions are not", () => {
		const requested = collectPullRequestEvidence({
			checks: [],
			diffPatch: null,
			body: null,
			reviewDecision: "changes_requested",
		});
		expect(requested.human.map((i) => i.status)).toEqual(["failed"]);

		for (const decision of ["review_required", "", null, "APPROVED_MAYBE"]) {
			const evidence = collectPullRequestEvidence({
				checks: [],
				diffPatch: null,
				body: null,
				reviewDecision: decision,
			});
			expect(evidence.human).toEqual([]);
		}
	});
});

describe("collectPullRequestEvidence — testing claims", () => {
	test("corroborates a claim that names a test file in the diff", () => {
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: SAMPLE_DIFF,
			body: "## Test plan\n- [x] Added `packages/shared/src/format-tokens.test.ts`\n",
			reviewDecision: null,
		});
		const claims = evidence.machine.filter((i) => i.kind === "testing-claim");
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({
			status: "satisfied",
			detail:
				"Claim names packages/shared/src/format-tokens.test.ts, which this pull request changes",
			sourceRef: "packages/shared/src/format-tokens.test.ts",
		});
	});

	test("a claim naming a check carries that check's outcome, not the claim's", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: null,
			body: "Test plan: `typecheck` passes locally.",
			reviewDecision: null,
		});
		const claims = evidence.machine.filter((i) => i.kind === "testing-claim");
		expect(claims).toHaveLength(1);
		expect(claims[0]).toMatchObject({
			status: "failed",
			detail: 'Claim names check "typecheck", which concluded: failure',
			sourceRef: undefined,
		});
	});

	test("matches a claim that names only the tail of a changed path", () => {
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: SAMPLE_DIFF,
			body: "Test plan: see `src/format-tokens.test.ts`.",
			reviewDecision: null,
		});
		expect(
			evidence.machine.find((i) => i.kind === "testing-claim")?.sourceRef,
		).toBe("packages/shared/src/format-tokens.test.ts");
	});

	test("a claim with nothing to match against produces no evidence", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: SAMPLE_DIFF,
			body: "## Test plan\n- [x] Ran `bun test packages/api/src/never-touched.test.ts`\n- [x] Tested it by hand\n",
			reviewDecision: null,
		});
		expect(evidence.machine.some((i) => i.kind === "testing-claim")).toBe(
			false,
		);
		expect(evidence.dropped).toContainEqual({
			reason: "claim-uncorroborated",
			detail:
				"No changed file or settled check matches: Ran `bun test packages/api/src/never-touched.test.ts`",
		});
	});

	test("lines that are not testing claims are ignored entirely", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: SAMPLE_DIFF,
			body: "## Summary\nRewrites `packages/shared/src/format-tokens.ts` for clarity.\n",
			reviewDecision: null,
		});
		expect(evidence.machine.some((i) => i.kind === "testing-claim")).toBe(
			false,
		);
		expect(evidence.dropped).toEqual([
			{
				reason: "check-unsettled",
				detail: 'Check "e2e" has not concluded (status: in_progress)',
			},
		]);
	});

	test("a deleted test named by a claim is reported as deleted, not as passing", () => {
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: SAMPLE_DIFF,
			body: "Test plan: covered by `packages/shared/src/legacy-format.test.ts`.",
			reviewDecision: null,
		});
		const claim = evidence.machine.find((i) => i.kind === "testing-claim");
		expect(claim).toMatchObject({
			status: "neutral",
			detail:
				"Claim names packages/shared/src/legacy-format.test.ts, which this pull request deletes",
		});
	});
});

describe("toReviewTabEvidenceItems", () => {
	test("maps to the Review tab contract and keeps the source in the id", () => {
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: SAMPLE_DIFF,
			body: null,
			reviewDecision: "approved",
		});
		const items = toReviewTabEvidenceItems(evidence);

		expect(items.every((i) => i.kind === "document")).toBe(true);
		expect(items.map((i) => i.id)).toEqual([
			"human:review-approval",
			"machine:check:test",
			"machine:check:typecheck",
			"machine:test-file:packages/shared/src/format-tokens.test.ts",
			"machine:test-file:packages/shared/src/legacy-format.test.ts",
		]);
		expect(items[0]?.label).toBe("Approved by a reviewer");
	});

	test("maps an empty result to an empty list", () => {
		expect(
			toReviewTabEvidenceItems({ machine: [], human: [], dropped: [] }),
		).toEqual([]);
	});
});
