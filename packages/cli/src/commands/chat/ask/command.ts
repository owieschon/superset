import { randomUUID } from "node:crypto";
import { boolean, CLIError, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";
import { requireHostTarget, resolveHostTarget } from "../../../lib/host-target";

export default command({
	description: "Send a message to a chat-v3 session",
	options: {
		host: string().desc("Target host machineId"),
		local: boolean().desc("Target this machine"),
		session: string()
			.required()
			.desc("Chat session ID (returned by `chat create`)"),
		text: string().required().desc("Message text to send"),
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

		const result = await target.chat.prompt.mutate({
			commandId: randomUUID(),
			sessionId: options.session,
			clientId: randomUUID(),
			content: [{ type: "text", text: options.text }],
		});

		return {
			data: result,
			message: result.queued
				? `Queued for chat session ${options.session}`
				: `Sent to chat session ${options.session}`,
		};
	},
});
