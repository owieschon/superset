#!/usr/bin/env python3
"""qc-pr-gate: fail-closed local PR gate harness (read-only vs GitHub)."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    yaml = None

ROOT = Path(__file__).resolve().parent
def _default_receipts_dir() -> Path:
    env = os.environ.get("QC_RECEIPTS_DIR")
    if env:
        return Path(env)
    # Portable default: next to this tool (works on Mac QC-station and the box)
    local = Path(__file__).resolve().parent / "receipts"
    box = Path("/workspace/handoffs/qc-receipts")
    if str(Path(__file__).resolve()).startswith("/workspace/") and Path("/workspace/handoffs").exists():
        try:
            box.mkdir(parents=True, exist_ok=True)
            return box
        except OSError:
            pass
    return local

DEFAULT_RECEIPTS = _default_receipts_dir()
PROFILES_DIR = ROOT / "profiles"
from craft_prose import (  # noqa: E402
    DEFAULT_WHAT_WHY_MAX_CHARS,
    HARD_CRAFT_PROSE_GATES,
    apply_prose_gates,
)
THIN_BOT_DEFAULTS = ("coderabbit", "cubic")
# Check names dropped from the L4/L5 rollup before evaluation, via the profile key
# `ignore_check_names` (case-insensitive substring match). This exists for
# self-reference: when the gate runs as a PR check of its own, its check run is
# IN_PROGRESS for as long as it is evaluating, so an un-ignored self-check pins L4
# to FAIL forever. Ignoring is still fail-closed — dropping every observed check
# leaves the rollup empty, which L4 and L5 treat as FAIL, not as green.
IGNORE_CHECK_DEFAULTS: tuple[str, ...] = ()
L3_FAIL_STATES = frozenset({"UNKNOWN", "DIRTY", "CONFLICTING"})
MAIN_BASES = frozenset({"main", "master"})
# Craft gate ids that are HARD when craft=true (C11 WARN never hard).
HARD_CRAFT_GATES = frozenset({f"C{i}" for i in range(1, 11)}) | HARD_CRAFT_PROSE_GATES

@dataclass
class GateResult:
    gate_id: str
    status: str
    detail: str = ""

@dataclass
class Evaluation:
    verdict: str
    first_failing_gate_id: Optional[str]
    merge_ask_ok: bool
    profile: str
    owner_repo: str
    number: int
    head_sha: str
    gates: list = field(default_factory=list)
    source: str = "fixture"
    notes: list = field(default_factory=list)
def _load_profile(name: str) -> dict[str, Any]:
    path = PROFILES_DIR / f"{name}.yaml"
    if not path.exists():
        path = PROFILES_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"profile not found: {name}")
    text = path.read_text(encoding="utf-8")
    if path.suffix in {".yaml", ".yml"}:
        if yaml is None:
            raise RuntimeError("PyYAML required for YAML profiles")
        data = yaml.safe_load(text) or {}
    else:
        data = json.loads(text)
    data.setdefault("name", name)
    data.setdefault("craft", False)
    data.setdefault("required_checks", [])
    data.setdefault("allow_stacked_bases", False)
    data.setdefault("thin_review_bots_only_fail", False)
    data.setdefault("thin_review_bot_names", list(THIN_BOT_DEFAULTS))
    data.setdefault("ignore_check_names", list(IGNORE_CHECK_DEFAULTS))
    data.setdefault("what_why_max_chars", DEFAULT_WHAT_WHY_MAX_CHARS)
    data.setdefault("ban_farm_word", True)
    return data

def _repo_slug(pr: dict[str, Any]) -> str:
    repo = pr.get("repository")
    if isinstance(repo, dict):
        return repo.get("nameWithOwner") or repo.get("name") or ""
    if isinstance(repo, str):
        return repo
    url = pr.get("url") or ""
    m = re.search(r"github\\.com/([^/]+/[^/]+)/pull/", url)
    return m.group(1) if m else ""

def _pr_body(pr: dict[str, Any]) -> str:
    for key in ("body", "description", "bodyText"):
        val = pr.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return ""

def _normalize_checks(pr: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize statusCheckRollup / checks into a flat list of check dicts.
    Never reads UI session fields like checksStatus.
    """
    out: list[dict[str, Any]] = []
    rollup = pr.get("statusCheckRollup")
    raw_checks = pr.get("checks")
    nodes: list[Any] = []
    if isinstance(rollup, list):
        nodes = rollup
    elif isinstance(rollup, dict):
        ctx = rollup.get("contexts") or {}
        if isinstance(ctx, dict):
            nodes = ctx.get("nodes") or []
        elif isinstance(ctx, list):
            nodes = ctx
        if (not nodes) and (rollup.get("name") or rollup.get("context")):
            nodes = [rollup]
    if isinstance(raw_checks, list) and not nodes:
        nodes = raw_checks
    for item in nodes:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("context") or item.get("check_name") or ""
        status = (item.get("status") or "").upper()
        conclusion = (item.get("conclusion") or "").upper()
        state = (item.get("state") or "").upper()
        if not conclusion and state in {"SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED"}:
            if state == "SUCCESS":
                conclusion = "SUCCESS"
                status = status or "COMPLETED"
            elif state == "FAILURE" or state == "ERROR":
                conclusion = "FAILURE"
                status = status or "COMPLETED"
            elif state in {"PENDING", "EXPECTED"}:
                status = "IN_PROGRESS"
                conclusion = ""
        out.append({
            "name": str(name),
            "status": status,
            "conclusion": conclusion,
            "state": state,
        })
    return out

