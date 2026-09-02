import { parsePullRequestDiff } from "./parse-pr-diff";
import { extractTestingClaims, matchChangedFile } from "./testing-claims";
import type {
	ChangedFile,
	CheckStatus,
	DroppedInput,
	EvidenceStatus,
	PullRequestCheck,
	PullRequestEvidence,
	PullRequestEvidenceInput,
	PullRequestEvidenceItem,
	ReviewDecision,
} from "./types";

/**
 * What each normalized check status settles, or `null` for the ones that
 * settle nothing.
 *
 * "pending" and "cancelled" produce no verdict: a cancelled run was stopped
 * before it judged anything, so reporting it as evidence either way would be
 * an invention. Both are dropped instead.
 *
 * This deliberately answers a different question from `computeChecksStatus`,
 * which folds "cancelled" into failure because it is deciding whether the
 * pull request's check gate is red. Nothing here computes an overall status;
 * that gate stays the one place a verdict is formed.
 */
const CHECK_STATUS_EVIDENCE: Record<CheckStatus, EvidenceStatus | null> = {
	success: "satisfied",
	failure: "failed",
	skipped: "neutral",
	pending: null,
	cancelled: null,
};

const CHANGE_VERB: Record<ChangedFile["changeType"], string> = {
	added: "added",
	modified: "modified",
	deleted: "deleted",
	renamed: "renamed",
};

/**
 * Turns the data Superset already holds for one pull request — its check runs,
 * its diff, its description and its review decision — into settled evidence.
 *
 * Three rules hold everywhere in here:
 *
 * 1. Only settled facts become evidence. A check still running, a description
 *    line naming a file nobody touched, a status the provider never settled:
 *    each lands in `dropped` with a reason instead of being guessed at.
 * 2. Human confirmation and machine-read facts stay in separate lists. A
 *    reviewer's approval is a person's decision, and it is never merged into,
 *    or averaged with, what the providers report.
 * 3. Nothing here evaluates the code. There are no defect claims, no scores,
 *    and no judgment of whether the description is truthful — only whether a
 *    named file or check can be found in this pull request's own data.
 *
 * Ordering is positional and total: checks in the order the provider listed
 * them, then changed test files in diff order, then claims in description
 * order, so the same input always serializes byte-identically.
 *
 * Cost is one pass over the patch plus, for each testing claim, a scan of the
 * settled checks and the changed files: O(P + C + F + K·(S·N + T·F)) for P
 * patch lines, C checks, F changed files and K claims naming S code spans and
 * T path tokens each. The K·T·F term dominates on a large diff, and only
 * uncorroborated claims pay it in full. Measured on this implementation: 5,000
 * changed files across 225,000 patch lines with 100 claims, none of which
 * match, completes in ~50ms — so a diff far past the point where a provider
 * would truncate it still costs well under a frame budget.
 */
export function collectPullRequestEvidence(
	input: PullRequestEvidenceInput,
): PullRequestEvidence {
	const machine: PullRequestEvidenceItem[] = [];
	const human: PullRequestEvidenceItem[] = [];
	const dropped: DroppedInput[] = [];

	const settledChecks = collectChecks(input.checks, machine, dropped);
	const files = parsePullRequestDiff(input.diffPatch);
	collectTestFiles(files, machine);
	collectClaims(input.body, files, settledChecks, machine, dropped);
	collectReviewDecision(input.reviewDecision, human);

	return { machine, human, dropped };
}

interface SettledCheck {
	name: string;
	status: EvidenceStatus;
}

