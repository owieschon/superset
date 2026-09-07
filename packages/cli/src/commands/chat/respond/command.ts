import { randomUUID } from "node:crypto";
import type { Decision } from "@superset/chat/protocol";
import { boolean, CLIError, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { requireHostTarget, resolveHostTarget } from "../../../lib/host-target";

const DECISION_TYPES = [
	"accept",
	"accept_for_session",
	"decline",
	"cancel",
	"option",
] as const;

function buildDecision(
	decisionType: string,
	optionId: string | undefined,
): Decision {
	const match = DECISION_TYPES.find((candidate) => candidate === decisionType);
	if (!match) {
		throw new CLIError(
			`Unknown --decision: ${decisionType}`,
			`Pass one of: ${DECISION_TYPES.join(", ")}`,
		);
	}
	if (match === "option") {
		if (!optionId) {
			throw new CLIError(
				"Missing --option",
				"Pass --option <optionId> when --decision option",
			);
		}
		return { type: "option", optionId };
	}
	return { type: match };
}

export default command({
	description:
		"Answer a pending chat-v3 approval by id — a stale or mismatched id is rejected on harnesses that report it as an error; the claude-code and codex harnesses currently no-op silently on one instead (see router.ts mapCommandError)",
	options: {
		host: string().desc("Target host machineId"),
		local: boolean().desc("Target this machine"),
		session: string()
			.required()
			.desc("Chat session ID (returned by `chat create`)"),
		approval: string()
			.required()
			.desc(
				"Approval request id to answer (the current id from `chat status`)",
			),
		decision: string()
			.required()
			.desc(`Decision type: ${DECISION_TYPES.join(", ")}`),
		option: string().desc(
			"Option id to select; required when --decision option",
		),
	},
	run: async ({ ctx, options }) => {
		const organizationId = ctx.config.organizationId;
		if (!organizationId) {
			throw new CLIError("No active organization", "Run: superset auth login");
		}

		const decision = buildDecision(options.decision, options.option);

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

		await target.chat.respondToApproval.mutate({
			commandId: randomUUID(),
			sessionId: options.session,
			approvalId: options.approval,
			decision,
		});

		return {
			data: {
				sessionId: options.session,
				approvalId: options.approval,
				decision,
			},
			message: `Answered approval ${options.approval} in session ${options.session} (${options.decision})`,
		};
	},
});