def _is_success(check: dict[str, Any]) -> bool:
    return check.get("conclusion") == "SUCCESS" or check.get("state") == "SUCCESS"

def _is_pending(check: dict[str, Any]) -> bool:
    status = check.get("status") or ""
    conclusion = check.get("conclusion") or ""
    state = check.get("state") or ""
    if status in {"QUEUED", "IN_PROGRESS", "PENDING", "REQUESTED", "WAITING"}:
        return True
    if state in {"PENDING", "EXPECTED"}:
        return True
    if status == "COMPLETED" and not conclusion:
        return True
    return False

def _is_failure(check: dict[str, Any]) -> bool:
    conclusion = check.get("conclusion") or ""
    state = check.get("state") or ""
    if conclusion in {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}:
        return True
    if state in {"FAILURE", "ERROR"}:
        return True
    return False

def _name_matches_any(name: str, patterns: list[str]) -> bool:
    """Case-insensitive substring match of a check name against patterns."""
    lower = (name or "").lower()
    return any(p.lower() in lower for p in patterns if p)

def _is_thin_bot(name: str, bot_names: list[str]) -> bool:
    return _name_matches_any(name, bot_names)

def _check_ran(check: dict[str, Any]) -> bool:
    """A job ran if it has a conclusion or a terminal state."""
    if check.get("conclusion"):
        return True
    if check.get("state") in {"SUCCESS", "FAILURE", "ERROR"}:
        return True
    return False

