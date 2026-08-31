import { Trans, useLingui } from "@lingui/react/macro";
import { PLUGIN_CATEGORIES } from "@superset/shared/plugins";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LuSearch, LuSettings2 } from "react-icons/lu";
import { PluginIcon } from "renderer/routes/_authenticated/_dashboard/plugins/components/PluginIcon";
import {
	type CatalogPlugin,
	usePluginCatalog,
} from "renderer/routes/_authenticated/_dashboard/plugins/hooks/usePluginCatalog";
import { usePluginMutations } from "renderer/routes/_authenticated/_dashboard/plugins/hooks/usePluginMutations";
import { ManageInstalledDialog } from "./components/ManageInstalledDialog";
import { PluginCard } from "./components/PluginCard";
import { SkillsList } from "./components/SkillsList";

export function PluginsView() {
	const { t } = useLingui();
	const [search, setSearch] = useState("");
	const [isManageOpen, setIsManageOpen] = useState(false);
	const navigate = useNavigate();

	const {
		plugins: catalog,
		isLoading: isCatalogLoading,
		error: catalogError,
	} = usePluginCatalog();

	// Installed is not the same as usable: a plugin that needs auth is only
	// done once an account is connected, so the card should not claim otherwise.
	const isConnected = (plugin: CatalogPlugin) =>
		plugin.installed && (!plugin.auth || plugin.accounts.length > 0);

	const { uninstall, setEnabled, isBusy } = usePluginMutations();

	const handleOpen = (plugin: CatalogPlugin) => {
		navigate({
			to: "/plugins/$pluginName",
			params: { pluginName: plugin.name },
		});
	};

	const query = search.trim().toLowerCase();
	const visiblePlugins = useMemo(() => {
		const all: CatalogPlugin[] = catalog;
		if (query === "") return all;
		return all.filter((plugin) =>
			[
				plugin.name,
				plugin.interface.displayName,
				plugin.description,
				plugin.interface.category,
			]
				.join(" ")
				.toLowerCase()
				.includes(query),
		);
	}, [query, catalog]);

	const installedPlugins = visiblePlugins.filter((plugin) => plugin.installed);
	const featured = visiblePlugins.filter((plugin) => plugin.featured);
	// Featured plugins appear in their category section too — Featured is a
	// spotlight, not a home.
	const byCategory = PLUGIN_CATEGORIES.map((category) => ({
		category,
		plugins: visiblePlugins.filter(
			(plugin) => plugin.interface.category === category,
		),
	})).filter(({ plugins }) => plugins.length > 0);

	const renderCard = (plugin: CatalogPlugin) => (
		<PluginCard
			key={plugin.name}
			plugin={plugin}
			isInstalled={plugin.installed}
			isConnected={isConnected(plugin)}
			isDisabled={plugin.installed && !plugin.enabled}
			isBusy={isBusy}
			onOpen={handleOpen}
			onUninstall={(target) => uninstall(target.name)}
			onSetEnabled={setEnabled}
		/>
	);

	return (
		<div className="mx-auto w-full max-w-3xl px-6 pb-16">
			<Tabs defaultValue="plugins">
				<TabsList className="mb-6">
					<TabsTrigger value="plugins">
						<Trans id="dashboard.plugins.tabs.plugins">Plugins</Trans>
					</TabsTrigger>
					<TabsTrigger value="skills">
						<Trans id="dashboard.plugins.tabs.skills">Skills</Trans>
					</TabsTrigger>
				</TabsList>

				<TabsContent value="plugins" className="flex flex-col gap-6">
					<div>
						<h1 className="text-2xl font-semibold text-foreground">
							<Trans id="dashboard.plugins.title">Plugins</Trans>
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							<Trans id="dashboard.plugins.subtitle">
								Work with your agents across your favorite tools
							</Trans>
						</p>
					</div>

					<div className="relative">
						<LuSearch className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={t({
								id: "dashboard.plugins.searchPlaceholder",
								message: "Search plugins",
							})}
							className="rounded-full pl-9"
						/>
					</div>

					{installedPlugins.length > 0 && (
						<section className="flex flex-col gap-3">
							<div className="flex items-center justify-between">
								<h2 className="text-sm font-semibold text-foreground">
									<Trans id="dashboard.plugins.installedHeading">
										Installed
									</Trans>
								</h2>
								<Tooltip delayDuration={300}>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon-xs"
											className="text-muted-foreground"
											aria-label={t({
												id: "dashboard.plugins.managePlugins",
												message: "Manage plugins",
											})}
											onClick={() => setIsManageOpen(true)}
										>
											<LuSettings2 className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										<Trans id="dashboard.plugins.managePlugins">
											Manage plugins
										</Trans>
									</TooltipContent>
								</Tooltip>
							</div>
							<div className="flex flex-wrap gap-2">
								{installedPlugins.map((plugin) => (
									<Tooltip key={plugin.name} delayDuration={300}>
										<TooltipTrigger asChild>
											<button
												type="button"
												aria-label={plugin.interface.displayName}
												onClick={() => handleOpen(plugin)}
												className={cn(!plugin.enabled && "opacity-40")}
											>
												<PluginIcon
													pluginName={plugin.name}
													className="size-8"
												/>
											</button>
										</TooltipTrigger>
										<TooltipContent>
											{plugin.interface.displayName}
											{!plugin.enabled ? (
												<>
													{" "}
													<Trans id="dashboard.plugins.disabledSuffix">
														(disabled)
													</Trans>
												</>
											) : (
												""
											)}
										</TooltipContent>
									</Tooltip>
								))}
							</div>
						</section>
					)}

					{featured.length > 0 && (
						<section className="flex flex-col gap-3">
							<h2 className="text-sm font-semibold text-foreground">
								<Trans id="dashboard.plugins.featuredHeading">Featured</Trans>
							</h2>
							<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
								{featured.map(renderCard)}
							</div>
						</section>
					)}

					{byCategory.map(({ category, plugins }) => (
						<section key={category} className="flex flex-col gap-3">
							<h2 className="text-sm font-semibold text-foreground">
								{category}
							</h2>
							<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
								{plugins.map(renderCard)}
							</div>
						</section>
					))}

					{visiblePlugins.length === 0 && query !== "" && (
						<p className="py-8 text-center text-sm text-muted-foreground">
							<Trans id="dashboard.plugins.noSearchMatches">
								No plugins match "{search.trim()}"
							</Trans>
						</p>
					)}

					{catalogError && (
						<p className="py-8 text-center text-sm text-muted-foreground">
							<Trans id="dashboard.plugins.catalogUnavailable">
								Could not load plugins. Check your connection and try again.
							</Trans>
						</p>
					)}

					{!catalogError &&
						!isCatalogLoading &&
						catalog.length === 0 &&
						query === "" && (
							<p className="py-8 text-center text-sm text-muted-foreground">
								<Trans id="dashboard.plugins.catalogEmpty">
									No plugins available yet.
								</Trans>
							</p>
						)}

					<ManageInstalledDialog
						open={isManageOpen}
						onOpenChange={setIsManageOpen}
						installed={installedPlugins}
						isBusy={isBusy}
						onSetEnabled={setEnabled}
						onUninstall={uninstall}
					/>
				</TabsContent>

				<TabsContent value="skills" className="flex flex-col gap-6">
					<div>
						<h1 className="text-2xl font-semibold text-foreground">
							<Trans id="dashboard.plugins.skillsTitle">Skills</Trans>
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							<Trans id="dashboard.plugins.skillsSubtitle">
								Reusable instructions your agents pick up automatically
							</Trans>
						</p>
					</div>
					<SkillsList />
				</TabsContent>
			</Tabs>
		</div>
	);
}
