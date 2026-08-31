---
name: duplicate-sweep
description: Find and merge duplicate Linear issues — group reports of the same underlying bug, pick the survivor, and move the evidence across. Use when the backlog has grown noisy, someone asks whether an issue is already reported, or you are cleaning up before planning.
argument-hint: team key, or a single issue to check for duplicates
allowed-tools: mcp__linear__*
---

# Sweep duplicates

Two issues for one bug means two people investigate it and neither sees the other's findings.
The goal is one issue per underlying problem, holding everything anyone learned.

## 1. Search the way reporters write, not the way you think

The same bug gets filed as "export is broken", "CSV download 500s", and "can't get my data
out". No shared vocabulary. Run several searches — the error string, the feature name, the
user-facing verb — and pool the results rather than trusting one query.

Include closed issues. A closed duplicate means the bug came back, which is a regression and
a more urgent report than a new one.

## 2. Same symptom is not the same bug

Group only when the underlying cause is plausibly identical. Two issues that both say
"page is slow" are the same report only if they are slow for the same reason; merging them
buries whichever one nobody reproduced.

When you are unsure, link them as related and say why rather than merging. An incorrect merge
loses an issue silently, and nobody goes looking for what they think is already tracked.

## 3. Pick the survivor deliberately

Not simply the oldest. Prefer the one with the best reproduction, then the most discussion,
then the earliest. If the oldest is a one-line report and a later one has steps, logs, and
three participants, the later one survives.

## 4. Move what matters before closing

Anything only present on the duplicate — reproduction steps, a customer name, a log line, a
subscriber who wants to know when it is fixed — goes onto the survivor first. Then close the
duplicate with a comment pointing at it, so someone arriving from a search or an old link
lands somewhere useful.

Never delete. A closed issue with a pointer is how the next person's search finds the survivor.

## 5. Report

List each group: the survivor, what was merged into it, and what you moved across. Flag the
pairs you deliberately did not merge and why — those are the judgment calls someone may want
to overturn.

## Anti-patterns

- Merging by title similarity alone. Titles are the least reliable signal in a backlog.
- Closing the duplicate first and copying the details afterwards. Interrupted halfway, the
  evidence is gone from anywhere anyone will look.
- Sweeping silently. If someone is subscribed to an issue you closed, tell them where it went.
