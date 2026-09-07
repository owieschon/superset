import { randomUUID } from "node:crypto";
import { CLIError, string } from "@superset/cli-framework";
import { getHostId } from "@superset/shared/host-info";
import { command } from "../../../lib/command";
import { resolveHostTarget } from "../../../lib/host-target";
import { findWorkspaceOnHost } from "../../../lib/host-workspaces";

export default command({
	description: "Create a chat-v3 session in a workspace",
	options: {
		workspace: string().required().desc("Workspace ID"),
		host: string().desc("Host the workspace lives on (default: this machine)"),
		harness: string()
			.required()
			.desc("Harness id configured on the host (e.g. claude-code, codex)"),
		modeId: string().desc("Initial mode id, if the harness supports one"),
		modelId: string().desc("Initial model id, if the harness supports one"),
	},
	run: async ({ ctx, options }) => {
		const organizationId = ctx.config.organizationId;
		if (!organizationId) {
			throw new CLIError("No active organization", "Run: superset auth login");
		}

		const hostId = options.host ?? getHostId();
		const { workspace } = await findWorkspaceOnHost(
			{ organizationId, userJwt: ctx.bearer, api: ctx.api, hostId },
			options.workspace,
		);
		if (!workspace) {
			throw new CLIError(
				`Workspace not found on host ${hostId}: ${options.workspace}`,
				"Pass --host <id> if it lives on another machine",
			);
		}

		const target = await resolveHostTarget({
			requestedHostId: hostId,
			organizationId,
			userJwt: ctx.bearer,
			api: ctx.api,
		});

		const result = await target.chat.createSession.mutate({
			commandId: randomUUID(),
			workspaceId: options.workspace,
			harness: options.harness,
			modeId: options.modeId,
			modelId: options.modelId,
		});

		return {
			data: result,
			message: `Created chat session ${result.sessionId} in workspace ${options.workspace}`,
		};
	},
});
