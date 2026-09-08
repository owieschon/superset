# qc-pr-gate

Fail-closed PR gate harness. **Read-only** against GitHub: it calls `gh pr view --json`
and nothing else. It never merges, never comments, and never writes to a repository.

This is a vendored copy. Upstream lives at `/Users/owieschon/QC-station/tools/qc-pr-gate/`.
It is vendored here so `.github/workflows/qc-pr-gate.yml` is self-contained and reviewable.

## What it is for

An advisory pre-ask self-check: what the gate says about a PR before asking anyone to
review it. It is not a merge gate. `merge_ask_ok` is not a merge criterion, the workflow
is never added to required status checks or a ruleset, and the verdict is not cited to
upstream reviewers.

## CLI

```
qc-pr-gate OWNER/REPO#N [--expect-sha SHA] [--repo-profile cost|superset-main]
                        [--fixture PATH] [--receipts-dir DIR] [--dump-gates]
```

- **Live mode** (default): `gh pr view --json ...`, so `gh` must be on `PATH` and
  authenticated. Exit 3 if `gh` is missing or the call fails.
- **Fixture mode**: `--fixture path.json` evaluates offline. This is what the tests use.
- Prints one line: `VERDICT: PASS` or `VERDICT: FAIL <gate_id>`.
- Writes a receipt to `<receipts-dir>/<owner>-<repo>-<n>-<sha8>.json`. The default is
  `receipts/` beside this tool; `QC_RECEIPTS_DIR` or `--receipts-dir` override it.
- Exit code: 0 on PASS, 1 on FAIL, 2 on bad arguments, 3 when live `gh` is unavailable.
- `merge_ask_ok` defaults **false**, and is true only when every hard gate passes.

The `qc-pr-gate` launcher uses `$QC_PYTHON` if set, then a local `.venv/bin/python`,
then the ambient `python3`. CI takes the first branch; QC-station takes the second.

## Profiles

| Profile | Craft C* | required_checks | Notes |
|---|---|---|---|
| `cost` | SKIP (still recorded) | `[]` = all observed checks must SUCCESS | L1–L6 hard |
| `superset-main` | hard | `[]` plus the thin-bot rule | CodeRabbit/cubic **alone** => L4 `thin_upstream_checks` |

The CI workflow runs `cost` only.

## Gates L1–L6 (hard in both profiles)

- **L1** `headRefOid` matches `--expect-sha` when given; the SHA is always recorded
- **L2** not a draft
- **L3** `mergeable == MERGEABLE`, and not UNKNOWN / DIRTY / CONFLICTING
- **L4** required checks SUCCESS (or all observed checks when the allowlist is empty);
  pending, failing, or missing is a FAIL
- **L5** named or observed jobs have conclusions — a job that never ran is not green
- **L6** base branch is `main` or `master`

It never trusts the native UI `checksStatus` field, only `statusCheckRollup`.

## Craft C1–C11

Hard for `superset-main`, SKIP for `cost` (recorded either way). C1 conventional title,
C2 non-empty body, C3 tested-section with named commands, C4 UI proof when there are UI
signals, C5 decisions or ticket when migration/flag, C6 mismatch red flags, C7 mechanism
or ids or logs for a fix, C8 required H2 headers, C9 banned `farm`/`factory` wording,
C10 What & why length. C11 (Claude/Codex without Cursor) is WARN, and a WARN never flips
`merge_ask_ok`.

## `ignore_check_names` (added for the CI workflow)

`profiles/cost.yaml` sets:

```yaml
ignore_check_names:
  - qc-pr-gate
```

Check names matching any entry (case-insensitive substring) are dropped from the rollup
before L4 and L5 read it. This exists for self-reference: the workflow runs the gate as a
PR check of its own, and that check run is `IN_PROGRESS` for as long as the gate is
evaluating, so an un-ignored self-check would pin L4 to FAIL on every run.

It stays fail-closed. Ignoring is subtraction only — it can hide the gate's own check, but
it cannot turn a failing check green, and dropping every observed check leaves the rollup
empty, which L4 and L5 both treat as FAIL. `tests/test_gate.py` covers all four cases.

## Tests

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest tests/ -v
```

The suite is fixture-driven and makes no network calls.

## Example

```bash
./qc-pr-gate superset-sh/superset#7252 --repo-profile cost \
  --fixture fixtures/superset-sh-superset-7252-dirty.json --dump-gates
```
