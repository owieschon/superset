# PR review brief

This narrow CLI produces a read-only, deterministic record of a public GitHub pull request for review context, not a readiness decision.

Run it with a canonical public pull-request URL:

```sh
bun scripts/pr-review-brief/cli.ts https://github.com/OWNER/REPO/pull/NUMBER
bun scripts/pr-review-brief/cli.ts --full https://github.com/OWNER/REPO/pull/NUMBER
bun scripts/pr-review-brief/cli.ts --json https://github.com/OWNER/REPO/pull/NUMBER
```

The default is a compact developer review note: it links the PR, diff, and collected head once; records collection time, changed-file/test-path counts, raw check-run and commit-status counts, review history, source gaps, and up to three unverified negative validation excerpts from the PR description. Displayed attention and history records are bounded with a visible `N more` source link. `--full` retains the complete Markdown record, including the author body; `--json` retains the collected JSON schema. `--full` and `--json` are mutually exclusive; `--help` shows usage.

The command uses `gh api` with fixed GET argument arrays. It rejects non-canonical URLs and private repositories, never invokes a model, and never writes to GitHub. It records the collected base/head revision, source availability, check runs using GitHub's explicit `filter=latest` scope (not older attempts), commit-status history records with timestamps, and formal-review actor login/type and commit IDs. A failed or bounded source makes the output incomplete and exits with code 2; a head or base that changes while collecting fails without a brief.

The note is not a readiness decision. Check-run success records are not described as CI passing, because those sources can include review bots. Commit statuses and formal reviews are history, not current CI or approval decisions. Validation excerpts are quotes rather than conclusions; fenced code and auto-generated bot-summary sections are skipped, and the absence of an excerpt does not mean tests are absent. Issue conversation comments, inline review comments, older check-run attempts, merge-result checks, and test logs are not collected or inspected. Changed test files only show that files changed; the test-path detector selectively reuses the exact patterns from `origin/feature/native-review-evidence`'s `parse-pr-diff.ts`, without importing that evidence system.