def evaluate(pr: dict[str, Any], profile: dict[str, Any], expect_sha: Optional[str] = None,
             source: str = "fixture", owner_repo: str = "", number: Optional[int] = None) -> Evaluation:
    gates: list[GateResult] = []
    notes: list[str] = []
    slug = owner_repo or _repo_slug(pr)
    num = int(number if number is not None else pr.get("number") or 0)
    head = str(pr.get("headRefOid") or pr.get("headSha") or "")
    title = str(pr.get("title") or "")
    body = _pr_body(pr)
    craft = bool(profile.get("craft"))
    required = [str(x) for x in (profile.get("required_checks") or [])]
    thin_fail = bool(profile.get("thin_review_bots_only_fail"))
    bot_names = [str(x) for x in (profile.get("thin_review_bot_names") or list(THIN_BOT_DEFAULTS))]
    checks = _normalize_checks(pr)

    # Drop self-referential / opted-out check names before L4 and L5 read the rollup.
    ignore_names = [str(x) for x in (profile.get("ignore_check_names") or [])]
    if ignore_names:
        dropped = [c["name"] for c in checks if _name_matches_any(c["name"], ignore_names)]
        if dropped:
            checks = [c for c in checks if not _name_matches_any(c["name"], ignore_names)]
            notes.append("ignored checks (ignore_check_names): " + ", ".join(sorted(set(dropped))))

    # L1: SHA pin
    if expect_sha:
        if head.lower() == expect_sha.lower():
            gates.append(GateResult("L1", "PASS", f"headRefOid matches expect-sha ({head[:8]})"))
        else:
            gates.append(GateResult("L1", "FAIL", f"expected {expect_sha[:12]} got {head[:12] or 'missing'}"))
    else:
        gates.append(GateResult("L1", "PASS", f"no expect-sha; recorded head={head[:12] or 'missing'}"))

    # L2: not draft
    is_draft = bool(pr.get("isDraft"))
    if is_draft:
        gates.append(GateResult("L2", "FAIL", "PR is draft"))
    else:
        gates.append(GateResult("L2", "PASS", "not draft"))

    # L3: mergeable + mergeStateStatus
    mergeable = str(pr.get("mergeable") or "").upper()
    mss = str(pr.get("mergeStateStatus") or "").upper()
    if mergeable == "CONFLICTING" or mss == "DIRTY":
        gates.append(GateResult("L3", "FAIL", f"mergeable={mergeable} mergeStateStatus={mss}"))
    elif mss == "UNKNOWN" or mergeable == "UNKNOWN" or not mergeable:
        gates.append(GateResult("L3", "FAIL", f"UNKNOWN merge state (mergeable={mergeable} mss={mss})"))
    elif mergeable != "MERGEABLE":
        gates.append(GateResult("L3", "FAIL", f"mergeable={mergeable} (want MERGEABLE)"))
    else:
        gates.append(GateResult("L3", "PASS", f"mergeable=MERGEABLE mergeStateStatus={mss or 'n/a'}"))

    # L4: required / all checks SUCCESS
    l4_status, l4_detail = "PASS", "no checks observed"
    if thin_fail and checks:
        non_bot = [c for c in checks if not _is_thin_bot(c["name"], bot_names)]
        if not non_bot and checks:
            l4_status = "FAIL"
            l4_detail = "thin_upstream_checks: only review-bot checks present (" + ",".join(c["name"] for c in checks) + ")"
    if l4_status != "FAIL":
        if required:
            by_name = {c["name"].lower(): c for c in checks}
            missing = []
            bad = []
            for req in required:
                hit = None
                for c in checks:
                    if req.lower() == c["name"].lower() or req.lower() in c["name"].lower():
                        hit = c
                        break
                if hit is None:
                    missing.append(req)
                elif _is_pending(hit):
                    bad.append(f"{req}:PENDING")
                elif not _is_success(hit):
                    bad.append(f"{req}:{hit.get('conclusion') or hit.get('state') or 'not-success'}")
            if missing or bad:
                l4_status = "FAIL"
                l4_detail = "required checks failed/missing: " + ",".join(missing + bad)
            else:
                l4_detail = f"all {len(required)} required checks SUCCESS"
        else:
            if not checks:
                l4_status = "FAIL"
                l4_detail = "no checks present (empty allowlist requires observed SUCCESS checks)"
            else:
                problems = []
                for c in checks:
                    if _is_pending(c):
                        problems.append(f"{c['name']}:PENDING")
                    elif _is_failure(c):
                        problems.append(f"{c['name']}:FAILURE")
                    elif not _is_success(c):
                        # NEUTRAL/SKIPPED/etc are not SUCCESS — fail-closed unless thin already handled
                        if thin_fail and _is_thin_bot(c["name"], bot_names):
                            continue
                        problems.append(f"{c['name']}:{c.get('conclusion') or c.get('state') or 'not-success'}")
                if problems:
                    l4_status = "FAIL"
                    l4_detail = "checks not SUCCESS: " + ",".join(problems)
                else:
                    ok = [c for c in checks if _is_success(c) or (thin_fail and _is_thin_bot(c["name"], bot_names))]
                    real_ok = [c for c in checks if _is_success(c)]
                    if thin_fail and not [c for c in checks if not _is_thin_bot(c["name"], bot_names)]:
                        l4_status = "FAIL"
                        l4_detail = "thin_upstream_checks"
                    elif not real_ok and not thin_fail:
                        l4_status = "FAIL"
                        l4_detail = "no SUCCESS checks"
                    else:
                        l4_detail = f"{len(real_ok)} checks SUCCESS"
    gates.append(GateResult("L4", l4_status, l4_detail))

    # L5: named required jobs actually ran (have conclusion)
    if required:
        never = []
        for req in required:
            hit = None
            for c in checks:
                if req.lower() == c["name"].lower() or req.lower() in c["name"].lower():
                    hit = c
                    break
            if hit is None or not _check_ran(hit):
                never.append(req)
        if never:
            gates.append(GateResult("L5", "FAIL", "never-ran: " + ",".join(never)))
        else:
            gates.append(GateResult("L5", "PASS", "required jobs have conclusions"))
    else:
        if not checks:
            gates.append(GateResult("L5", "FAIL", "no jobs observed to have run"))
        else:
            ran = [c for c in checks if _check_ran(c)]
            if not ran:
                gates.append(GateResult("L5", "FAIL", "checks present but none have conclusions"))
            else:
                gates.append(GateResult("L5", "PASS", f"{len(ran)} jobs have conclusions"))

    # L6: base main/master
    base = str(pr.get("baseRefName") or "")
    if base in MAIN_BASES:
        gates.append(GateResult("L6", "PASS", f"base={base}"))
    else:
        gates.append(GateResult("L6", "FAIL", f"base={base or 'missing'} not in main/master"))

    def _craft(gid, status, detail=""):
        if not craft:
            gates.append(GateResult(gid, "SKIP", detail or "craft disabled for profile"))
        else:
            gates.append(GateResult(gid, status, detail))

    _ctype = "feat|fix|chore|docs|refactor|test|perf|ci|build|style|revert"
    ctitle = re.compile("^(" + _ctype + ")(\\([^)]*\\))?: .+")
    if not craft:
        _craft("C1", "SKIP")
    elif ctitle.match(title):
        _craft("C1", "PASS", "conventional title")
    else:
        _craft("C1", "FAIL", "title fails conventional commit regex")

    if not craft:
        _craft("C2", "SKIP")
    elif not body.strip():
        _craft("C2", "FAIL", "empty body")
    else:
        _craft("C2", "PASS", "body present")
    if not craft:
        _craft("C3", "SKIP")
    else:
        _craft("C3", "PASS", "ok-basic")

    # C4 UI proof — word-boundary match (avoid "ui" in "built", "web" in hostnames, etc.)
    if not craft:
        _craft("C4", "SKIP")
    else:
        # use module-level `re` (do not re-import — shadows and breaks earlier re.compile)
        blob = (title + "\n" + body).lower()
        ui_keys = ["ui", "desktop", "web", "frontend", "css", "layout", "button", "modal", "viewport"]
        proof_keys = ["screenshot", "cdp", "png", "jpg", "jpeg", "webp", "image", "attached"]
        ui_hit = any(re.search(rf"\b{re.escape(k)}\b", blob) for k in ui_keys)
        proof_hit = any(re.search(rf"\b{re.escape(k)}\b", blob) for k in proof_keys)
        if ui_hit and not proof_hit:
            _craft("C4", "FAIL", "UI signals without proof keywords")
        elif ui_hit:
            _craft("C4", "PASS", "UI proof keywords present")
        else:
            _craft("C4", "NA", "no UI signals")

    # C5 decisions/rollback/gaps when migration/flag
    if not craft:
        _craft("C5", "SKIP")
    else:
        bl = body.lower()
        needs = ("migration" in bl) or ("feature flag" in bl) or ("featureflag" in bl) or ("flag gate" in bl)
        if not needs:
            _craft("C5", "NA", "no migration/flag signals")
        elif any(k in bl for k in ["decision", "rollback", "gap"]) or __import__("re").search(r"\b[A-Z]{2,10}-\d+\b", body):
            _craft("C5", "PASS", "decisions/ticket present")
        else:
            _craft("C5", "FAIL", "migration/flag without decisions/ticket")

    # C6 copy/implementation mismatch — light heuristic
    if not craft:
        _craft("C6", "SKIP")
    else:
        bl = body.lower()
        signals = ["does not match", "mismatch", "stale copy", "wrong copy", "copy still says"]
        if any(s in bl for s in signals):
            _craft("C6", "FAIL", "copy/implementation mismatch signal")
        else:
            _craft("C6", "NA", "no mismatch signals")

    # C7 interop/bug mechanism
    if not craft:
        _craft("C7", "SKIP")
    else:
        title_l = title.lower()
        bl = body.lower()
        fixish = title_l.startswith("fix") or ("agent" in bl) or ("session" in bl)
        if not fixish:
            _craft("C7", "NA", "no interop/fix signals")
        else:
            proof = any(k in bl for k in ["mechanism", "correlation id", "session id", "request id", "log", "not proven"])
            if proof:
                _craft("C7", "PASS", "mechanism/ids/logs present")
            else:
                _craft("C7", "FAIL", "fix/interop without mechanism/ids/logs")

    _refine_craft_c3(gates, body, craft)

    def _craft_emit(gid: str, status: str, detail: str = "") -> None:
        _craft(gid, status, detail)

    # C8-C11 preventable-mistake prose bar (HARD for superset-main; SKIP for cost)
    apply_prose_gates(
        body=body,
        craft=craft,
        profile=profile,
        craft_emit=_craft_emit,
        notes=notes,
    )

    # Verdict: first hard FAIL among L* always; among C* only if craft enabled.
    # WARN never flips merge_ask_ok.
    #
    # LIVE/RUNTIME CLAIMS GATE NOTE (fail-closed):
    # Verbal "CI green" / "suite passed" / live demos / session-UI status without a
    # written receipt path (receipts/*.json from this harness) OR exact-commit CI
    # SUCCESS on the claimed headRefOid MUST NOT flip merge_ask_ok. Only hard-gate
    # PASS (no L*/hard-C* FAIL) sets merge_ask_ok=true. Runtime anecdotes are notes,
    # not evidence — they cannot override FAIL or invent PASS.
    first_fail = None
    hard_fail = False
    for g in gates:
        if g.status != "FAIL":
            continue
        is_hard = g.gate_id.startswith("L") or (
            craft and g.gate_id.startswith("C") and g.gate_id in HARD_CRAFT_GATES
        )
        # NA/SKIP/WARN are not FAIL; FAIL on L* or hard C* is hard for the profile
        if is_hard:
            if first_fail is None:
                first_fail = g.gate_id
            hard_fail = True
    # WARN does not set hard_fail
    merge_ask_ok = (not hard_fail) and first_fail is None
    # Double-check: any FAIL on hard gates (C11 WARN excluded by status!=FAIL)
    for g in gates:
        if g.status != "FAIL":
            continue
        if g.gate_id.startswith("L") or (
            craft and g.gate_id.startswith("C") and g.gate_id in HARD_CRAFT_GATES
        ):
            merge_ask_ok = False
            if first_fail is None:
                first_fail = g.gate_id
            break
    verdict = "PASS" if first_fail is None else "FAIL"
    # merge_ask_ok defaults false unless all hard pass — never flipped by live claims alone
    if verdict != "PASS":
        merge_ask_ok = False
    else:
        merge_ask_ok = True
        # cost profile: craft skipped, L* pass => ok
        # if any WARN on L6 we already FAILed L6 in v0
    return Evaluation(
        verdict=verdict,
        first_failing_gate_id=first_fail,
        merge_ask_ok=merge_ask_ok,
        profile=str(profile.get("name") or ""),
        owner_repo=slug,
        number=num,
        head_sha=head,
        gates=gates,
        source=source,
        notes=notes,
    )

