import { useLingui } from "@lingui/react/macro";
import { errorMessage } from "@superset/i18n/errors";
import { getPluginByName } from "@superset/shared/plugins";
import { toast } from "@superset/ui/sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { posthog } from "renderer/lib/posthog";
import { PLUGIN_CATALOG_KEY } from "renderer/routes/_authenticated/_dashboard/plugins/hooks/usePluginCatalog";
import {
	registerPluginEnabled,
	registerPluginInstall,
	registerPluginUninstall,
} from "renderer/routes/_authenticated/_dashboard/plugins/hooks/usePluginConnections";

const displayName = (name: string) =>
	getPluginByName(name)?.interface.displayName ?? name;

/** Install/uninstall/toggle with shared toasts, analytics, and invalidation. */
export function usePluginMutations() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	// The account is the only place install state is read from, so every
	// mutation ends by refetching it — the local install writes skills and
	// agent config but is never queried back.
	const invalidate = (name: string) => {
		void queryClient.invalidateQueries({ queryKey: PLUGIN_CATALOG_KEY });
		void queryClient.invalidateQueries({
			queryKey: ["plugin-connections", name],
		});
	};

	// The local install materializes skills and agent config; the account
	// install is what the proxy reads to resolve a manifest at tool-call time,
	// and what the UI reads back. A failure here leaves the two out of step, so
	// it is surfaced rather than swallowed — the plugin is on disk but its tools
	// will not work and it will not show as installed.
	const syncAccount = async (
		name: string,
		action: "install" | "uninstall",
	): Promise<void> => {
		try {
			if (action === "install") await registerPluginInstall(name);
			else await registerPluginUninstall(name);
		} catch (error) {
			toast.warning(
				t({
					id: "dashboard.plugins.mutations.accountSyncFailed",
					message: `${displayName(name)} is set up on this machine, but not on your account`,
				}),
				{ description: errorMessage(error) },
			);
		} finally {
			invalidate(name);
		}
	};

	const installMutation = electronTrpc.plugins.install.useMutation({
		onSuccess: (_data, variables) => {
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
			void syncAccount(variables.name, "uninstall");
			posthog.capture("plugin_uninstalled", { plugin: variables.name });
			toast.success(
				t({
					id: "dashboard.plugins.mutations.uninstalled",
					message: `${displayName(variables.name)} uninstalled`,
				}),
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
			// `enabled` is reported by the catalog, so the account has to move
			// too or the toggle snaps back on the next refetch.
			void registerPluginEnabled(variables.name, variables.enabled)
				.catch((error) =>
					toast.warning(
						t({
							id: "dashboard.plugins.mutations.accountSyncFailed",
							message: `${displayName(variables.name)} is set up on this machine, but not on your account`,
						}),
						{ description: errorMessage(error) },
					),
				)
				.finally(() => invalidate(variables.name));
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
					id: "dashboard.plugins.mutations.updateFailed",
					message: "Could not update plugin",
				}),
				{
					description: errorMessage(error),
				},
			);
		},
	});

	// Same local write as install; only the toast differs, because "installed"
	// is a confusing thing to read after asking for an update.
	const updateMutation = electronTrpc.plugins.install.useMutation({
		onSuccess: (_data, variables) => {
			posthog.capture("plugin_updated", { plugin: variables.name });
			toast.success(
				t({
					id: "dashboard.plugins.mutations.updated",
					message: `${displayName(variables.name)} updated`,
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
					id: "dashboard.plugins.mutations.updateFailed",
					message: "Could not update plugin",
				}),
				{ description: errorMessage(error) },
			);
		},
	});

	/**
	 * Add: install here and on the account, and land on the plugin's page.
	 *
	 * Resolves only once the account row exists, because that is what the
	 * connect route resolves a manifest from — a caller that authenticates
	 * straight after adding would otherwise race it and 404.
	 */
	const add = async (name: string): Promise<void> => {
		navigate({ to: "/plugins/$pluginName", params: { pluginName: name } });
		await installMutation.mutateAsync({ name });
		await syncAccount(name, "install");
	};

	/**
	 * Update: the same two writes as an install, run against a plugin that is
	 * already installed. Separated because the account upsert always lands on
	 * the marketplace's current version, so this is the only path that moves
	 * one — and it is worth the user having asked for it by name.
	 */
	const update = async (name: string): Promise<void> => {
		await updateMutation.mutateAsync({ name });
		await syncAccount(name, "install");
	};

	return {
		add,
		update,
		install: async (name: string) => {
			await installMutation.mutateAsync({ name });
			await syncAccount(name, "install");
		},
		uninstall: (name: string) => uninstallMutation.mutate({ name }),
		setEnabled: (name: string, enabled: boolean) =>
			setEnabledMutation.mutate({ name, enabled }),
		isBusy:
			installMutation.isPending ||
			updateMutation.isPending ||
			uninstallMutation.isPending ||
			setEnabledMutation.isPending,
	};
}
