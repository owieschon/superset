#!/usr/bin/env python3
"""Fixture-driven tests for qc-pr-gate (no network)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from qc_pr_gate import evaluate, _load_profile, format_verdict_line, write_receipt  # noqa: E402

FIXTURES = ROOT / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _gate(ev, gid: str):
    return next(g for g in ev.gates if g.gate_id == gid)


GOOD_BODY = """## What & why

Preserve Cursor identity through tool execution.

## How I tested it

- `bun test` in packages/agent-setup
- bun run typecheck

Mechanism: hook rewrite; session ids logged.

## Checklist

- [x] conventional title
- [x] lint/typecheck
"""


def _craft_base_pr(**overrides) -> dict:
    """Minimal PR that passes L* with a real SUCCESS check (not thin-bot-only)."""
    pr = {
        "number": 9001,
        "title": "fix(agent-setup): preserve Cursor identity through tool execution",
        "body": GOOD_BODY,
        "baseRefName": "main",
        "headRefOid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "isDraft": False,
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "CLEAN",
        "repository": "superset-sh/superset",
        "statusCheckRollup": [
            {
                "name": "CI",
                "status": "COMPLETED",
                "conclusion": "SUCCESS",
            }
        ],
    }
    pr.update(overrides)
    return pr


def test_7252_dirty_fails_l3_cost():
    pr = _load("superset-sh-superset-7252-dirty.json")
    profile = _load_profile("cost")
    ev = evaluate(pr, profile, owner_repo="superset-sh/superset", number=7252)
    assert ev.verdict == "FAIL"
    assert ev.first_failing_gate_id == "L3"
    assert ev.merge_ask_ok is False
    assert format_verdict_line(ev) == "VERDICT: FAIL L3"
    l3 = next(g for g in ev.gates if g.gate_id == "L3")
    assert "DIRTY" in l3.detail or "CONFLICTING" in l3.detail
    assert all(g.status == "SKIP" for g in ev.gates if g.gate_id.startswith("C"))


def test_7255_blocked_fails_l4_thin_superset():
    pr = _load("superset-sh-superset-7255-blocked.json")
    profile = _load_profile("superset-main")
    ev = evaluate(pr, profile, owner_repo="superset-sh/superset", number=7255)
    assert ev.verdict == "FAIL"
    assert ev.first_failing_gate_id == "L4"
    assert ev.merge_ask_ok is False
    l4 = next(g for g in ev.gates if g.gate_id == "L4")
    assert "thin_upstream_checks" in l4.detail


def test_gonogo_6_success_cost_merge_ask_ok():
    pr = _load("owieschon-gonogo-6-success.json")
    profile = _load_profile("cost")
    sha = pr["headRefOid"]
    ev = evaluate(pr, profile, expect_sha=sha, owner_repo="owieschon/gonogo", number=6)
    assert ev.verdict == "PASS"
    assert ev.first_failing_gate_id is None
    assert ev.merge_ask_ok is True
    assert format_verdict_line(ev) == "VERDICT: PASS"
    for gid in ("L1", "L2", "L3", "L4", "L5", "L6"):
        g = next(x for x in ev.gates if x.gate_id == gid)
        assert g.status == "PASS", gid


def test_l1_expect_sha_mismatch():
    pr = _load("owieschon-gonogo-6-success.json")
    profile = _load_profile("cost")
    ev = evaluate(pr, profile, expect_sha="deadbeef" * 5, owner_repo="owieschon/gonogo", number=6)
    assert ev.verdict == "FAIL"
    assert ev.first_failing_gate_id == "L1"
    assert ev.merge_ask_ok is False


def test_merge_ask_ok_defaults_false_on_fail():
    pr = _load("superset-sh-superset-7252-dirty.json")
    ev = evaluate(pr, _load_profile("cost"), owner_repo="superset-sh/superset", number=7252)
    assert ev.merge_ask_ok is False


def test_receipt_roundtrip(tmp_path):
    pr = _load("owieschon-gonogo-6-success.json")
    ev = evaluate(pr, _load_profile("cost"), owner_repo="owieschon/gonogo", number=6)
    path = write_receipt(ev, tmp_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["merge_ask_ok"] is True
    assert data["verdict"] == "PASS"
    assert "gates" in data


def test_superset_craft_ok_passes():
    pr = _craft_base_pr()
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert ev.verdict == "PASS", [(g.gate_id, g.status, g.detail) for g in ev.gates if g.status == "FAIL"]
    assert ev.merge_ask_ok is True
    for gid in ("C8", "C9", "C10"):
        assert _gate(ev, gid).status == "PASS", gid
    assert _gate(ev, "C11").status == "PASS"


def test_c8_missing_headers_hard_fail():
    # Include mechanism keywords so C7 does not preempt C8.
    body = "No template headers here.\n\nI tested with bun test.\nMechanism: session id logged.\n"
    pr = _craft_base_pr(body=body)
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert ev.verdict == "FAIL"
    assert ev.merge_ask_ok is False
    c8 = _gate(ev, "C8")
    assert c8.status == "FAIL"
    assert "What & why" in c8.detail
    assert "How I tested it" in c8.detail
    assert "Checklist" in c8.detail
    assert _gate(ev, "C7").status == "PASS"
    # First hard craft fail after L* should be C8 (L* pass)
    assert ev.first_failing_gate_id == "C8"


def test_c8_partial_headers_hard_fail():
    body = "## What & why\n\nStuff.\n\n## How I tested it\n\n- bun test\n\nMechanism: session id.\n"
    # missing Checklist
    pr = _craft_base_pr(body=body)
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert _gate(ev, "C8").status == "FAIL"
    assert "Checklist" in _gate(ev, "C8").detail
    assert ev.merge_ask_ok is False


def test_c9_farm_word_hard_fail():
    body = GOOD_BODY.replace("Preserve Cursor identity", "Tune the agent farm throughput")
    pr = _craft_base_pr(body=body)
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert _gate(ev, "C9").status == "FAIL"
    assert "farm" in _gate(ev, "C9").detail.lower()
    assert ev.verdict == "FAIL"
    assert ev.merge_ask_ok is False
    assert ev.first_failing_gate_id == "C9"


def test_c9_factory_word_hard_fail():
    body = GOOD_BODY.replace("Preserve Cursor identity", "Tune the software factory throughput")
    pr = _craft_base_pr(body=body)
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert _gate(ev, "C9").status == "FAIL"
    assert "factory" in _gate(ev, "C9").detail.lower()
    assert ev.merge_ask_ok is False


def test_c9_fleet_ok():
    body = GOOD_BODY.replace("Preserve Cursor identity", "Tune fleet script throughput")
    pr = _craft_base_pr(body=body)
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert _gate(ev, "C9").status == "PASS"
    assert ev.merge_ask_ok is True


def test_c10_long_what_why_hard_fail():
    long_ww = "x" * 1201
    body = (
        "## What & why\n\n"
        + long_ww
        + "\n\n## How I tested it\n\n- `bun test`\n\n"
        "Mechanism: session id logged.\n\n## Checklist\n\n- [x] ok\n"
    )
    pr = _craft_base_pr(body=body)
    profile = _load_profile("superset-main")
    assert int(profile["what_why_max_chars"]) == 1200
    ev = evaluate(pr, profile, owner_repo="superset-sh/superset", number=9001)
    c10 = _gate(ev, "C10")
    assert c10.status == "FAIL"
    assert "too long" in c10.detail
    assert ev.merge_ask_ok is False
    assert _gate(ev, "C7").status == "PASS"
    assert ev.first_failing_gate_id == "C10"


def test_c10_tunable_max_chars():
    body = (
        "## What & why\n\n"
        + ("y" * 50)
        + "\n\n## How I tested it\n\n- `bun test`\n\n"
        "Mechanism: session id.\n\n## Checklist\n\n- [x] ok\n"
    )
    pr = _craft_base_pr(body=body)
    profile = _load_profile("superset-main")
    profile["what_why_max_chars"] = 40
    ev = evaluate(pr, profile, owner_repo="superset-sh/superset", number=9001)
    assert _gate(ev, "C10").status == "FAIL"
    assert ev.merge_ask_ok is False


def test_c11_claude_without_cursor_warns_not_hard():
    body = GOOD_BODY.replace("Cursor identity", "Claude agent session identity")
    # remove any remaining Cursor mentions
    body = body.replace("Cursor", "tool")
    assert "cursor" not in body.lower()
    assert "claude" in body.lower()
    pr = _craft_base_pr(body=body, title="fix(agent-setup): preserve agent session identity")
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    c11 = _gate(ev, "C11")
    assert c11.status == "WARN"
    # WARN must not flip merge_ask_ok by itself when other hard gates pass
    assert ev.verdict == "PASS"
    assert ev.merge_ask_ok is True
    assert any("C11" in n for n in ev.notes)


def test_cost_skips_new_craft_gates():
    pr = _craft_base_pr(body="farm and Claude agent with no headers")
    ev = evaluate(pr, _load_profile("cost"), owner_repo="superset-sh/superset", number=9001)
    for gid in ("C8", "C9", "C10", "C11"):
        assert _gate(ev, gid).status == "SKIP"
    assert ev.verdict == "PASS"
    assert ev.merge_ask_ok is True


def test_thin_bots_alone_still_l4_with_craft_headers():
    """CodeRabbit/cubic alone remains L4 thin even when craft headers are perfect."""
    pr = _craft_base_pr(
        statusCheckRollup=[
            {"name": "cubic · AI code reviewer", "status": "COMPLETED", "conclusion": "NEUTRAL"},
            {"context": "CodeRabbit", "state": "SUCCESS"},
        ]
    )
    # normalize uses name or context
    pr["statusCheckRollup"] = [
        {"name": "cubic · AI code reviewer", "status": "COMPLETED", "conclusion": "NEUTRAL"},
        {"name": "CodeRabbit", "status": "COMPLETED", "conclusion": "SUCCESS"},
    ]
    ev = evaluate(pr, _load_profile("superset-main"), owner_repo="superset-sh/superset", number=9001)
    assert ev.first_failing_gate_id == "L4"
    assert "thin_upstream_checks" in _gate(ev, "L4").detail
    assert ev.merge_ask_ok is False


SELF_CHECK = {"name": "qc-pr-gate (advisory)", "status": "IN_PROGRESS", "conclusion": ""}


def test_ignore_check_names_drops_own_check():
    """The gate's own advisory check must not hold L4 down while it evaluates."""
    pr = _craft_base_pr(
        statusCheckRollup=[
            {"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"},
            dict(SELF_CHECK),
        ]
    )
    ev = evaluate(pr, _load_profile("cost"), owner_repo="owieschon/superset", number=9001)
    assert _gate(ev, "L4").status == "PASS", _gate(ev, "L4").detail
    assert _gate(ev, "L5").status == "PASS"
    assert ev.verdict == "PASS"
    assert ev.merge_ask_ok is True
    assert any("qc-pr-gate (advisory)" in n for n in ev.notes)


