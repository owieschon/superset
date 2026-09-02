import { parsePullRequestDiff } from "./parse-pr-diff";
import { extractTestingClaims, matchChangedFile } from "./testing-claims";
import type {
	ChangedFile,
	DroppedInput,
	EvidenceStatus,
	PullRequestCheck,
	PullRequestEvidence,
	PullRequestEvidenceInput,
	PullRequestEvidenceItem,
} from "./types";

/** GitHub's CheckConclusionState, mapped to the outcome each one settles on. */
const CHECK_CONCLUSIONS: Record<string, EvidenceStatus> = {
	success: "satisfied",
	failure: "failed",
	timed_out: "failed",
	action_required: "failed",
	startup_failure: "failed",
	stale: "failed",
	neutral: "neutral",
	skipped: "neutral",
	cancelled: "neutral",
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
 *    line naming a file nobody touched, a conclusion the provider didn't send:
 *    each lands in `dropped` with a reason instead of being guessed at.
 * 2. Human confirmation and machine-read facts stay in separate lists. A
 *    reviewer's approval is a person's decision, and it is never merged into,
 *    or averaged with, what the providers report.
 * 3. Nothing here evaluates the code. There are no defect claims, no scores,
 *    and no judgment of whether the description is truthful — only whether a
 *    named file or check can be found in this pull request's own data.
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
	conclusion: string;
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

		if (check.status !== "completed" || typeof check.conclusion !== "string") {
			dropped.push({
				reason: "check-unsettled",
				detail: `Check "${name}" has not concluded (status: ${formatValue(check.status)})`,
			});
			continue;
		}

		const status = CHECK_CONCLUSIONS[check.conclusion];
		if (!status) {
			dropped.push({
				reason: "check-invalid",
				detail: `Check "${name}" reported an unrecognized conclusion: ${check.conclusion}`,
			});
			continue;
		}

		// Matrix jobs legitimately repeat a name; the suffix keeps ids unique
		// without renaming the first occurrence people already recognize.
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
			detail: `Check concluded: ${check.conclusion}`,
			sourceRef: check.detailsUrl ?? undefined,
		});
		settled.push({ name, conclusion: check.conclusion, status });
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
				detail: `Claim names check "${check.name}", which concluded: ${check.conclusion}`,
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
	decision: string | null,
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
