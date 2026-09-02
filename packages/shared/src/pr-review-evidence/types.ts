/**
 * Shapes for the deterministic pull-request evidence producer.
 *
 * "Evidence" here is narrow on purpose: a fact Superset can read straight out
 * of data it already holds for a pull request — a check that has concluded, a
 * test file the diff touches, a sentence in the description that names one of
 * those. Nothing in this module judges code, predicts defects, or infers
 * intent, and nothing here is produced by a model.
 */

/**
 * A check's settled outcome, mirroring the `CheckStatus` union that
 * `parseCheckContexts` produces in
 * `packages/host-service/src/runtime/pull-requests/utils/pull-request-mappers`.
 *
 * Mirrored rather than imported because `host-service` depends on
 * `@superset/shared`, so the dependency cannot run the other way. This is the
 * normalized vocabulary every consumer already sees — GitHub's raw uppercase
 * `status`/`conclusion` pair is mapped away before it reaches anyone.
 */
export type CheckStatus =
	| "success"
	| "failure"
	| "pending"
	| "skipped"
	| "cancelled";

/**
 * A check as Superset already models it — `{ name, status, url }`, the same
 * shape `PullRequestCheck` carries in the mappers and in the desktop renderer's
 * `pull-request-checks.ts`.
 *
 * `status` is typed as the normalized union but is treated as untrusted at
 * runtime: `parseChecksJson` rebuilds cached checks from a database column and
 * only asserts `typeof status === "string"`, so an unrecognized value can
 * reach this producer and must be dropped rather than guessed at.
 */
export interface PullRequestCheck {
	name: string;
	status: CheckStatus;
	url: string | null;
}

/**
 * A reviewer's recorded decision, mirroring `ReviewDecision` from the same
 * mappers module. "pending" means no decision has been made yet.
 */
export type ReviewDecision =
	| "approved"
	| "changes_requested"
	| "pending"
	| null;

export interface PullRequestEvidenceInput {
	checks: readonly PullRequestCheck[];
	/** A unified diff, as `pullRequests.getDiff` returns it. */
	diffPatch: string | null;
	/** The pull request description. */
	body: string | null;
	reviewDecision: ReviewDecision;
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
	/** A check's URL, or the changed file a claim was matched against. */
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