function collectChecks(
	checks: readonly PullRequestCheck[],
	machine: PullRequestEvidenceItem[],
	dropped: DroppedInput[],
): SettledCheck[] {
	const settled: SettledCheck[] = [];
	const seenNames = new Map<string, number>();

	for (const check of checks) {
		const name = typeof check?.name === "string" ? check.name.trim() : "";
		if (!name) {
			dropped.push({
				reason: "check-invalid",
				detail: "Check has no usable name",
			});
			continue;
		}

		// `parseChecksJson` rebuilds cached checks from a database column and
		// only asserts that `status` is a string, so an unrecognized value is
		// reachable here and is dropped rather than mapped to a default.
		if (!(check.status in CHECK_STATUS_EVIDENCE)) {
			dropped.push({
				reason: "check-invalid",
				detail: `Check "${name}" reported an unrecognized status: ${formatValue(check.status)}`,
			});
			continue;
		}

		const status = CHECK_STATUS_EVIDENCE[check.status];
		if (status === null) {
			dropped.push({
				reason: "check-unsettled",
				detail: `Check "${name}" has not produced a verdict (status: ${check.status})`,
			});
			continue;
		}

		// The live path dedupes matrix jobs by recency, but the cached
		// `checksJson` path does not, so a repeated name is still reachable.
		// The suffix keeps ids unique without renaming the first occurrence.
		const seen = seenNames.get(name) ?? 0;
		seenNames.set(name, seen + 1);

		machine.push({
			id:
				seen === 0
					? `machine:check:${name}`
					: `machine:check:${name}#${seen + 1}`,
			kind: "check",
			confirmation: "machine",
			status,
			label: name,
			detail: `Check status: ${check.status}`,
			sourceRef: check.url ?? undefined,
		});
		settled.push({ name, status });
	}

	return settled;
}

function collectTestFiles(
	files: readonly ChangedFile[],
	machine: PullRequestEvidenceItem[],
): void {
	for (const file of files) {
		if (!file.isTestFile) continue;
		machine.push({
			id: `machine:test-file:${file.path}`,
			kind: "test-file",
			confirmation: "machine",
			status: file.changeType === "deleted" ? "neutral" : "satisfied",
			label: file.path,
			detail: `Test file ${CHANGE_VERB[file.changeType]} in this pull request (+${file.additions} / -${file.deletions} lines)`,
			sourceRef: undefined,
		});
	}
}

function collectClaims(
	body: string | null,
	files: readonly ChangedFile[],
	settledChecks: readonly SettledCheck[],
	machine: PullRequestEvidenceItem[],
	dropped: DroppedInput[],
): void {
	let index = 0;
	for (const claim of extractTestingClaims(body)) {
		// A check name only counts when the description quotes it exactly, so
		// "ran `bun test some/file.ts`" isn't read as the check named "test".
		const check = settledChecks.find((candidate) =>
			claim.codeSpans.some(
				(span) => span.toLowerCase() === candidate.name.toLowerCase(),
			),
		);
		if (check) {
			machine.push({
				id: `machine:testing-claim:${index++}`,
				kind: "testing-claim",
				confirmation: "machine",
				status: check.status,
				label: claim.text,
				detail: `Claim names check "${check.name}", whose status is settled`,
				sourceRef: undefined,
			});
			continue;
		}

		const file = matchChangedFile(claim, files);
		if (file) {
			const deleted = file.changeType === "deleted";
			machine.push({
				id: `machine:testing-claim:${index++}`,
				kind: "testing-claim",
				confirmation: "machine",
				status: deleted ? "neutral" : "satisfied",
				label: claim.text,
				detail: `Claim names ${file.path}, which this pull request ${deleted ? "deletes" : "changes"}`,
				sourceRef: file.path,
			});
			continue;
		}

		dropped.push({
			reason: "claim-uncorroborated",
			detail: `No changed file or settled check matches: ${claim.text}`,
		});
	}
}

function collectReviewDecision(
	decision: ReviewDecision,
	human: PullRequestEvidenceItem[],
): void {
	if (decision !== "approved" && decision !== "changes_requested") return;
	const approved = decision === "approved";
	human.push({
		id: "human:review-approval",
		kind: "review-approval",
		confirmation: "human",
		status: approved ? "satisfied" : "failed",
		label: approved
			? "Approved by a reviewer"
			: "Changes requested by a reviewer",
		detail: `GitHub review decision: ${decision}`,
		sourceRef: undefined,
	});
}

function formatValue(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}
