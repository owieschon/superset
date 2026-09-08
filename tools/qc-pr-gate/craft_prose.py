#!/usr/bin/env python3
"""Superset-main craft/prose preventable-mistake checks (C8-C11).

Hard FAILs (automatable) for profile craft=true:
  C8 missing ## What & why / ## How I tested it / ## Checklist headers
  C9 body contains whole word "farm" or "factory" (case-insensitive) — prefer "fleet" / workspaces / hosts (official lexicon)
  C10 What & why section longer than tunable max (~1200 chars) — FAIL concise

Soft:
  C11 Claude/Codex in agent-CLI context without Cursor — WARN (hard to detect cleanly)

Cost profile keeps craft=false so these are SKIP via caller.
"""
from __future__ import annotations

import re
from typing import Any, Callable

DEFAULT_WHAT_WHY_MAX_CHARS = 1200
HARD_CRAFT_PROSE_GATES = frozenset({"C8", "C9", "C10"})  # C11 is WARN-only

REQUIRED_SECTION_HEADERS = (
    ("What & why", re.compile(r"^##\s+What\s*&\s*why\s*$", re.IGNORECASE | re.MULTILINE)),
    ("How I tested it", re.compile(r"^##\s+How I tested it\s*$", re.IGNORECASE | re.MULTILINE)),
    ("Checklist", re.compile(r"^##\s+Checklist\s*$", re.IGNORECASE | re.MULTILINE)),
)
WHAT_WHY_HEADER_RE = re.compile(r"^##\s+What\s*&\s*why\s*$", re.IGNORECASE | re.MULTILINE)
NEXT_H2_RE = re.compile(r"^##\s+", re.MULTILINE)
BANNED_LEXICON_RE = re.compile(r"\b(farm|factory)\b", re.IGNORECASE)
AGENT_CLI_TOOL_RE = re.compile(r"\b(claude|codex)\b", re.IGNORECASE)
CURSOR_WORD_RE = re.compile(r"\bcursor\b", re.IGNORECASE)
AGENT_CLI_CTX_RE = re.compile(
    r"\b(agent|agents|cli|prompt|prompts|handoff|handoffs|session|sessions|terminal|harness)\b",
    re.IGNORECASE,
)


def section_after_header(body: str, header_re: re.Pattern) -> str:
    """Return body text after a ## header until the next ## heading (or EOF)."""
    m = header_re.search(body or "")
    if not m:
        return ""
    rest = (body or "")[m.end():]
    nxt = NEXT_H2_RE.search(rest)
    if nxt:
        rest = rest[: nxt.start()]
    return rest.strip()


def missing_required_headers(body: str) -> list[str]:
    missing: list[str] = []
    for label, cre in REQUIRED_SECTION_HEADERS:
        if not cre.search(body or ""):
            missing.append(label)
    return missing


def agent_cli_tool_warn(body: str) -> bool:
    """True when Claude/Codex appear in soft agent-CLI context without Cursor.

    Detection is heuristic (hard to do cleanly) — callers WARN, not FAIL.
    """
    blob = body or ""
    if not AGENT_CLI_TOOL_RE.search(blob):
        return False
    if CURSOR_WORD_RE.search(blob):
        return False
    return bool(AGENT_CLI_CTX_RE.search(blob))


def apply_prose_gates(
    *,
    body: str,
    craft: bool,
    profile: dict[str, Any],
    craft_emit: Callable[[str, str, str], None],
    notes: list[str],
) -> None:
    """Emit C8-C11 via craft_emit(gate_id, status, detail)."""
    if not craft:
        craft_emit("C8", "SKIP", "craft disabled for profile")
    else:
        missing = missing_required_headers(body)
        if missing:
            craft_emit("C8", "FAIL", "missing headers: " + ", ".join(missing))
        else:
            craft_emit("C8", "PASS", "required section headers present")

    ban_lex = bool(profile.get("ban_farm_word", True))  # legacy key; bans farm+factory
    if not craft:
        craft_emit("C9", "SKIP", "craft disabled for profile")
    elif ban_lex and BANNED_LEXICON_RE.search(body or ""):
        hit = BANNED_LEXICON_RE.search(body or "").group(0).lower()
        craft_emit(
            "C9",
            "FAIL",
            f'body contains "{hit}" (prefer "fleet" / workspaces / hosts; official lexicon)',
        )
    else:
        craft_emit("C9", "PASS", "no banned farm/factory wording")

    max_ww = int(profile.get("what_why_max_chars") or DEFAULT_WHAT_WHY_MAX_CHARS)
    if not craft:
        craft_emit("C10", "SKIP", "craft disabled for profile")
    else:
        ww = section_after_header(body, WHAT_WHY_HEADER_RE)
        if not ww and missing_required_headers(body):
            craft_emit("C10", "NA", "What & why section missing (see C8)")
        elif len(ww) > max_ww:
            craft_emit(
                "C10",
                "FAIL",
                f"What & why too long ({len(ww)}>{max_ww} chars); keep concise",
            )
        else:
            craft_emit("C10", "PASS", f"What & why length ok ({len(ww)}<={max_ww})")

    if not craft:
        craft_emit("C11", "SKIP", "craft disabled for profile")
    elif agent_cli_tool_warn(body):
        craft_emit(
            "C11",
            "WARN",
            "mentions Claude/Codex in agent-CLI context without Cursor "
            "(prefer inclusive tooling notes)",
        )
        notes.append("C11 WARN: Claude/Codex without Cursor in agent-CLI-ish body")
    else:
        craft_emit("C11", "PASS", "no Claude/Codex-without-Cursor agent-CLI warn")

