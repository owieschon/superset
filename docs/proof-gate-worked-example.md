# Proof gate worked example

Companion to [proof-gate-needs-review-receipt.md](./proof-gate-needs-review-receipt.md).

**Needs review** is not shipped. Tip-native proof means the artifact is pinned to the
exact commit SHA at the branch tip — not "CI was green earlier," not bot rollup alone.

## Worked pattern (desktop honesty brick)

Example: Failed OS notification copy must not read as Complete ([#6929](https://github.com/superset-sh/superset/issues/6929) / draft proof path).

Before treating that change as ready for review to merge:

1. Record the tip SHA under test.
2. Run the focused unit at that tip (or cite fork Actions **Test** at the same SHA).
3. Keep a receipt that names the tip, the unit or CI URL, and **Overall: PASS**.
4. Cite `RECEIPT_PATH` and the fork tip-match Actions run URL in the PR body under
   **How I tested it**.
5. Stay draft until that proof exists — board **Needs review** does not waive it.

## What this is not

- Not a new board column.
- Not a second `agentStatus` source of truth (leave Todd's CLI/SDK work alone).
- Not a substitute for maintainer review — only the bar before calling work shipped.