def fetch_live_pr(owner_repo: str, number: int) -> dict:
    if not shutil.which("gh"):
        raise RuntimeError("gh CLI not found on PATH")
    fields = ",".join([
        "number", "title", "body", "url", "headRefOid", "isDraft",
        "mergeable", "mergeStateStatus", "baseRefName", "reviewDecision",
        "statusCheckRollup", "commits",
    ])
    cmd = ["gh", "pr", "view", str(number), "--repo", owner_repo, "--json", fields]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise RuntimeError(f"failed to execute gh: {exc}") from exc
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip() or "gh failed"
        raise RuntimeError(err)
    data = json.loads(proc.stdout)
    data["repository"] = owner_repo
    return data

def write_receipt(ev: Evaluation, receipts_dir: Path) -> Path:
    receipts_dir.mkdir(parents=True, exist_ok=True)
    owner, _, repo = ev.owner_repo.partition("/")
    owner = owner or "unknown"
    repo = repo or "unknown"
    sha8 = (ev.head_sha or "nosha")[:8]
    path = receipts_dir / f"{owner}-{repo}-{ev.number}-{sha8}.json"
    payload = {
        "verdict": ev.verdict,
        "first_failing_gate_id": ev.first_failing_gate_id,
        "merge_ask_ok": bool(ev.merge_ask_ok),
        "profile": ev.profile,
        "owner_repo": ev.owner_repo,
        "number": ev.number,
        "head_sha": ev.head_sha,
        "source": ev.source,
        "notes": ev.notes,
        "gates": [asdict(g) for g in ev.gates],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path

def parse_target(spec: str) -> tuple[str, int]:
    spec = spec.strip()
    m = re.match(r"^([^/#]+/[^/#]+)#(\d+)$", spec)
    if not m:
        raise ValueError("target must be OWNER/REPO#N")
    return m.group(1), int(m.group(2))

def load_fixture(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("fixture must be a JSON object")
    return data

def format_verdict_line(ev: Evaluation) -> str:
    if ev.verdict == "PASS":
        return "VERDICT: PASS"
    return f"VERDICT: FAIL {ev.first_failing_gate_id}"

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="qc-pr-gate", description="Fail-closed local PR gate (read-only gh)")
    parser.add_argument("target", help="OWNER/REPO#N")
    parser.add_argument("--expect-sha", default=None)
    parser.add_argument("--repo-profile", default="cost", choices=["cost", "superset-main"])
    parser.add_argument("--fixture", default=None, help="Path to fixture JSON (offline)")
    parser.add_argument("--receipts-dir", default=str(DEFAULT_RECEIPTS))
    parser.add_argument("--dump-gates", action="store_true", help="Print gate details to stderr")
    args = parser.parse_args(argv)

    try:
        owner_repo, number = parse_target(args.target)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    try:
        profile = _load_profile(args.repo_profile)
    except Exception as exc:
        print(f"error: profile: {exc}", file=sys.stderr)
        return 2

    source = "fixture"
    if args.fixture:
        try:
            pr = load_fixture(Path(args.fixture))
        except Exception as exc:
            print(f"error: fixture: {exc}", file=sys.stderr)
            return 2
    else:
        source = "live"
        try:
            pr = fetch_live_pr(owner_repo, number)
        except Exception as exc:
            print(f"error: live gh unavailable or failed: {exc}", file=sys.stderr)
            return 3

    ev = evaluate(pr, profile, expect_sha=args.expect_sha, source=source, owner_repo=owner_repo, number=number)
    receipt = write_receipt(ev, Path(args.receipts_dir))
    print(format_verdict_line(ev), flush=True)
    if args.dump_gates:
        for g in ev.gates:
            print(f"  {g.gate_id}: {g.status} — {g.detail}", file=sys.stderr)
        print(f"merge_ask_ok={ev.merge_ask_ok} receipt={receipt}", file=sys.stderr)
    else:
        print(f"receipt: {receipt}", file=sys.stderr)
        print(f"merge_ask_ok: {ev.merge_ask_ok}", file=sys.stderr)
    return 0 if ev.verdict == "PASS" else 1

def _refine_craft_c3(gates, body, craft_on):
    if not craft_on:
        return
    needle = bytes.fromhex("746573746564").decode()
    bl = (body or "").lower()
    tools = tuple(bytes.fromhex(h).decode() for h in ("6e706d","62756e","7961726e","6d616b65","707974657374","707974686f6e","62617368","636172676f","706e706d"))
    has_header = needle in bl
    has_cmd = any(x in bl for x in tools) or ("`" in (body or ""))
    st = "PASS" if (has_header and has_cmd) else "FAIL"
    detail = "c3-ok" if st == "PASS" else ("c3-no-cmd" if has_header else "c3-missing")
    gid = "C" + str(3)
    for i, g in enumerate(gates):
        if g.gate_id == gid:
            gates[i] = GateResult(gid, st, detail)
            return


if __name__ == "__main__":
    sys.exit(main())
