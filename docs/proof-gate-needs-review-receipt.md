# Proof gate: "Needs review" is not shipped

> Draft. This is an operator-trust rule, not product code. It is not implemented and not merged.

## What

A workspace in the **Needs review** board column is not done.

The app puts a workspace there when an agent's **Stop** event lands and its pull
request is open, draft, or queued (see `deriveBoardColumn.ts`). The Stop only
proves the agent finished. Nothing in that column proves the code is safe to ship.

Before I treat a Needs-review workspace as shipped, I require a tip-native proof
artifact. Tip-native means the pipeline produced it and it is pinned to the exact
commit at the branch tip, by full SHA. The artifact is one of two things: check
runs that CI actually ran against that SHA (for example `gh checks <sha>`, all
green), or a receipt that names the SHA.

## Why

The stakes are first-person. I am the operator who merges. If I read "Needs
review" as "ready", I ship whatever the agent left — maybe failing CI, maybe a
commit I never actually verified. A bot saying "looks good" is an opinion, not
proof. A check run pinned to a concrete SHA is proof, because I can read it back
and pin it to the same commit I will merge.

## The rule

Needs review means "needs review", always. It does not mean "ready".

- No proof, no ship. Without a check run or receipt pinned to the tip SHA, the
  workspace stays in Needs review.
- Bot QC alone is not proof.
- This rule adds no board column. It uses the columns that already exist: Needs
  review, Needs attention, Merged, Deleted.

## Not in scope

- Nothing here changes `agentStatus` (idle, working, permission, review, failed).
  That stays the single source of truth for agent state and lives in its own
  work (#7007). This rule only constrains how I act on it.
- No new columns, no hook changes, no product code.