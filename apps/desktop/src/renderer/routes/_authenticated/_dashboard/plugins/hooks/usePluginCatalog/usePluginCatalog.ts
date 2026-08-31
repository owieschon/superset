import type {
	PluginCatalogEntry,
	PluginCategory,
} from "@superset/shared/plugins";
import { useQuery } from "@tanstack/react-query";
import { env } from "renderer/env.renderer";
import { useAuthToken } from "renderer/lib/auth-client";

export interface AuthInput {
	name: string;
	label?: string;
	placeholder?: string;
	description?: string;
	required?: boolean;
	secret?: boolean;
}

export interface PluginSkill {
	name: string;
	description: string;
}

export interface AuthMethod {
	type: "oauth2" | "api_key";
	label: string | null;
	inputs: AuthInput[];
}

export interface CatalogPlugin extends PluginCatalogEntry {
	marketplace: string;
	installed: boolean;
	enabled: boolean;
	accounts: string[];
	pluginSkills: PluginSkill[];
	homepage: string | null;
	author: string | null;
	license: string | null;
}

interface CatalogResponse {
	plugins: {
		name: string;
		version: string;
		description: string;
		marketplace: string;
		displayName: string;
		category: string;
		icon?: string;
		authMethods: {
			type: "oauth2" | "api_key";
			label: string | null;
			inputs: AuthInput[];
		}[];
		mcpUrl: string | null;
		installed: boolean;
		enabled: boolean;
		accounts: string[];
		skills: PluginSkill[];
		homepage: string | null;
		author: string | null;
		license: string | null;
	}[];
}

/**
 * The catalog comes from the account, not from disk: a plugin installed on
 * another machine shows as installed here, and the built-in marketplace is
 * compiled into the API response so the page is populated before anything has
 * been cloned.
 */
export function usePluginCatalog() {
	// Subscribed, not read once: the token resolves after first render, and a
	// query that fired without it would 401 and never retry — nothing in a
	// static key changes when auth arrives.
	const token = useAuthToken();

	const query = useQuery({
		queryKey: ["plugin-catalog"],
		enabled: Boolean(token),
		queryFn: async (): Promise<CatalogPlugin[]> => {
			const response = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/plugins`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(body.error ?? `Request failed (${response.status})`);
			}
			const { plugins } = (await response.json()) as CatalogResponse;

			return plugins.map((plugin) => ({
				name: plugin.name,
				version: plugin.version,
				description: plugin.description,
				interface: {
					displayName: plugin.displayName,
					category: plugin.category as PluginCategory,
				},
				mcpServers: plugin.mcpUrl
					? { [plugin.name]: { type: "http" as const, url: plugin.mcpUrl } }
					: {},
				auth: plugin.authMethods.length ? plugin.authMethods : undefined,
				skills: plugin.skills.map((skill) => skill.name),
				marketplace: plugin.marketplace,
				installed: plugin.installed,
				enabled: plugin.enabled,
				accounts: plugin.accounts,
				pluginSkills: plugin.skills,
				homepage: plugin.homepage,
				author: plugin.author,
				license: plugin.license,
			}));
		},
	});

	return {
		plugins: query.data ?? [],
		// A query waiting on the token is still loading, not empty.
		isLoading: query.isLoading || !token,
		error: query.error,
	};
}
