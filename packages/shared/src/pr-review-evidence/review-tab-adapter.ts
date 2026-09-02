import type { PullRequestEvidence } from "./types";

/**
 * The Review tab's evidence contract, mirrored here on purpose.
 *
 * The native Pull Request Review tab (`PullRequestReviewTab`, on
 * superset-sh/superset#6689 at 073144fadbbb75bd9d0a69d0f23ba6f319e73afa)
 * renders `ReviewTabData.evidence: EvidenceItem[]` out of a fixture. This file
 * restates that shape and is the only place that knows it, so when the tab
 * lands and its contract moves, one adapter changes rather than the producer.
 */
export type ReviewTabEvidenceKind = "document" | "image" | "video";

export interface ReviewTabEvidenceItem {
	id: string;
	label: string;
	kind: ReviewTabEvidenceKind;
}

/**
 * Maps settled evidence onto that contract, human confirmation first.
 *
 * The contract is a flat list with no field for where an item came from, so
 * the confirmation source rides along in the id prefix ("human:" / "machine:")
 * — the one thing that survives the mapping. When `EvidenceItem` grows a real
 * field for it, set it here and drop the prefix convention.
 */
export function toReviewTabEvidenceItems(
	evidence: PullRequestEvidence,
): ReviewTabEvidenceItem[] {
	return [...evidence.human, ...evidence.machine].map((item) => ({
		id: item.id,
		label: item.label,
		kind: "document" as const,
	}));
}
