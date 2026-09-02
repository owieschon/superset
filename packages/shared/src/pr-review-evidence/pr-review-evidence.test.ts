import { describe, expect, test } from "bun:test";
import { collectPullRequestEvidence } from "./collect-evidence";
import { SAMPLE_CHECKS, SAMPLE_DIFF, SOURCE_ONLY_DIFF } from "./fixtures";
import { parsePullRequestDiff } from "./parse-pr-diff";

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
				detail: "Check status: success",
				sourceRef: "https://example.invalid/checks/1",
			},
			{
				id: "machine:check:typecheck",
				kind: "check",
				confirmation: "machine",
				status: "failed",
				label: "typecheck",
				detail: "Check status: failure",
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
			detail: 'Check "e2e" has not produced a verdict (status: pending)',
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
	test("skips checks whose name or status is missing or unrecognized", () => {
		const evidence = collectPullRequestEvidence({
			checks: [
				{ name: "", status: "success", url: null },
				{ name: "   ", status: "success", url: null },
				{ name: "lint", status: "cancelled", url: null },
				// `parseChecksJson` only asserts `status` is a string, so an
				// unrecognized value is reachable from the cached column.
				{ name: "build", status: "banana", url: null },
				// A provider that sends the wrong types entirely.
				{ name: 7, status: "success", url: null },
				{ name: "audit", status: null, url: null },
			] as never,
			diffPatch: null,
			body: null,
			reviewDecision: null,
		});

		expect(evidence.machine).toEqual([]);
		expect(evidence.dropped.map((d) => d.reason)).toEqual([
			// empty name, whitespace-only name
			"check-invalid",
			"check-invalid",
			// cancelled: ran, but never produced a verdict
			"check-unsettled",
			// unrecognized status, non-string name, null status
			"check-invalid",
			"check-invalid",
			"check-invalid",
		]);
	});

	test("keeps ids unique when a matrix repeats a check name", () => {
		const evidence = collectPullRequestEvidence({
			checks: [
				{ name: "test", status: "success", url: null },
				{ name: "test", status: "failure", url: null },
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

		// "pending" is in the vocabulary and means nobody has decided yet.
		for (const decision of ["pending", null] as const) {
			const evidence = collectPullRequestEvidence({
				checks: [],
				diffPatch: null,
				body: null,
				reviewDecision: decision,
			});
			expect(evidence.human).toEqual([]);
		}

		// Values the type forbids, which a loose caller could still pass:
		// recorded human confirmation stays empty rather than being guessed.
		for (const decision of ["review_required", "", "APPROVED_MAYBE"]) {
			const evidence = collectPullRequestEvidence({
				checks: [],
				diffPatch: null,
				body: null,
				reviewDecision: decision as never,
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
			detail: 'Claim names check "typecheck", whose status is settled',
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
				detail: 'Check "e2e" has not produced a verdict (status: pending)',
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

describe("collectPullRequestEvidence — path normalization and near misses", () => {
	test("a claim may write a changed path with a ./ or / repo-root prefix", () => {
		for (const written of [
			"packages/shared/src/format-tokens.test.ts",
			"./packages/shared/src/format-tokens.test.ts",
			"/packages/shared/src/format-tokens.test.ts",
		]) {
			const evidence = collectPullRequestEvidence({
				checks: [],
				diffPatch: SAMPLE_DIFF,
				body: `Tested via \`${written}\``,
				reviewDecision: null,
			});
			const claims = evidence.machine.filter(
				(item) => item.kind === "testing-claim",
			);
			expect(claims.map((item) => item.sourceRef)).toEqual([
				"packages/shared/src/format-tokens.test.ts",
			]);
		}
	});

	test("a substring of a changed path is not a match", () => {
		// "tokens.ts" is a substring of "format-tokens.ts" but is not a whole
		// trailing path segment of it, so it corroborates nothing.
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: SAMPLE_DIFF,
			body: "Tested via `src/tokens.ts`",
			reviewDecision: null,
		});
		expect(evidence.machine.filter((i) => i.kind === "testing-claim")).toEqual(
			[],
		);
		expect(evidence.dropped.map((d) => d.reason)).toEqual([
			"claim-uncorroborated",
		]);
	});

	test("a check name quoted inside a longer command is not a check match", () => {
		// The check is named "test"; the line quotes `bun test some/file.ts`.
		// Matching on substrings would read that as the check having passed.
		const evidence = collectPullRequestEvidence({
			checks: [{ name: "test", status: "success", url: null }],
			diffPatch: SOURCE_ONLY_DIFF,
			body: "Tested with `bun test some/file.ts`",
			reviewDecision: null,
		});
		expect(evidence.machine.filter((i) => i.kind === "testing-claim")).toEqual(
			[],
		);
		expect(evidence.dropped.map((d) => d.reason)).toEqual([
			"claim-uncorroborated",
		]);
	});
});

describe("collectPullRequestEvidence — ambiguous claims", () => {
	test("a claim naming both a settled check and a changed file reports the check", () => {
		// Two readings are available. The check is the stronger fact — a
		// provider settled it — so it wins, deterministically, every run.
		const evidence = collectPullRequestEvidence({
			checks: [{ name: "typecheck", status: "failure", url: null }],
			diffPatch: SAMPLE_DIFF,
			body: "`typecheck` plus tests in `packages/shared/src/format-tokens.test.ts`",
			reviewDecision: null,
		});
		const claim = evidence.machine.find((i) => i.kind === "testing-claim");
		expect(claim?.status).toBe("failed");
		expect(claim?.detail).toBe(
			'Claim names check "typecheck", whose status is settled',
		);
	});

	test("a claim naming two changed files resolves to one of them, stably", () => {
		const body =
			"Tested `packages/shared/src/legacy-format.test.ts` and `packages/shared/src/format-tokens.test.ts`";
		const runs = [0, 1, 2].map(() =>
			collectPullRequestEvidence({
				checks: [],
				diffPatch: SAMPLE_DIFF,
				body,
				reviewDecision: null,
			}),
		);
		const refs = runs.map(
			(evidence) =>
				evidence.machine.find((i) => i.kind === "testing-claim")?.sourceRef,
		);
		expect(new Set(refs).size).toBe(1);
		expect(refs[0]).toBe("packages/shared/src/legacy-format.test.ts");
	});
});

describe("collectPullRequestEvidence — determinism and scope", () => {
	test("the same input produces byte-identical output every run", () => {
		const input = {
			checks: SAMPLE_CHECKS,
			diffPatch: SAMPLE_DIFF,
			body: "Tested via `packages/shared/src/format-tokens.test.ts` and `typecheck`",
			reviewDecision: "approved" as const,
		};
		const first = JSON.stringify(collectPullRequestEvidence(input));
		for (let run = 0; run < 5; run += 1) {
			expect(JSON.stringify(collectPullRequestEvidence(input))).toBe(first);
		}
	});

	test("nothing outside the four declared input fields is read or emitted", () => {
		// A caller handing over a wider object — a PR row carrying a token, an
		// agent transcript — must not leak through. The producer reads checks,
		// diffPatch, body and reviewDecision, and emits only what it derives
		// from those.
		const secret = "ghp_EXAMPLENOTAREALTOKEN0000000000000000";
		const evidence = collectPullRequestEvidence({
			checks: SAMPLE_CHECKS,
			diffPatch: SAMPLE_DIFF,
			body: "Tested via `packages/shared/src/format-tokens.test.ts`",
			reviewDecision: "approved",
			// Fields the contract does not declare.
			accessToken: secret,
			agentTranscript: `assistant: the key is ${secret}`,
		} as never);

		const serialized = JSON.stringify(evidence);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("agentTranscript");
		expect(serialized).not.toContain("accessToken");
	});

	test("a diff body carrying a secret contributes paths only, never content", () => {
		// Diff bodies are counted, not copied: only the header paths and the
		// +/- line counts reach the output.
		const secret = "AKIAEXAMPLENOTAREAL0";
		const patch = `diff --git a/src/config.test.ts b/src/config.test.ts
index 1111111..2222222 100644
--- a/src/config.test.ts
+++ b/src/config.test.ts
@@ -1,2 +1,2 @@
-const key = "old";
+const key = "${secret}";
`;
		const evidence = collectPullRequestEvidence({
			checks: [],
			diffPatch: patch,
			body: null,
			reviewDecision: null,
		});
		expect(evidence.machine.map((i) => i.label)).toEqual([
			"src/config.test.ts",
		]);
		expect(JSON.stringify(evidence)).not.toContain(secret);
	});
});
