# PR review brief

Read-only, deterministic collection of public GitHub pull-request records.

```sh
bun scripts/pr-review-brief/cli.ts https://github.com/OWNER/REPO/pull/NUMBER
bun scripts/pr-review-brief/cli.ts --json https://github.com/OWNER/REPO/pull/NUMBER
```

The command uses `gh api` with fixed GET argument arrays. It rejects non-canonical URLs and private repositories, never invokes a model, and never writes to GitHub. It records the collected base/head revision, source availability, checks and commit statuses for that head, and review commit IDs. A failed or bounded source makes the output incomplete and exits with code 2; a head that changes while collecting fails without a brief.

Changed test files only show that files changed. The pull-request body is quoted as untrusted author-provided source, including claims that tests or manual work were not run.
