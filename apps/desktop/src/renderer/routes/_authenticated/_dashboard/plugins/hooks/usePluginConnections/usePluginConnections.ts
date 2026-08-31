import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { env } from "renderer/env.renderer";
import { getAuthToken, useAuthToken } from "renderer/lib/auth-client";

export interface PluginConnection {
	id: string;
	plugin: string;
	account: string | null;
	accountId: string;
	scopes: string[] | null;
	createdAt: string;
}

function authHeaders(): Record<string, string> {
	const token = getAuthToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
		...init,
		headers: { ...authHeaders(), ...(init?.headers ?? {}) },
	});
	const payload = (await response.json().catch(() => ({}))) as {
		error?: string;
	};
	if (!response.ok) {
		throw new Error(payload.error ?? `Request failed (${response.status})`);
	}
	return payload as T;
}

/**
 * Records the install against the caller's account. The local install writes
 * skills and agent config; this is what lets the proxy resolve the plugin's
 * manifest when an agent calls a tool, so both have to happen.
 */
export async function registerPluginInstall(
	pluginName: string,
): Promise<{ needsConnection: boolean }> {
	return await request<{ needsConnection: boolean }>(
		`/api/plugins/${pluginName}/install`,
		{ method: "POST" },
	);
}

/** Removes the install and disconnects anything authorized for the plugin. */
export async function registerPluginUninstall(
	pluginName: string,
): Promise<void> {
	await request(`/api/plugins/${pluginName}/install`, { method: "DELETE" });
}

export function usePluginConnections(pluginName: string) {
	const token = useAuthToken();
	const queryClient = useQueryClient();
	const queryKey = ["plugin-connections", pluginName];

	const connections = useQuery({
		queryKey,
		// Same reason as the catalog: without this the list fires before auth
		// resolves, 401s, and never retries.
		enabled: Boolean(token),
		queryFn: async () => {
			const { connections } = await request<{
				connections: PluginConnection[];
			}>(`/api/plugins/connections?plugin=${encodeURIComponent(pluginName)}`);
			return connections;
		},
	});

	const disconnect = useMutation({
		mutationFn: async (connectionId: string) => {
			await request(`/api/plugins/connections/${connectionId}`, {
				method: "DELETE",
			});
		},
		// The row disappears immediately; a failure restores it via the refetch
		// in onSettled rather than leaving stale state on screen.
		onMutate: async (connectionId) => {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<PluginConnection[]>(queryKey);
			queryClient.setQueryData<PluginConnection[]>(queryKey, (rows) =>
				(rows ?? []).filter((row) => row.id !== connectionId),
			);
			return { previous };
		},
		onError: (_error, _id, context) => {
			if (context?.previous)
				queryClient.setQueryData(queryKey, context.previous);
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey }),
	});

	/**
	 * api_key credentials POST with a JSON body: a secret in a query string
	 * lands in browser history and proxy logs. OAuth still needs a real browser
	 * navigation, and carries no secret, so it opens the redirect route.
	 */
	const connectApiKey = useMutation({
		mutationFn: async ({
			inputs,
			method,
		}: {
			inputs: Record<string, string>;
			method: string;
		}) =>
			await request<{ connectionId: string; account: string | null }>(
				`/api/plugins/${pluginName}/connect?method=${encodeURIComponent(method)}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(inputs),
				},
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey }),
	});

	const connectOAuth = (
		inputs: Record<string, string> = {},
		method = "oauth2",
	) => {
		const url = new URL(
			`${env.NEXT_PUBLIC_API_URL}/api/plugins/${pluginName}/connect`,
		);
		for (const [key, value] of Object.entries(inputs)) {
			url.searchParams.set(key, value);
		}
		url.searchParams.set("method", method);
		window.open(url.toString(), "_blank", "noopener,noreferrer");
	};

	return {
		connections: connections.data ?? [],
		isLoading: connections.isLoading,
		error: connections.error,
		refetch: connections.refetch,
		connectOAuth,
		connectApiKey: connectApiKey.mutate,
		isConnecting: connectApiKey.isPending,
		connectError: connectApiKey.error,
		disconnect: disconnect.mutate,
		isDisconnecting: disconnect.isPending,
	};
}
