/**
 * Shapes for the deterministic pull-request evidence producer.
 *
 * "Evidence" here is narrow on purpose: a fact Superset can read straight out
 * of data it already holds for a pull request — a check that has concluded, a
 * test file the diff touches, a sentence in the description that names one of
 * those. Nothing in this module judges code, predicts defects, or infers
 * intent, and nothing here is produced by a model.
 */

/** A check run as the providers hand it to us — fields may be absent or wrong. */
export interface PullRequestCheck {
	name: string;
	/** GitHub's CheckStatusState: "queued" | "in_progress" | "completed". */
	status: string | null;
	/** GitHub's CheckConclusionState, null while the check is still running. */
	conclusion: string | null;
	detailsUrl?: string | null;
}

export interface PullRequestEvidenceInput {
	checks: readonly PullRequestCheck[];
	/** A unified diff, as `pull-requests.getDiff` returns it. */
	diffPatch: string | null;
	/** The pull request description. */
	body: string | null;
	/** GitHub's PullRequestReviewDecision. */
	reviewDecision: string | null;
}

export type ChangeType = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
	path: string;
	/** Set only for renames. */
	previousPath: string | null;
	changeType: ChangeType;
	additions: number;
	deletions: number;
	isTestFile: boolean;
}

/**
 * Who or what settled this. Machine evidence is read off a provider; human
 * evidence is a person's recorded decision. The two never merge — a reviewer's
 * approval is not a stronger green check, and a green check is not review.
 */
export type EvidenceConfirmation = "machine" | "human";

/**
 * The outcome the underlying fact settled on. "neutral" is a settled fact that
 * is neither pass nor fail — a skipped check, a deleted test — not "unknown".
 */
export type EvidenceStatus = "satisfied" | "failed" | "neutral";

export type EvidenceKind =
	| "check"
	| "test-file"
	| "testing-claim"
	| "review-approval";

export interface PullRequestEvidenceItem {
	/** Stable across runs for the same input; carries the confirmation source. */
	id: string;
	kind: EvidenceKind;
	confirmation: EvidenceConfirmation;
	status: EvidenceStatus;
	label: string;
	detail: string;
	/** A check's details URL, or the changed file a claim was matched against. */
	sourceRef: string | undefined;
}

/** Why an input produced no evidence. Kept so the gap is legible, not silent. */
export interface DroppedInput {
	reason: "check-invalid" | "check-unsettled" | "claim-uncorroborated";
	detail: string;
}

export interface PullRequestEvidence {
	machine: PullRequestEvidenceItem[];
	human: PullRequestEvidenceItem[];
	dropped: DroppedInput[];
}
