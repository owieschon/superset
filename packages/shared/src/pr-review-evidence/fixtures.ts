/**
 * Synthetic pull-request inputs for the evidence producer's tests.
 *
 * These are hand-written rather than captured from a live PR: the producer is
 * deterministic, so its tests need inputs whose every field is deliberate.
 * Nothing here describes anyone's real pull request.
 */
import type { PullRequestCheck } from "./types";

/**
 * A diff touching one source file, one test file for it, and one deleted test
 * file — enough to exercise added / modified / deleted at once.
 */
export const SAMPLE_DIFF = `diff --git a/packages/shared/src/format-tokens.ts b/packages/shared/src/format-tokens.ts
index 1111111..2222222 100644
--- a/packages/shared/src/format-tokens.ts
+++ b/packages/shared/src/format-tokens.ts
@@ -1,4 +1,5 @@
 export function formatTokens(n: number) {
-	return String(n);
+	if (!Number.isFinite(n)) return "0";
+	return n.toLocaleString();
 }
diff --git a/packages/shared/src/format-tokens.test.ts b/packages/shared/src/format-tokens.test.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/packages/shared/src/format-tokens.test.ts
@@ -0,0 +1,4 @@
+import { expect, test } from "bun:test";
+test("formats", () => {
+	expect(1).toBe(1);
+});
diff --git a/packages/shared/src/legacy-format.test.ts b/packages/shared/src/legacy-format.test.ts
deleted file mode 100644
index 4444444..0000000
--- a/packages/shared/src/legacy-format.test.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-import { expect, test } from "bun:test";
-test("old", () => {});
-
`;

/** A diff with no test files in it at all. */
export const SOURCE_ONLY_DIFF = `diff --git a/packages/shared/src/constants.ts b/packages/shared/src/constants.ts
index 1111111..2222222 100644
--- a/packages/shared/src/constants.ts
+++ b/packages/shared/src/constants.ts
@@ -1,2 +1,2 @@
-export const LIMIT = 10;
+export const LIMIT = 20;
`;

export const SAMPLE_CHECKS: PullRequestCheck[] = [
	{
		name: "test",
		status: "completed",
		conclusion: "success",
		detailsUrl: "https://example.invalid/checks/1",
	},
	{ name: "typecheck", status: "completed", conclusion: "failure" },
	{ name: "e2e", status: "in_progress", conclusion: null },
];
