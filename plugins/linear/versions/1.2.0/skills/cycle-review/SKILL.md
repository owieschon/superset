---
name: cycle-review
description: Review a Linear cycle — what shipped, what slipped, and what should carry over. Use when a cycle or sprint is ending, someone asks what got done this cycle, why work slipped, what to pull into the next one, or wants a summary to share with the team.
argument-hint: team key or cycle number, or nothing for the active cycle
allowed-tools: mcp__linear__*
---

# Review a cycle

The output is a short account someone can act on in planning: **what shipped, what did not,
and what that says about the next cycle.** A list of issue titles grouped by status is a
report the tool already generates.

## 1. Fix the scope before reading anything

Resolve the team, then the cycle. With no cycle given, take the active one; a review run
mid-cycle is a forecast, not a retrospective, and should say so in its first line.

Pull the issues in that cycle once and work from that set. Re-querying per status invites
a miscount when something moves between calls.

## 2. Separate the three ways work leaves a cycle

Completed, still open, and removed are not the same story, and the third is the one people
forget to look at.

| Outcome | What it means | What to say |
| --- | --- | --- |
| **Completed** | Done inside the cycle | Group by project or theme, not by assignee |
| **Carried** | Still open at the end | Why — blocked, underestimated, or descoped |
| **Added mid-cycle** | Created after the cycle started | The interrupt load; the real planning signal |
| **Removed** | Moved out before the end | Who decided, and whether it went anywhere |

Added-mid-cycle is the number that explains a missed cycle better than any velocity figure.
If a third of the work was not planned, the estimate was not wrong — the cycle was.

## 3. Ask why for each carried issue

Read the issue's comments and its state history, not just its current status. The useful
answer is one of: blocked on someone outside the team, larger than it looked, started too
late, or never started. Those have different fixes and only the last one is a planning
problem.

An issue carried across three cycles is not carried, it is unowned. Say that.

## 4. Do not compute velocity and stop

Estimate totals are the easiest thing to report and the least useful. They compare cleanly
only when scope, estimation habits, and team size all held constant, which is rarely true.
If you cite a number, cite what changed alongside it.

## 5. Report

In this order: the cycle and its dates, what shipped grouped by theme, what carried with a
one-line reason each, the interrupt load, and one recommendation for the next cycle. Link
issues by identifier so people can open what they care about.

Keep it to something readable in a standup. A review nobody finishes is a review nobody
acts on.

## Anti-patterns

- Grouping the summary by assignee. It reads as a performance review and hides the themes.
- Reporting "80% complete" without saying what the 20% was. The tail is the interesting part.
- Treating an empty comment thread as evidence work went smoothly. It usually means the
  work happened somewhere else, and that context is what the next cycle needs.
