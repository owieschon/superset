import { Trans, useLingui } from "@lingui/react/macro";
import { errorMessage } from "@superset/i18n/errors";
import { formatDate } from "@superset/i18n/format";
import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { useState } from "react";
import { LuGlobe, LuKeyRound, LuPlus, LuTrash2 } from "react-icons/lu";
import { PluginIcon } from "renderer/routes/_authenticated/_dashboard/plugins/components/PluginIcon";
import { usePluginConnections } from "renderer/routes/_authenticated/_dashboard/plugins/hooks/usePluginConnections";
import { SectionHeader } from "../SectionHeader";

export interface AuthInputSpec {
	name: string;
	label?: string;
	placeholder?: string;
	required?: boolean;
	secret?: boolean;
}

export interface PluginAuthSpec {
	type: "oauth2" | "api_key";
	label?: string | null;
	inputs?: readonly AuthInputSpec[];
}

const METHOD_LABELS: Record<string, string> = {
	oauth2: "OAuth 2.0",
	api_key: "API key",
};

export function PluginConnections({
	pluginName,
	displayName,
	auth,
	installed,
	onAdd,
	onRemove,
	isBusy,
}: {
	pluginName: string;
	displayName: string;
	/** Empty or absent for a skills-only plugin, which has nothing to authenticate. */
	auth?: readonly PluginAuthSpec[];
	installed: boolean;
	onAdd: (inputs?: Record<string, string>, method?: string) => void;
	onRemove: () => void;
	isBusy: boolean;
}) {
	const { t } = useLingui();
	const {
		connections,
		isLoading,
		connectOAuth,
		connectApiKey,
		isConnecting,
		connectError,
		disconnect,
		isDisconnecting,
	} = usePluginConnections(pluginName);
	const [values, setValues] = useState<Record<string, string>>({});

	// One method today: a manifest declares a single `auth`. The control is a
	// select so offering a choice later needs no UI change — only a manifest
	// that can list more than one.
	const methods = auth ?? [];
	const [method, setMethod] = useState<PluginAuthSpec["type"]>(
		methods[0]?.type ?? "oauth2",
	);

	// Inputs belong to the chosen method: Linear's API key needs a field, its
	// OAuth flow needs none.
	const selected = methods.find((entry) => entry.type === method);
	const inputs = selected?.inputs ?? [];
	const missingRequired = inputs.some(
		(input) => input.required && !values[input.name]?.trim(),
	);
	const connected = connections.length > 0;

	// Inputs are collected before either flow starts: oauth2 templates
	// ${inputs.site} into its authorize URL for per-tenant providers, so
	// redirecting first would send an unresolved URL.
	// Connecting is what marks a plugin added, so an unadded plugin installs on
	// the way through rather than needing a separate Add step first.
	const authenticate = () => {
		if (!installed) {
			onAdd(values, method);
			return;
		}
		if (method === "api_key") connectApiKey({ inputs: values, method });
		else connectOAuth(values, method);
	};

	return (
		<section className="mt-10 flex flex-col">
			<SectionHeader
				label={
					<Trans id="dashboard.plugins.detail.connectionsHeading">
						Connections
					</Trans>
				}
				count={connections.length}
			/>

			{connections.map((connection) => (
				<div key={connection.id} className="flex items-center gap-3 py-3">
					<PluginIcon pluginName={pluginName} className="size-8" />
					<div className="min-w-0 flex-1">
						<div className="truncate text-sm font-medium text-foreground">
							{connection.account ?? displayName}
						</div>
						<p className="text-xs text-muted-foreground">
							<Trans id="dashboard.plugins.detail.connectedOn">
								connected {formatDate(new Date(connection.createdAt))}
							</Trans>
						</p>
					</div>
					<Badge variant="outline" className="gap-1.5">
						<span className="size-1.5 rounded-full bg-emerald-500" />
						<Trans id="dashboard.plugins.detail.connected">Connected</Trans>
					</Badge>
					<Button
						variant="ghost"
						size="icon-xs"
						className="text-destructive"
						disabled={isDisconnecting}
						aria-label={t({
							id: "dashboard.plugins.detail.disconnectLabel",
							message: `Disconnect ${connection.account ?? displayName}`,
						})}
						onClick={() => disconnect(connection.id)}
					>
						<LuTrash2 className="size-4" />
					</Button>
				</div>
			))}

			{methods.length === 0 && (
				<div className="mt-4 rounded-lg border border-border/60 p-4">
					<div className="flex items-center justify-between gap-4">
						<p className="text-sm text-muted-foreground">
							<Trans id="dashboard.plugins.detail.noAuthNeeded">
								This plugin needs no account — its skills are ready to use.
							</Trans>
						</p>
						{installed ? (
							<Button
								variant="outline"
								size="sm"
								className="shrink-0 text-destructive"
								disabled={isBusy}
								onClick={onRemove}
							>
								<LuTrash2 className="size-4" />
								<Trans id="dashboard.plugins.detail.remove">Remove</Trans>
							</Button>
						) : (
							<Button
								size="sm"
								className="shrink-0"
								disabled={isBusy}
								onClick={() => onAdd()}
							>
								<LuPlus className="size-4" />
								<Trans id="dashboard.plugins.detail.addPlugin">
									Add plugin
								</Trans>
							</Button>
						)}
					</div>
				</div>
			)}

			{methods.length > 0 && !connected && !isLoading && (
				<div className="mt-4 rounded-lg border border-border/60 p-4">
					{/* A select with one option is a control that cannot be used —
					    it only appears once a plugin actually offers a choice. The
					    single-method case states the fact under Information instead. */}
					{methods.length > 1 && (
						<div className="mb-4 flex items-center justify-between gap-4 border-b border-border/60 pb-4">
							<label
								htmlFor={`${pluginName}-auth-method`}
								className="text-sm text-foreground"
							>
								<Trans id="dashboard.plugins.detail.authentication">
									Authentication
								</Trans>
							</label>
							<Select
								value={method}
								onValueChange={(next) =>
									setMethod(next as PluginAuthSpec["type"])
								}
							>
								<SelectTrigger
									id={`${pluginName}-auth-method`}
									className="w-52"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{methods.map((entry) => (
										<SelectItem key={entry.type} value={entry.type}>
											{entry.label ?? METHOD_LABELS[entry.type] ?? entry.type}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{inputs.length > 0 && (
						<div className="mb-4 flex flex-col gap-3">
							{inputs.map((input) => {
								const fieldId = `${pluginName}-${input.name}`;
								return (
									<div key={input.name} className="flex flex-col gap-1.5">
										<label
											htmlFor={fieldId}
											className="text-xs font-medium text-foreground"
										>
											{input.label ?? input.name}
										</label>
										<Input
											id={fieldId}
											type={input.secret ? "password" : "text"}
											placeholder={input.placeholder}
											value={values[input.name] ?? ""}
											onChange={(event) =>
												setValues((current) => ({
													...current,
													[input.name]: event.target.value,
												}))
											}
										/>
									</div>
								);
							})}
						</div>
					)}

					<div>
						<Button
							className="w-full"
							disabled={missingRequired || isConnecting}
							onClick={authenticate}
						>
							{method === "api_key" ? (
								<LuKeyRound className="size-4" />
							) : (
								<LuGlobe className="size-4" />
							)}
							<Trans id="dashboard.plugins.detail.authenticateAccount">
								Authenticate your {displayName} account
							</Trans>
						</Button>
					</div>

					{connectError && (
						<p className="mt-3 text-xs text-destructive">
							{errorMessage(connectError)}
						</p>
					)}
				</div>
			)}

			{connected && (
				<div className="pt-1">
					<Button
						variant="ghost"
						size="sm"
						className="-ml-2 text-muted-foreground"
						onClick={authenticate}
					>
						<LuPlus className="size-4" />
						<Trans id="dashboard.plugins.detail.connectAnother">
							Connect another account
						</Trans>
					</Button>
				</div>
			)}
		</section>
	);
}