def test_without_ignore_list_own_check_fails_l4():
    """Control for the test above: the ignore list is what keeps L4 reachable."""
    profile = _load_profile("cost")
    profile["ignore_check_names"] = []
    pr = _craft_base_pr(
        statusCheckRollup=[
            {"name": "CI", "status": "COMPLETED", "conclusion": "SUCCESS"},
            dict(SELF_CHECK),
        ]
    )
    ev = evaluate(pr, profile, owner_repo="owieschon/superset", number=9001)
    assert _gate(ev, "L4").status == "FAIL"
    assert "qc-pr-gate (advisory):PENDING" in _gate(ev, "L4").detail
    assert ev.merge_ask_ok is False


def test_ignoring_every_check_is_fail_closed():
    """Ignoring the whole rollup must not manufacture a PASS."""
    pr = _craft_base_pr(statusCheckRollup=[dict(SELF_CHECK)])
    ev = evaluate(pr, _load_profile("cost"), owner_repo="owieschon/superset", number=9001)
    assert _gate(ev, "L4").status == "FAIL"
    assert _gate(ev, "L5").status == "FAIL"
    assert ev.first_failing_gate_id == "L4"
    assert ev.merge_ask_ok is False


def test_ignore_list_does_not_mask_a_real_failure():
    """A non-matching failing check still fails L4 with the ignore list active."""
    pr = _craft_base_pr(
        statusCheckRollup=[
            {"name": "CI", "status": "COMPLETED", "conclusion": "FAILURE"},
            dict(SELF_CHECK),
        ]
    )
    ev = evaluate(pr, _load_profile("cost"), owner_repo="owieschon/superset", number=9001)
    assert _gate(ev, "L4").status == "FAIL"
    assert "CI:FAILURE" in _gate(ev, "L4").detail
    assert ev.merge_ask_ok is False


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-v"]))
