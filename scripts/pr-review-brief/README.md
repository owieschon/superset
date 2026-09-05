# PR review brief

This narrow CLI produces a read-only, deterministic record of a public GitHub pull request for review context, not a readiness decision.

Run it with a canonical public pull-request URL:

```sh
bun scripts/pr-review-brief/cli.ts https://github.com/OWNER/REPO/pull/NUMBER
bun scripts/pr-review-brief/cli.ts --json https://github.com/OWNER/REPO/pull/NUMBER
```

The command uses `gh api` with fixed GET argument arrays. It rejects non-canonical URLs and private repositories, never invokes a model, and never writes to GitHub. It records the collected base/head revision, source availability, check runs using GitHub's explicit `filter=latest` scope (not older attempts), commit-status history records with timestamps, and formal-review actor login/type and commit IDs. A failed or bounded source makes the output incomplete and exits with code 2; a head or base that changes while collecting fails without a brief.

Issue conversation comments and inline review comments are not collected, so maintainer QA reported there is absent. Changed test files only show that files changed; the test-path detector selectively reuses the exact patterns from `origin/feature/native-review-evidence`'s `parse-pr-diff.ts`, without importing that evidence system. The pull-request body is quoted as untrusted author-provided source, including claims that tests or manual work were not run. Check/status states, historical review records, and missing or mismatched check-run head SHAs are recorded without an inferred verdict.
