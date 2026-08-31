import { useLingui } from "@lingui/react/macro";
import { errorMessage } from "@superset/i18n/errors";
import {
	getPluginByName,
	isPluginExternallyConfigured,
} from "@superset/shared/plugins";
import { toast } from "@superset/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { env } from "renderer/env.renderer";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { posthog } from "renderer/lib/posthog";
import {
	registerPluginInstall,
	registerPluginUninstall,
} from "renderer/routes/_authenticated/_dashboard/plugins/hooks/usePluginConnections";

const displayName = (name: string) =>
	getPluginByName(name)?.interface.displayName ?? name;

/** Install/uninstall/toggle with shared toasts, analytics, and invalidation. */
export function usePluginMutations() {
	const { t } = useLingui();
	const utils = electronTrpc.useUtils();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	// The local install materializes skills and agent config; the account
	// install is what the proxy reads to resolve a manifest at tool-call time.
	// A failure here leaves the two out of step, so it is surfaced rather than
	// swallowed — the plugin is on disk but its tools will not work.
	const syncAccount = async (
		name: string,
		action: "install" | "uninstall",
	): Promise<void> => {
		try {
			if (action === "install") await registerPluginInstall(name);
			else await registerPluginUninstall(name);
			void queryClient.invalidateQueries({
				queryKey: ["plugin-connections", name],
			});
		} catch (error) {
			toast.warning(
				t({
					id: "dashboard.plugins.mutations.accountSyncFailed",
					message: `${displayName(name)} is set up on this machine, but not on your account`,
				}),
				{ description: errorMessage(error) },
			);
		}
	};
	const invalidate = () => {
		void utils.plugins.listInstalled.invalidate();
		void utils.plugins.listExternalServers.invalidate();
	};
	// Uninstall/disable only ever remove what Superset wrote; when the user's
	// own entries also provide this plugin, say so instead of implying it's gone.
	const handWrittenRemains = (name: string) => {
		const plugin = getPluginByName(name);
		const external = utils.plugins.listExternalServers.getData() ?? [];
		return plugin !== undefined
			? isPluginExternallyConfigured(plugin, external)
			: false;
	};

	const installMutation = electronTrpc.plugins.install.useMutation({
		onSuccess: (_data, variables) => {
			invalidate();
			void syncAccount(variables.name, "install");
			posthog.capture("plugin_installed", { plugin: variables.name });
			toast.success(
				t({
					id: "dashboard.plugins.mutations.installed",
					message: `${displayName(variables.name)} installed`,
				}),
				{
					description: t({
						id: "dashboard.plugins.mutations.takesEffectNewSessions",
						message: "Takes effect in new agent sessions.",
					}),
				},
			);
		},
		onError: (error) => {
			toast.error(
				t({
					id: "dashboard.plugins.mutations.installFailed",
					message: "Install failed",
				}),
				{ description: errorMessage(error) },
			);
		},
	});
	const uninstallMutation = electronTrpc.plugins.uninstall.useMutation({
		onSuccess: (_data, variables) => {
			const remains = handWrittenRemains(variables.name);
			invalidate();
			void syncAccount(variables.name, "uninstall");
			posthog.capture("plugin_uninstalled", { plugin: variables.name });
			toast.success(
				t({
					id: "dashboard.plugins.mutations.uninstalled",
					message: `${displayName(variables.name)} uninstalled`,
				}),
				remains
					? {
							description: t({
								id: "dashboard.plugins.mutations.handWrittenEntriesStay",
								message:
									"Entries you added yourself stay in your agent config.",
							}),
						}
					: undefined,
			);
		},
		onError: (error) => {
			toast.error(
				t({
					id: "dashboard.plugins.mutations.uninstallFailed",
					message: "Uninstall failed",
				}),
				{ description: errorMessage(error) },
			);
		},
	});
	const setEnabledMutation = electronTrpc.plugins.setEnabled.useMutation({
		onSuccess: (_data, variables) => {
			const remains = !variables.enabled && handWrittenRemains(variables.name);
			invalidate();
			posthog.capture(
				variables.enabled ? "plugin_enabled" : "plugin_disabled",
				{ plugin: variables.name },
			);
			toast.success(
				variables.enabled
					? t({
							id: "dashboard.plugins.mutations.enabled",
							message: `${displayName(variables.name)} enabled`,
						})
					: t({
							id: "dashboard.plugins.mutations.disabled",
							message: `${displayName(variables.name)} disabled`,
						}),
				{
					description: remains
						? t({
								id: "dashboard.plugins.mutations.handWrittenEntriesStayActive",
								message:
									"Entries you added yourself stay active in your agent config.",
							})
						: t({
								id: "dashboard.plugins.mutations.takesEffectNewSessions",
								message: "Takes effect in new agent sessions.",
							}),
				},
			);
		},
		onError: (error) => {
			toast.error(
				t({
					id: "dashboard.plugins.mutations.updateFailed",
					message: "Could not update plugin",
				}),
				{
					description: errorMessage(error),
				},
			);
		},
	});

	/**
	 * Add: install, open the plugin's page, and start its OAuth flow if it has
	 * one. Navigating first means the browser hand-off happens against a page
	 * that already shows the connection, so returning from the provider lands
	 * somewhere that reflects what just happened.
	 */
	const add = (
		name: string,
		authType?: string | null,
		inputs: Record<string, string> = {},
	) => {
		navigate({ to: "/plugins/$pluginName", params: { pluginName: name } });
		installMutation.mutate(
			{ name },
			{
				onSuccess: () => {
					if (authType !== "oauth2") return;
					void registerPluginInstall(name)
						.then(() => {
							const url = new URL(
								`${env.NEXT_PUBLIC_API_URL}/api/plugins/${name}/connect`,
							);
							for (const [key, value] of Object.entries(inputs)) {
								url.searchParams.set(key, value);
							}
							url.searchParams.set("method", authType);
							window.open(url.toString(), "_blank", "noopener,noreferrer");
						})
						.catch(() => {
							// syncAccount already surfaced the failure; without an install
							// row the connect route would 404, so do not open it.
						});
				},
			},
		);
	};

	return {
		add,
		install: (name: string) => installMutation.mutate({ name }),
		uninstall: (name: string) => uninstallMutation.mutate({ name }),
		setEnabled: (name: string, enabled: boolean) =>
			setEnabledMutation.mutate({ name, enabled }),
		isBusy:
			installMutation.isPending ||
			uninstallMutation.isPending ||
			setEnabledMutation.isPending,
	};
}
