import type { ApprovalRequest } from "@superset/chat/protocol";
import { isKnownItem } from "@superset/chat/protocol";
import type { PageResult } from "@superset/chat-runtime";
import { boolean, CLIError, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { requireHostTarget, resolveHostTarget } from "../../../lib/host-target";

function findPendingApproval(page: PageResult): ApprovalRequest | null {
	if (!page.ok) return null;
	let pending: ApprovalRequest | null = null;
	for (const envelope of page.envelopes) {
		if (envelope.event.type !== "item") continue;
		const item = envelope.event.item;
		// `Item` also allows UnknownItem (kind: string), so an inequality
		// check alone can't narrow to ApprovalRequest — isKnownItem first.
		if (!isKnownItem(item) || item.kind !== "approval_request") continue;
		// Journal is append-only: keep the latest emission for this item id
		// (a later "answered"/"stale" envelope means it's no longer pending).
		pending = item.status === "pending" ? item : null;
	}
	return pending;
}

export default command({
	description:
		"Read a chat-v3 session's status and its current pending approval, if any",
	options: {
		host: string().desc("Target host machineId"),
		local: boolean().desc("Target this machine"),
		session: string()
			.required()
			.desc("Chat session ID (returned by `chat create`)"),
	},
	run: async ({ ctx, options }) => {
		const organizationId = ctx.config.organizationId;
		if (!organizationId) {
			throw new CLIError("No active organization", "Run: superset auth login");
		}

		const hostId = requireHostTarget({
			host: options.host ?? undefined,
			local: options.local ?? undefined,
		});
		const target = await resolveHostTarget({
			requestedHostId: hostId,
			organizationId,
			userJwt: ctx.bearer,
			api: ctx.api,
		});

		const { session, cursor } = await target.chat.getSession.query({
			sessionId: options.session,
		});
		if (!session) {
			throw new CLIError(
				`Chat session not found: ${options.session}`,
				"Check the --session id, or create one with `chat create`",
			);
		}

		const page = await target.chat.getItems.query({
			sessionId: options.session,
		});
		const pendingApproval = findPendingApproval(page);

		return {
			data: { session, cursor, pendingApproval },
			message: pendingApproval
				? `Session ${options.session} is ${session.status}; pending approval ${pendingApproval.id}: ${pendingApproval.title}`
				: `Session ${options.session} is ${session.status}; no pending approval`,
		};
	},
});
