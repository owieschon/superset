# Receipt: disabled-hooks SUPERSET_HOME_DIR isolation

Tip: `2f484bc27d2af5782ebcbc4a3a69f8188f8f4a26`
Branch: `fix/agent-setup-disabled-hooks-home-isolation`
Upstream PR: superset-sh/superset#7276 (DRAFT)
Date: 2026-09-08

Scope: test isolation in `packages/agent-setup/src/disabled-agent-hooks.test.ts`.
No product code changed. Agent ids in the assertions (`claude`, `codex`) are the
per-agent hook-disable keys for Claude Code and the Codex CLI, not test fixtures.

## 1. Failure reproduced locally, deterministically

The CI failure is order-dependent: it needs `agent-wrappers.test.ts` to load
first so its unrestored `mock.module("./paths", ...)` is already in effect.
Bun's file order is not controllable from the CLI, so the same condition was
forced with a preload that installs the identical mock:

```
bun test --preload <paths-mock> src/disabled-agent-hooks.test.ts
```

| tree | result |
| --- | --- |
| pre-fix (`HEAD~1`) | **3 pass, 1 fail** — `treats a missing or corrupt file as nothing disabled`, expected `[]`, received `["claude", "codex"]` |
| post-fix (this tip) | **4 pass, 0 fail** |

Same assertion, same message as CI. Without the preload both trees pass, which
is exactly why the failure is intermittent rather than permanent.

## 2. Full package suite, local

```
bun test            # packages/agent-setup
279 pass, 0 fail, 1016 expect() calls, 14 files
bun run typecheck   # clean
bunx biome check    # clean
```

Green in both file orderings: default, and with the `./paths` mock installed
first.

## 3. Owned CI, fork mirror at this exact tip

Run: https://github.com/owieschon/superset/actions/runs/34176864239
Mirror PR: https://github.com/owieschon/superset/pull/23 (DRAFT)
Head SHA on that run: `2f484bc27d2af5782ebcbc4a3a69f8188f8f4a26`

**Test job: SUCCESS** —
https://github.com/owieschon/superset/actions/runs/34176864239/job/101907887679
All 14 steps green (Install dependencies -> Test -> Terminal node-tests), 4m05s.

Also green on the same run: Sherif, Lint, Vale prose lint, Version Sync,
Build CLI (darwin-arm64, linux-arm64, linux-x64).

Neon and translations jobs are the known upstream-secret allowlist and are not
the owned signal.


## Result

**Overall: PASS** — tip-native proof at `2f484bc27d2af5782ebcbc4a3a69f8188f8f4a26`. Stay DRAFT until Owen undraft.

## Status

Stays DRAFT. No undraft, no merge, until CoS gives undraft_ok.
